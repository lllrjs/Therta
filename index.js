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

// ===== REAÇÃO FM =====
const pendingDownloads = new Map();

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

// ===== REAÇÃO =====
client.on('message_reaction', async (reaction) => {
    try {

        const msgId = reaction.msgId?._serialized;
        if (!msgId) return;

        const data = pendingDownloads.get(msgId);
        if (!data) return;

        const chat = await client.getChatById(data.chatId);

        await chat.sendMessage(`/play ${data.music}`);

        pendingDownloads.delete(msgId);

    } catch (err) {
        console.log(err);
    }
});

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
    // 🔥 FM SYSTEM
    // =========================
    if (comando.startsWith("!fm")) {

        const args = comando.split(" ");
        const username = lastfmUsers[userId];

        // ===== HELP =====
        if (args[1] === "help") {
            processando.delete(userId);
            return message.reply(
`🎧 comandos !fm

!fm registrar <user>
!fm recentes <n>
!fm albunsrecentes <n>
!fm topmusicas
!fm topalbuns
!fm wrap
!fm help

💡 dica: !fm sem comando mostra a música atual`
            );
        }

        // ===== REGISTRAR =====
        if (args[1] === "registrar") {

            const user = args[2];

            if (!user) {
                processando.delete(userId);
                return message.reply("usa: !fm registrar <user>");
            }

            lastfmUsers[userId] = user;
            salvarLastfm();

            processando.delete(userId);
            return message.reply(`✅ lastfm registrado como ${user}`);
        }

        if (!username) {
            processando.delete(userId);
            return message.reply("vc n registrou seu lastfm ainda 😶 usa: !fm registrar <user>");
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

                let texto = "🎶 recentes:\n\n";

                tracks.forEach((t, i) => {
                    texto += `${i + 1}. ${t.artist["#text"]} - ${t.name}\n`;
                });

                processando.delete(userId);
                return message.reply(texto);

            } catch (err) {
                console.log(err);
                processando.delete(userId);
                return message.reply("erro ao buscar recentes 😶");
            }
        }

        // ===== TOP MUSICAS =====
        if (args[1] === "topmusicas") {

            try {

                const url =
                    `http://ws.audioscrobbler.com/2.0/?method=user.gettoptracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=7day&limit=9`;

                const { data } = await axios.get(url);

                const tracks = data.toptracks.track;

                let texto = "🔥 top músicas:\n\n";

                tracks.forEach((t, i) => {
                    texto += `${i + 1}. ${t.artist.name} - ${t.name}\n`;
                });

                processando.delete(userId);
                return message.reply(texto);

            } catch (err) {
                console.log(err);
                processando.delete(userId);
                return message.reply("erro topmusicas 😶");
            }
        }

        // ===== TOP ALBUNS =====
        if (args[1] === "topalbuns") {

            try {

                const url =
                    `http://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=7day&limit=9`;

                const { data } = await axios.get(url);

                const albums = data.topalbums.album;

                let texto = "💿 top álbuns:\n\n";

                albums.forEach((a, i) => {
                    texto += `${i + 1}. ${a.artist.name} - ${a.name}\n`;
                });

                processando.delete(userId);
                return message.reply(texto);

            } catch (err) {
                console.log(err);
                processando.delete(userId);
                return message.reply("erro topalbuns 😶");
            }
        }

        // ===== WRAP =====
        if (args[1] === "wrap") {

            try {

                const url =
                    `http://ws.audioscrobbler.com/2.0/?method=user.gettopartists&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=7day&limit=5`;

                const { data } = await axios.get(url);

                const artists = data.topartists.artist;

                let texto = `📊 wrap semanal de ${username}\n\n`;

                artists.forEach((a, i) => {
                    texto += `${i + 1}. ${a.name}\n`;
                });

                processando.delete(userId);
                return message.reply(texto);

            } catch (err) {
                console.log(err);
                processando.delete(userId);
                return message.reply("erro wrap 😶");
            }
        }

        // ===== NOW PLAYING =====
        try {

            const url =
                `http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&limit=1`;

            const { data } = await axios.get(url);

            const track = data.recenttracks.track[0];

            if (!track) {
                processando.delete(userId);
                return message.reply("n achei nada 😶");
            }

            const musica = track.name;
            const artista = track.artist["#text"];

            const tocandoAgora = track["@attr"]?.nowplaying;

            const texto = tocandoAgora
                ? `🎵 ${username} está ouvindo ${artista} - ${musica} agora\n\nreaja a essa mensagem para baixar`
                : `📀 última música de ${username}: ${artista} - ${musica}`;

            const sentMsg = await message.reply(texto);

            pendingDownloads.set(sentMsg.id._serialized, {
                chatId,
                music: `${artista} - ${musica}`
            });

        } catch (err) {
            console.log(err);
            message.reply("erro fm 😶");
        }

        processando.delete(userId);
        return;
    }

    // ===== CONTROLES =====
    if (comando === "!ativar" && await isAdmin(message)) {
        botAtivo = true;
        return message.reply("🤖 on");
    }

    if (comando === "!desativar" && await isAdmin(message)) {
        botAtivo = false;
        return message.reply("🤖 off");
    }

    if (!botAtivo) return;

});

client.initialize();
