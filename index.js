require('dotenv').config();

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

const fs = require('fs');
const express = require('express');
const { translate } = require('google-translate-api-x');

const {
    Client,
    GatewayIntentBits,
    Partials,
    WebhookClient
} = require('discord.js');

const MAX_DB_SIZE = 2000;
const translationCache = new Map();

setInterval(() => {
    const mem = process.memoryUsage();
    console.log(
        `[RAM] Heap Usado: ${Math.round(mem.heapUsed / 1024 / 1024)} MB`
    );
}, 60000);

setInterval(() => {
    translationCache.clear();
}, 1000 * 60 * 30);

/* =======================================================
   CONFIG
======================================================= */

const PORT = process.env.PORT || 8080;

let CHANNELS = {};
try {
    CHANNELS = JSON.parse(fs.readFileSync('./channels.json', 'utf8'));
    console.log('========================');
    console.log('CHANNELS CARREGADOS');
    console.log(CHANNELS);
    console.log('========================');
} catch (err) {
    console.error('[ERRO] Falha ao ler channels.json:', err.message);
    process.exit(1);
}

const MESSAGE_DB = './messages.json';

/* =======================================================
   EXPRESS
======================================================= */

const app = express();

app.get('/', (req, res) => {
    res.send('Translator Bot Online (Google Translate)');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('========================');
    console.log('SERVIDOR WEB ONLINE');
    console.log(`PORTA ${PORT}`);
    console.log('========================');
});

/* =======================================================
   DISCORD CLIENT
======================================================= */

const client = new Client({
    rest: {
        timeout: 30000
    },
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [
        Partials.Message,
        Partials.Channel
    ]
});

/* =======================================================
   DATABASE
======================================================= */

let messageDB = {};

if (fs.existsSync(MESSAGE_DB)) {
    try {
        messageDB = JSON.parse(fs.readFileSync(MESSAGE_DB, 'utf8'));
    } catch {
        messageDB = {};
    }
}

function saveDB() {
    try {
        fs.writeFileSync(MESSAGE_DB, JSON.stringify(messageDB, null, 2));
    } catch (err) {
        console.error('[DB ERROR] Falha ao salvar banco de dados:', err);
    }
}

/* =======================================================
   AUTO CLEAN DATABASE
======================================================= */

setInterval(() => {
    try {
        const keys = Object.keys(messageDB);
        if (keys.length > MAX_DB_SIZE) {
            console.log('[LIMPEZA] messages.json');
            const remove = keys.slice(0, 1000);
            for (const key of remove) {
                delete messageDB[key];
            }
            saveDB();
        }
    } catch (err) {
        console.error(err);
    }
}, 1000 * 60 * 10);

/* =======================================================
   HELPERS
======================================================= */

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendWithRetry(webhook, payload) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            return await webhook.send(payload);
        } catch (err) {
            console.log(`[WEBHOOK RETRY ${attempt}]`);
            console.log(err.message);
            await wait(attempt * 1000);
        }
    }
    console.log('[WEBHOOK FAILED AFTER 3 ATTEMPTS]');
    return null;
}

async function sendLongMessage(webhook, payload) {
    const content = payload.content || '';

    if (content.length <= 2000) {
        const msg = await sendWithRetry(webhook, payload);
        return msg ? [msg] : [];
    }

    const messages = [];
    for (let i = 0; i < content.length; i += 1900) {
        const chunk = content.slice(i, i + 1900);
        const msg = await sendWithRetry(webhook, {
            ...payload,
            content: chunk,
            files: i === 0 ? payload.files : []
        });

        if (msg) {
            messages.push(msg);
        }
        await wait(250);
    }

    return messages;
}

/* =======================================================
   TRANSLATE (GOOGLE TRANSLATE)
======================================================= */

async function translateText(text, targetLang) {
    if (!text || !text.trim()) {
        return '';
    }

    const cacheKey = `${targetLang}:${text}`;
    if (translationCache.has(cacheKey)) {
        return translationCache.get(cacheKey);
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            // O Google Translate espera códigos como 'en', 'es', 'pt', etc.
            const res = await translate(text, { 
                to: targetLang, 
                client: 'gtx' // Melhora a estabilidade e evita bloqueios rápidos 
            });

            if (res && res.text) {
                translationCache.set(cacheKey, res.text);
                return res.text;
            }
        } catch (err) {
            console.log(`[TRANSLATE RETRY ${attempt}]`, err.message);
            await wait(attempt * 1000);
        }
    }

    return text;
}

/* =======================================================
   WEBHOOK CACHE
======================================================= */

const webhookCache = new Map();

async function getWebhook(channel) {
    try {
        if (webhookCache.has(channel.id)) {
            return webhookCache.get(channel.id);
        }

        const hooks = await channel.fetchWebhooks();
        let hook = hooks.find(h => h.name === 'TranslatorBot');

        if (!hook) {
            hook = await channel.createWebhook({
                name: 'TranslatorBot'
            });
        }

        const webhook = new WebhookClient({
            id: hook.id,
            token: hook.token
        });

        if (webhookCache.size >= 20) {
            const firstKey = webhookCache.keys().next().value;
            webhookCache.delete(firstKey);
        }

        webhookCache.set(channel.id, webhook);
        return webhook;
    } catch (err) {
        console.log('[WEBHOOK ERROR]');
        console.log(err);
        return null;
    }
}

/* =======================================================
   READY
======================================================= */

