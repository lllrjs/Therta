require('dotenv').config();
const { Client, LocalAuth, MessageMedia, Buttons } = require('whatsapp-web.js');
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
            "--no-zygote"
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

// ===== AUTO RESTART =====
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

    // ================= /PLAY =================
    if (comando.startsWith("/play")) {

        const query = message.body.replace("/play", "").trim();

        if (!query) {
            return message.reply("usa: /play artista - musica");
        }

        return message.reply(`🎧 baixando:\n${query}\n\n(placeholder)`);
    }

    // ================= LASTFM =================
    if (comando.startsWith("!fm")) {

        const args = comando.split(" ");
        const userId = (await message.getContact()).id._serialized;
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

        // ===== REGISTER =====
        if (args[1] === "registrar") {
            const u = args[2];
            if (!u) return message.reply("usa: !fm registrar user");

            lastfmUsers[userId] = u;
            salvarLastfm();
            return message.reply(`✅ registrado: ${u}`);
        }

        if (!username) {
            return message.reply("usa: !fm registrar user");
        }

        // ===== RECENTES =====
        if (args[1] === "recentes") {

            let quantidade = parseInt(args[2]) || 9;
            if (quantidade > 16) quantidade = 16;

            const data = await axios.get(
                `http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&limit=${quantidade}`
            );

            const tracks = data.data.recenttracks.track;

            let txt = "";

            tracks.forEach((t, i) => {
                txt += `${i + 1}. ${t.artist["#text"]} — ${t.album["#text"] || "sem album"}\n`;
            });

            return message.reply(`💿 recentes de ${username}\n\n${txt}`);
        }

        // ===== ALBUNS RECENTES =====
        if (args[1] === "albunsrecentes") {

            let limit = parseInt(args[2]) || 9;

            const data = await axios.get(
                `http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&limit=30`
            );

            const seen = new Set();
            const albums = [];

            for (const t of data.data.recenttracks.track) {

                const album = t.album?.["#text"];
                const artist = t.artist?.["#text"];

                if (!album || seen.has(album)) continue;

                seen.add(album);
                albums.push({ album, artist });

                if (albums.length >= limit) break;
            }

            let txt = "💿 álbuns recentes\n\n";

            albums.forEach((a, i) => {
                txt += `${i + 1}. ${a.artist} — ${a.album}\n`;
            });

            return message.reply(txt);
        }

        // ===== TOP TRACKS =====
        if (args[1] === "topmusicas") {

            const data = await axios.get(
                `http://ws.audioscrobbler.com/2.0/?method=user.gettoptracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=7day&limit=9`
            );

            let txt = "";

            data.data.toptracks.track.forEach((t, i) => {
                txt += `${i + 1}. ${t.artist.name} — ${t.name}\n`;
            });

            return message.reply(`🎶 top músicas de ${username}\n\n${txt}`);
        }

        // ===== TOP ALBUMS =====
        if (args[1] === "topalbuns") {

            const data = await axios.get(
                `http://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=7day&limit=9`
            );

            let txt = "";

            data.data.topalbums.album.forEach((a, i) => {
                txt += `${i + 1}. ${a.artist.name} — ${a.name}\n`;
            });

            return message.reply(`🎹 top álbuns de ${username}\n\n${txt}`);
        }

        // ===== WRAP =====
        if (args[1] === "wrap") {

            const data = await axios.get(
                `http://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=1month&limit=9`
            );

            const albums = data.data.topalbums.album;

            const imgs = [];

            for (const a of albums) {

                const img =
                    a.image?.[3]?.["#text"] ||
                    a.image?.[2]?.["#text"];

                const buf = await axios.get(img, { responseType: "arraybuffer" });
                imgs.push(Buffer.from(buf.data));
            }

            const size = 320;

            const base = sharp({
                create: {
                    width: 3 * size,
                    height: 3 * size,
                    channels: 3,
                    background: "#0a0a0a"
                }
            });

            const comp = [];

            imgs.forEach((img, i) => {
                comp.push({
                    input: img,
                    top: Math.floor(i / 3) * size,
                    left: (i % 3) * size
                });
            });

            const file = path.join(__dirname, "wrap.jpg");

            await base.composite(comp).jpeg().toFile(file);

            const media = MessageMedia.fromFilePath(file);

            return client.sendMessage(message.from, media, {
                caption: `🎧 ${username} — last.fm wrapped`
            });
        }

        // ===== NOW PLAYING (COM BOTÃO) =====
        const res = await axios.get(
            `http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&limit=1`
        );

        const t = res.data.recenttracks.track[0];

        const texto = t["@attr"]?.nowplaying
            ? `🎵 ${username} está ouvindo ${t.artist["#text"]} — ${t.name}`
            : `📀 última música de ${username}: ${t.artist["#text"]} — ${t.name}`;

        const playCommand = `/play ${t.artist["#text"]} - ${t.name}`;

        try {

            const button = new Buttons(
                `${texto}\n\n📥 quer baixar essa música?`,
                [{ body: "baixar música 🎧" }],
                "last.fm",
                "clique abaixo"
            );

            return client.sendMessage(message.from, button);

        } catch {

            return message.reply(`${texto}\n\n📥 ${playCommand}`);
        }
    }

});

client.initialize();
