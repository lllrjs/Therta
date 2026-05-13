require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');
const fs = require('fs');
const axios = require('axios');
const sharp = require('sharp');
const path = require('path');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: "/snap/bin/chromium",
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--disable-extensions",
            "--disable-gpu",
            "--single-process",
            "--no-zygote",
        ]
    }
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// ===== ESTADOS =====
let botId = null;
let caosAtivo = false;
let botAtivo = true;

let processando = new Set();
let ultimaAtividade = Date.now();

// ===== FM REAÇÃO MAP =====
let lastMusicMessage = {};

// ===== MEMÓRIA =====
let memoria = {};
let memoriaGrupos = {};
let lastfmUsers = {};

if (fs.existsSync('memoria.json')) {
    memoria = JSON.parse(fs.readFileSync('memoria.json'));
}

if (fs.existsSync('lastfm.json')) {
    lastfmUsers = JSON.parse(fs.readFileSync('lastfm.json'));
}

function salvarMemoria() {
    fs.writeFileSync('memoria.json', JSON.stringify(memoria, null, 2));
}

function salvarLastfm() {
    fs.writeFileSync('lastfm.json', JSON.stringify(lastfmUsers, null, 2));
}

// ===== COLAGEM DE ÁLBUNS =====
async function gerarColagem(imagens, outputPath = "colagem.jpg") {
    const size = 300;
    const cols = Math.ceil(Math.sqrt(imagens.length));
    const rows = Math.ceil(imagens.length / cols);

    const base = sharp({
        create: {
            width: cols * size,
            height: rows * size,
            channels: 3,
            background: "#111"
        }
    });

    const composites = [];

    for (let i = 0; i < imagens.length; i++) {
        const img = await sharp(imagens[i])
            .resize(size, size)
            .toBuffer();

        composites.push({
            input: img,
            left: (i % cols) * size,
            top: Math.floor(i / cols) * size
        });
    }

    await base.composite(composites).jpeg().toFile(outputPath);

    return outputPath;
}

// ===== QR =====
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
});

// ===== READY =====
client.on('ready', () => {
    console.log('🔥 bot on');
    botId = client.info.wid._serialized;
});

// ===== REAÇÃO → /play (FIXADO) =====
client.on('message_reaction', async (reaction) => {
    try {
        const msgId = reaction.msgId._serialized;
        const music = lastMusicMessage[msgId];

        if (!music) return;

        // AGORA ENVIA COMO MENSAGEM NORMAL
        await client.sendMessage(reaction.msgId.remote, `/play ${music}`);

        delete lastMusicMessage[msgId];

    } catch {}
});

// ===== ADMIN =====
async function isAdmin(message) {
    const chat = await message.getChat();

    if (!chat.isGroup) return true;

    const contact = await message.getContact();
    const authorId = contact.id._serialized;

    const participant = chat.participants.find(
        p => p.id._serialized === authorId
    );

    return participant?.isAdmin || participant?.isSuperAdmin;
}

// ===== MESSAGE =====
client.on('message', async message => {

    ultimaAtividade = Date.now();

    if (message.fromMe) return;

    const contact = await message.getContact();
    const userId = contact.id._serialized;

    if (processando.has(userId)) return;

    processando.add(userId);
    setTimeout(() => processando.delete(userId), 2000);

    const isGroup = message.from.endsWith('@g.us');
    const userName = contact.pushname || contact.name || "desconhecido";
    const chatId = message.from;

    // ===== MEMÓRIA =====
    if (!memoria[userId]) {
        memoria[userId] = {
            nome: userName,
            interacoes: 0,
            notas: []
        };
    }

    memoria[userId].interacoes++;

    if (!memoriaGrupos[chatId]) {
        memoriaGrupos[chatId] = [];
    }

    memoriaGrupos[chatId].push({
        role: "user",
        content: `${userName}: ${message.body.slice(0, 100)}`
    });

    if (memoriaGrupos[chatId].length > 7) {
        memoriaGrupos[chatId].shift();
    }

    const comando = message.body.toLowerCase().trim();

    // =========================
    // FM ALBUNS RECENTES (COM COLAGEM)
    // =========================
    if (comando.startsWith("!fm albunsrecentes")) {
        try {
            const qtd = parseInt(comando.split(" ")[2]) || 5;

            const url = `http://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${lastfmUsers[userId]}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=7day&limit=${qtd}`;

            const { data } = await axios.get(url);
            const albums = data.topalbums.album;

            let txt = "💿 albuns recentes:\n\n";

            const imagens = [];

            for (let i = 0; i < albums.length; i++) {
                const a = albums[i];

                txt += `${i+1}. ${a.artist.name} - ${a.name}\n`;

                const img =
                    a.image?.[3]?.["#text"] ||
                    a.image?.[2]?.["#text"];

                if (img) {
                    const buffer = await axios.get(img, { responseType: "arraybuffer" });
                    imagens.push(Buffer.from(buffer.data));
                }
            }

            if (imagens.length > 0) {
                const file = await gerarColagem(imagens);
                const media = MessageMedia.fromFilePath(file);

                return client.sendMessage(chatId, media, {
                    caption: txt
                });
            }

            return message.reply(txt);

        } catch {
            return message.reply("erro albuns 😶");
        }
    }

    // =========================
    // FM TOP ALBUNS (COM COLAGEM)
    // =========================
    if (comando === "!fm topalbuns") {
        try {
            const url = `http://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${lastfmUsers[userId]}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=7day&limit=10`;

            const { data } = await axios.get(url);

            let txt = "💿 top albuns:\n\n";

            const imagens = [];

            data.topalbums.album.forEach((a, i) => {
                txt += `${i+1}. ${a.artist.name} - ${a.name}\n`;

                const img =
                    a.image?.[3]?.["#text"] ||
                    a.image?.[2]?.["#text"];

                if (img) imagens.push(img);
            });

            if (imagens.length > 0) {
                const buffers = [];

                for (const img of imagens) {
                    const r = await axios.get(img, { responseType: "arraybuffer" });
                    buffers.push(Buffer.from(r.data));
                }

                const file = await gerarColagem(buffers);
                const media = MessageMedia.fromFilePath(file);

                return client.sendMessage(chatId, media, { caption: txt });
            }

            return message.reply(txt);

        } catch {
            return message.reply("erro albuns top 😶");
        }
    }

    // =========================
    // FM ATUAL
    // =========================
    if (comando === "!fm") {
        try {
            const url = `http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${lastfmUsers[userId]}&api_key=${process.env.LASTFM_API_KEY}&format=json&limit=1`;

            const { data } = await axios.get(url);
            const track = data.recenttracks.track[0];

            const musica = track.name;
            const artista = track.artist["#text"];

            const texto = `🎵 ${artista} — ${musica}`;

            lastMusicMessage[message.id._serialized] = `${artista} - ${musica}`;

            const capa =
                track.image?.[3]?.["#text"] ||
                track.image?.[2]?.["#text"];

            if (capa) {
                const media = await MessageMedia.fromUrl(capa);
                return client.sendMessage(chatId, media, { caption: texto });
            }

            return message.reply(texto);

        } catch {
            return message.reply("erro fm 😶");
        }
    }

});

client.initialize();