client.once('ready', () => {
    console.log('========================');
    console.log('BOT ONLINE');
    console.log(client.user.tag);
    console.log('========================');
});

/* =======================================================
   MESSAGE CREATE
======================================================= */

client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot && !message.system) return;
        if (!CHANNELS[message.channel.id]) return;

        let contentToTranslate = message.content || '';
        if (!contentToTranslate && message.embeds.length > 0) {
            contentToTranslate = message.embeds[0].description || message.embeds[0].title || '';
        }

        if (!contentToTranslate && message.messageSnapshots && message.messageSnapshots.size > 0) {
            const snapshot = message.messageSnapshots.first();
            contentToTranslate = snapshot.content || '';
            if (!contentToTranslate && snapshot.embeds && snapshot.embeds.length > 0) {
                contentToTranslate = snapshot.embeds[0].description || snapshot.embeds[0].title || '';
            }
        }

        const files = [];
        for (const attachment of message.attachments.values()) {
            files.push(attachment.url);
        }
        if (message.messageSnapshots && message.messageSnapshots.size > 0) {
            const snapshot = message.messageSnapshots.first();
            if (snapshot.attachments) {
                for (const attachment of snapshot.attachments.values()) {
                    files.push(attachment.url);
                }
            }
        }

        if (!contentToTranslate && files.length === 0) return;

        console.log(`[MSG] ${message.author.username}`);

        if (!messageDB[message.id]) {
            messageDB[message.id] = {};
        }

        for (const [targetChannelId, targetLang] of Object.entries(CHANNELS)) {
            try {
                if (targetChannelId === message.channel.id) continue;

                const targetChannel = await client.channels.fetch(targetChannelId);
                if (!targetChannel) continue;

                let translatedText = contentToTranslate;
                if (contentToTranslate) {
                    translatedText = await translateText(contentToTranslate, targetLang);
                }

                const webhook = await getWebhook(targetChannel);
                if (!webhook) {
                    console.log(`[WEBHOOK FAIL] ${targetChannelId}`);
                    continue;
                }

                const sentMessages = await sendLongMessage(webhook, {
                    content: (translatedText || ' ') + (message.messageSnapshots?.size > 0 ? '\n\n*↪ [Mensagem Encaminhada]*' : ''),
                    username: message.member?.displayName || message.author.username,
                    avatarURL: message.author.displayAvatarURL(),
                    files,
                    allowedMentions: { parse: [] }
                });

                if (!sentMessages || sentMessages.length === 0) {
                    console.log(`[ERRO] envio falhou para ${targetChannelId}`);
                    continue;
                }

                messageDB[message.id][targetChannelId] = sentMessages.map(msg => msg.id);
                saveDB();

                await wait(150);

            } catch (err) {
                console.log(`[CHANNEL ERROR] ${targetChannelId}`);
                console.log(err);
            }
        }

    } catch (err) {
        console.log('[MESSAGE ERROR]');
        console.log(err);
    }
});

/* =======================================================
   MESSAGE UPDATE
======================================================= */

client.on('messageUpdate', async (oldMessage, newMessage) => {
    try {
        if (newMessage.author?.bot) return;

        const translations = messageDB[newMessage.id];
        if (!translations) return;

        let contentToTranslate = newMessage.content || '';
        if (!contentToTranslate && newMessage.embeds.length > 0) {
            contentToTranslate = newMessage.embeds[0].description || newMessage.embeds[0].title || '';
        }

        for (const [targetChannelId, translatedMessageIds] of Object.entries(translations)) {
            try {
                const targetChannel = await client.channels.fetch(targetChannelId);
                if (!targetChannel) continue;

                const targetLang = CHANNELS[targetChannelId];
                if (!targetLang) continue;

                const translatedText = await translateText(contentToTranslate, targetLang);
                const idsToEdit = Array.isArray(translatedMessageIds) ? translatedMessageIds : [translatedMessageIds];

                const webhook = await getWebhook(targetChannel);
                if (webhook && idsToEdit.length > 0) {
                    await webhook.editMessage(idsToEdit[0], {
                        content: translatedText.slice(0, 2000) || ' '
                    });
                    await wait(500);
                }

            } catch (err) {
                console.log('[UPDATE FAIL]');
                console.log(err);
            }
        }
    } catch (err) {
        console.log('[UPDATE ERROR]');
        console.log(err);
    }
});

/* =======================================================
   MESSAGE DELETE
======================================================= */

client.on('messageDelete', async (message) => {
    try {
        const translations = messageDB[message.id];
        if (!translations) return;

        for (const [targetChannelId, translatedMessageIds] of Object.entries(translations)) {
            try {
                const targetChannel = await client.channels.fetch(targetChannelId);
                if (!targetChannel) continue;

                const idsToDelete = Array.isArray(translatedMessageIds) ? translatedMessageIds : [translatedMessageIds];
                const webhook = await getWebhook(targetChannel);

                if (webhook) {
                    for (const msgId of idsToDelete) {
                        try {
                            await webhook.deleteMessage(msgId);
                            await wait(250);
                        } catch (err) {
                            console.log('[WEBHOOK DELETE FAIL]', err.message);
                        }
                    }
                }
            } catch (err) {
                console.log('[DELETE FAIL]');
                console.log(err);
            }
        }

        delete messageDB[message.id];
        saveDB();

    } catch (err) {
        console.log('[DELETE ERROR]');
        console.log(err);
    }
});

/* =======================================================
   LOGIN
======================================================= */

client.login(process.env.DISCORD_TOKEN);
