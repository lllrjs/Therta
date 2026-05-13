require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');
const fs = require('fs');
const axios = require('axios');
const sharp = require('sharp');
const path = require('path');

// ================= ADICIONADO (proteção global) =================
process.on('unhandledRejection', console.log);
process.on('uncaughtException', console.log);

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

// ================= ADICIONADO (Buttons seguro) =================
let Buttons = null;
try {
    Buttons = require('whatsapp-web.js').Buttons;
} catch (e) {
    Buttons = null;
}

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// ===== ESTADOS =====
let botId = null;
let caosAtivo = false;
let botAtivo = true;

let processando = new Set();
let ultimaAtividade = Date.now();

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

// ===== QR =====
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
});

// ===== READY =====
client.on('ready', () => {
    console.log('🔥 bot on');
    botId = client.info.wid._serialized;
});

// 🔥 AUTO-RESTART EVENTS
client.on('disconnected', (reason) => {
    console.log("❌ desconectado:", reason);
    process.exit(1);
});

client.on('auth_failure', msg => {
    console.log("❌ falha de auth:", msg);
    process.exit(1);
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

    // ================= ADICIONADO (anti-crash input vazio) =================
    if (!message || !message.body) return;

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

    // ================= ADICIONADO (/play fallback global seguro) =================
    if (comando.startsWith("/play")) {
        const query = message.body.replace("/play", "").trim();
        if (!query) return message.reply("usa: /play artista - musica");
        return message.reply(`🎧 baixando:\n${query}`);
    }

    // ===== LAST FM =====
    if (comando.startsWith("!lf")) {

        const args = comando.split(" ");

        if (args[1] === "registrar") {

            const username = args[2];

            if (!username) {
                processando.delete(userId);
                return message.reply("usa: !lf registrar usuario");
            }

            lastfmUsers[userId] = username;
            salvarLastfm();

            processando.delete(userId);
            return message.reply(`✅ lastfm registrado como ${username}`);
        }

        const username = lastfmUsers[userId];

        if (!username) {
            processando.delete(userId);
            return message.reply(
                "vc n registrou seu lastfm ainda 😶\nusa: !lf registrar usuario"
            );
        }

        // ===== RECENTES =====
        if (args[1] === "recentes") {

            let quantidade = parseInt(args[2]) || 9;
            if (quantidade > 16) quantidade = 16;
            if (quantidade < 1) quantidade = 1;

            try {

                const url =
                    `http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&limit=${quantidade}`;

                const { data } = await axios.get(url);

                const tracks = data.recenttracks.track;

                if (!tracks || tracks.length === 0) {
                    processando.delete(userId);
                    return message.reply("n achei musicas recentes 😶");
                }

                const capas = [];
                let legenda = "";

                for (let i = 0; i < tracks.length; i++) {

                    const track = tracks[i];

                    const artista = track.artist["#text"];
                    const album = track.album["#text"] || "sem album";

                    legenda += `${i + 1}. ${artista} — ${album}\n`;

                    const capa =
                        track.image?.[3]?.["#text"] ||
                        track.image?.[2]?.["#text"];

                    if (capa) {
                        try {
                            const response = await axios.get(capa, {
                                responseType: "arraybuffer"
                            });

                            capas.push(Buffer.from(response.data));
                        } catch {}
                    }
                }

                if (capas.length === 0) {
                    processando.delete(userId);
                    return message.reply(legenda);
                }

                const tamanho = 300;
                const cols = Math.ceil(Math.sqrt(capas.length));
                const rows = Math.ceil(capas.length / cols);

                const canvas = sharp({
                    create: {
                        width: cols * tamanho,
                        height: rows * tamanho,
                        channels: 3,
                        background: "#111"
                    }
                });

                const composites = [];

                for (let i = 0; i < capas.length; i++) {

                    const img = await sharp(capas[i])
                        .resize(tamanho, tamanho)
                        .toBuffer();

                    const x = (i % cols) * tamanho;
                    const y = Math.floor(i / cols) * tamanho;

                    composites.push({
                        input: img,
                        top: y,
                        left: x
                    });
                }

                const output = path.join(__dirname, "recentes.jpg");

                await canvas.composite(composites).jpeg().toFile(output);

                const media = MessageMedia.fromFilePath(output);

                processando.delete(userId);

                // ================= ADICIONADO (botão seguro no recent track) =================
                const playText = `/play ${tracks[0].artist["#text"]} - ${tracks[0].name}`;

                if (Buttons) {
                    try {
                        const btn = new Buttons(
                            `quer baixar essa música?\n\n${legenda}`,
                            [{ body: playText }],
                            "Last.fm",
                            "clique abaixo"
                        );

                        return client.sendMessage(message.from, btn);
                    } catch {
                        return client.sendMessage(message.from, media, {
                            caption: `💿 ${legenda}\n\n📥 ${playText}`
                        });
                    }
                }

                return client.sendMessage(message.from, media, {
                    caption: `💿 ${legenda}\n\n📥 ${playText}`
                });

            } catch (err) {
                console.log(err);
                processando.delete(userId);
                return message.reply("deu ruim pegando recentes 😶");
            }
        }

        // ===== TOP MUSICAS =====
        if (args[1] === "topmusicas") {
            try {

                const url =
                    `http://ws.audioscrobbler.com/2.0/?method=user.gettoptracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=7day&limit=9`;

                const { data } = await axios.get(url);

                const tracks = data.toptracks.track;

                let legenda = "";

                for (let i = 0; i < tracks.length; i++) {
                    legenda += `${i + 1}. ${tracks[i].artist.name} — ${tracks[i].name}\n`;
                }

                processando.delete(userId);
                return message.reply(`🎶 ${legenda}`);

            } catch (err) {
                console.log(err);
                processando.delete(userId);
                return message.reply("erro top musicas");
            }
        }

        // ===== TOP ALBUNS =====
        if (args[1] === "topalbuns") {
            try {

                const url =
                    `http://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=7day&limit=9`;

                const { data } = await axios.get(url);

                const albums = data.topalbums.album;

                let legenda = "";

                for (let i = 0; i < albums.length; i++) {
                    legenda += `${i + 1}. ${albums[i].artist.name} — ${albums[i].name}\n`;
                }

                processando.delete(userId);
                return message.reply(`🎹 ${legenda}`);

            } catch (err) {
                console.log(err);
                processando.delete(userId);
                return message.reply("erro top albuns");
            }
        }

        // ===== NOW PLAYING =====
        try {

            const url =
                `http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&limit=1`;

            const { data } = await axios.get(url);

            const track = data.recenttracks.track[0];

            const musica = track.name;
            const artista = track.artist["#text"];

            const tocandoAgora = track["@attr"]?.nowplaying;

            const texto = tocandoAgora
                ? `🎵 ${username} ouvindo ${artista} — ${musica}`
                : `📀 última: ${artista} — ${musica}`;

            const playText = `/play ${artista} - ${musica}`;

            processando.delete(userId);

            // ================= ADICIONADO (botão agora tocando) =================
            if (Buttons) {
                try {
                    const btn = new Buttons(
                        `${texto}\n\nquer baixar?`,
                        [{ body: playText }],
                        "Last.fm",
                        "clique"
                    );

                    return client.sendMessage(message.from, btn);
                } catch {
                    return message.reply(`${texto}\n\n${playText}`);
                }
            }

            return message.reply(`${texto}\n\n${playText}`);

        } catch (err) {
            console.log(err);
            processando.delete(userId);
            return message.reply("erro lastfm");
        }
    }

    if (comando === "!ativar" && await isAdmin(message)) {
        botAtivo = true;
        return message.reply("bot on");
    }

    if (comando === "!desativar" && await isAdmin(message)) {
        botAtivo = false;
        return message.reply("bot off");
    }

    if (comando === "!caos" && await isAdmin(message)) {
        caosAtivo = !caosAtivo;
        return message.reply(`caos ${caosAtivo}`);
    }

    if (!botAtivo) return;

    // ===== CHAT GPT =====
    try {

        const response = await openai.responses.create({
            model: "gpt-4.1-mini",
            input: [{ role: "user", content: message.body }]
        });

        return message.reply(response.output_text);

    } catch (e) {
        console.log(e);
    }

    processando.delete(userId);
});

client.initialize();
