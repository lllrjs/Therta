require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');
const fs = require('fs');
const axios = require('axios');
const sharp = require('sharp');
const path = require('path');

async function gerarColagem(buffers, output = "colagem.jpg") {
    const size = 300;
    const gap = 20;

    const cols = Math.ceil(Math.sqrt(buffers.length));
    const rows = Math.ceil(buffers.length / cols);

    const width = cols * size + (cols - 1) * gap;
    const height = rows * size + (rows - 1) * gap;

    const base = sharp({
        create: {
            width,
            height,
            channels: 3,
            background: "#1db954"
        }
    });

    const layers = [];

    for (let i = 0; i < buffers.length; i++) {

        const img = await sharp(buffers[i])
            .resize(size, size)
            .jpeg()
            .toBuffer();

        const col = i % cols;
        const row = Math.floor(i / cols);

        layers.push({
            input: img,
            left: col * (size + gap),
            top: row * (size + gap)
        });
    }

    await base
        .composite(layers)
        .jpeg({ quality: 90 })
        .toFile(output);

    return output;
}

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

// ===== QR =====
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
});

// ===== READY =====
client.on('ready', () => {
    console.log('🔥 bot on');
    botId = client.info.wid._serialized;
});

// ===== REAÇÃO → /play =====
client.on('message_reaction', async (reaction) => {
    try {
        const msgId = reaction.msgId._serialized;
        const music = lastMusicMessage[msgId];

        if (!music) return;

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
    // FM HELP
    // =========================
    if (comando === "!fm help") {
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

    // =========================
    // FM REGISTRAR
    // =========================
    if (comando.startsWith("!fm registrar")) {

        const username = comando.split(" ")[2];

        if (!username) {
            processando.delete(userId);
            return message.reply("usa: !fm registrar usuario");
        }

        lastfmUsers[userId] = username;
        salvarLastfm();

        processando.delete(userId);
        return message.reply(`✅ lastfm registrado como ${username}`);
    }

    const username = lastfmUsers[userId];

    if (comando.startsWith("!fm") && !username) {
        processando.delete(userId);
        return message.reply("vc n registrou seu lastfm ainda 😶");
    }

    // =========================
    // FM RECENTES
    // =========================
    if (comando.startsWith("!fm recentes")) {
        try {
            const qtd = parseInt(comando.split(" ")[2]) || 5;

            const url = `http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&limit=${qtd}`;

            const { data } = await axios.get(url);

            const tracks = data.recenttracks.track;

            let txt = "🎧 recentes:\n\n";

            tracks.forEach((t, i) => {
                txt += `${i+1}. ${t.artist["#text"]} - ${t.name}\n`;
            });

            async function gerarColagem(buffers, output = "colagem.jpg") {
    const size = 300;

    const cols = Math.ceil(Math.sqrt(buffers.length));
    const rows = Math.ceil(buffers.length / cols);

    const base = sharp({
        create: {
            width: cols * size,
            height: rows * size,
            channels: 3,
            background: "#111"
        }
    });

    const layers = [];

    for (let i = 0; i < buffers.length; i++) {
        const img = await sharp(buffers[i])
            .resize(size, size)
            .toBuffer();

        layers.push({
            input: img,
            left: (i % cols) * size,
            top: Math.floor(i / cols) * size
        });
    }

    await base.composite(layers).jpeg().toFile(output);

    return output;
            }

            return message.reply(txt);

        } catch {
            return message.reply("erro recentes 😶");
        }
    }

    // =========================
    // FM ALBUNS RECENTES
    // =========================
    if (comando.startsWith("!fm albunsrecentes")) {
    try {
        const qtd = parseInt(comando.split(" ")[2]) || 5;

        const url = `http://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=7day&limit=${qtd}`;

        const { data } = await axios.get(url);

        const albums = data.topalbums.album;

        let txt = "💿 albuns recentes:\n\n";

        albums.forEach((a, i) => {
            txt += `${i + 1}. ${a.artist.name} - ${a.name}\n`;
        });

        // ===== COLAGEM =====
        const imagens = [];

        for (const a of albums) {
            const img =
                a.image?.[3]?.["#text"] ||
                a.image?.[2]?.["#text"];

            if (img) imagens.push(img);
        }

        if (imagens.length === 0) {
            return message.reply(txt);
        }

        const buffers = [];

        for (const url of imagens) {
            try {
                const res = await axios.get(url, { responseType: "arraybuffer" });
                buffers.push(Buffer.from(res.data));
            } catch {}
        }

        if (buffers.length === 0) {
            return message.reply(txt);
        }

        const file = await gerarColagem(buffers);
        const media = MessageMedia.fromFilePath(file);

        return client.sendMessage(chatId, media, {
            caption: txt
        });

    } catch {
        return message.reply("erro albuns 😶");
    }
    }
    }

    // =========================
    // FM TOP MUSICAS
    // =========================
    if (comando === "!fm topmusicas") {
    try {
        const url = `http://ws.audioscrobbler.com/2.0/?method=user.gettoptracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=7day&limit=10`;

        const { data } = await axios.get(url);

        let txt = "🔥 top musicas:\n\n";

        const tracks = data.toptracks.track;

        tracks.forEach((t, i) => {
            txt += `${i + 1}. ${t.artist.name} - ${t.name}\n`;
        });

        // ===== COLAGEM =====
        const imagens = [];

        for (const t of tracks) {
            const img =
                t.image?.[3]?.["#text"] ||
                t.image?.[2]?.["#text"];

            if (img) imagens.push(img);
        }

        if (imagens.length === 0) {
            return message.reply(txt);
        }

        const buffers = [];

        for (const url of imagens) {
            try {
                const res = await axios.get(url, { responseType: "arraybuffer" });
                buffers.push(Buffer.from(res.data));
            } catch {}
        }

        if (buffers.length === 0) {
            return message.reply(txt);
        }

        const file = await gerarColagem(buffers);
        const media = MessageMedia.fromFilePath(file);

        return client.sendMessage(chatId, media, {
            caption: txt
        });

    } catch {
        return message.reply("erro top 😶");
    }
}
    }

    // =========================
    // FM TOP ALBUNS
    // =========================
    if (comando === "!fm topalbuns") {
    if (comando === "!fm topalbuns") {
    try {
        const url = `http://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=7day&limit=10`;

        const { data } = await axios.get(url);

        const albums = data.topalbums.album;

        let txt = "💿 top albuns:\n\n";

        albums.forEach((a, i) => {
            txt += `${i + 1}. ${a.artist.name} - ${a.name}\n`;
        });

        // ===== COLAGEM =====
        const imagens = [];

        for (const a of albums) {
            const img =
                a.image?.[3]?.["#text"] ||
                a.image?.[2]?.["#text"];

            if (img) imagens.push(img);
        }

        if (imagens.length === 0) {
            return message.reply(txt);
        }

        const buffers = [];

        for (const url of imagens) {
            try {
                const res = await axios.get(url, { responseType: "arraybuffer" });
                buffers.push(Buffer.from(res.data));
            } catch {}
        }

        if (buffers.length === 0) {
            return message.reply(txt);
        }

        const file = await gerarColagem(buffers);
        const media = MessageMedia.fromFilePath(file);

        return client.sendMessage(chatId, media, {
            caption: txt
        });

    } catch {
        return message.reply("erro albuns top 😶");
    }
    }

    // =========================
    // FM WRAP
    // =========================
    if (comando === "!fm wrap") {
    if (comando === "!fm wrap") {
    try {
        const url = `http://ws.audioscrobbler.com/2.0/?method=user.gettopartists&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=1month&limit=9`;

        const { data } = await axios.get(url);

        let txt = "📊 wrap do mês:\n\n";

        data.topartists.artist.forEach((a, i) => {
            txt += `${i + 1}. ${a.name}\n`;
        });

        // ===== COLAGEM DE IMAGENS =====
        const imagens = [];

        for (const a of data.topartists.artist) {
            const img =
                a.image?.[3]?.["#text"] ||
                a.image?.[2]?.["#text"];

            if (img) imagens.push(img);
        }

        if (imagens.length === 0) {
            return message.reply(txt);
        }

        const buffers = [];

        for (const url of imagens) {
            try {
                const res = await axios.get(url, {
                    responseType: "arraybuffer"
                });

                buffers.push(Buffer.from(res.data));
            } catch {}
        }

        if (buffers.length === 0) {
            return message.reply(txt);
        }

        const file = await gerarColagem(buffers);
        const media = MessageMedia.fromFilePath(file);

        return client.sendMessage(chatId, media, {
            caption: txt
        });

    } catch {
        return message.reply("erro wrap 😶");
    }
    }

    // =========================
// FM ATUAL + CAPA DO ÁLBUM
// =========================
if (comando === "!fm") {
    try {
        const url = `http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&limit=1`;

        const { data } = await axios.get(url);
        const track = data.recenttracks.track[0];

        if (!track) {
            return message.reply("n achei música atual 😶");
        }

        const musica = track.name;
        const artista = track.artist["#text"];

        const texto =
`🎵 ${username} está ouvindo
${artista} — ${musica}

Reaja a essa mensagem para baixar a música`;

        // salva pra reação continuar funcionando
        lastMusicMessage[message.id._serialized] = `${artista} - ${musica}`;

        // pega capa do álbum
        const capa =
            track.image?.[3]?.["#text"] ||
            track.image?.[2]?.["#text"];

        // se tiver imagem, envia com foto
        if (capa) {
            try {
                const media = await MessageMedia.fromUrl(capa);
                return client.sendMessage(message.from, media, {
                    caption: texto
                });
            } catch {
                return message.reply(texto);
            }
        }

        // fallback sem imagem
        return message.reply(texto);

    } catch (err) {
        console.log(err);
        return message.reply("erro fm 😶");
    }
}

    // ===== BOT SYSTEM =====
    if (!botAtivo) return;

    if (isGroup) {
        const mentions = await message.getMentions();
        const mentioned = mentions?.some(u => u.id._serialized === botId);

        if (!mentioned && !message.body.toLowerCase().includes("phainonbot")) {
            processando.delete(userId);
            return;
        }
    }

    const info = memoria[userId];

    const personalidade = `
vc é Phainon Bot, arrogante e debochado, se acha bastante
fala igual brasileiro no zap, usa abreviações (pq, slk, mano, vsf), apenas letras minúsculas
respostas curtas (2 linhas)
zoa e xinga bastante, provoca pessoas
ama A Herta (n° 83 da sociedade dos gênios, do jogo honkai star rail), odeia taylor swift e o dottore
não explica seu estilo
usa o nome das pessoas às vezes

modo caos: ${caosAtivo ? "ligado" : "desligado"}

${caosAtivo ? `
MODO CAOS ATIVO:
- agressividade máxima
- xingamentos pesados
- comportamento imprevisível
` : `
MODO CAOS DESLIGADO:
- sarcasmo leve
- "amigavel" num nível sarcástico, ainda tira sarro de você 
`}

contexto:
Nome: ${info.nome}
Interações: ${info.interacoes}
Notas: ${info.notas.join(", ") || "nenhuma"}
`;

    try {
        const response = await openai.responses.create({
            model: "gpt-4.1-mini",
            input: [
                { role: "system", content: personalidade },
                ...(memoriaGrupos[chatId] || [])
            ]
        });

        await message.reply(response.output_text || "buguei 😶");

    } catch {
        await message.reply("buguei feio 😶");
    }

    processando.delete(userId);
});

// ===== WATCHDOG =====
setInterval(() => {
    if (Date.now() - ultimaAtividade > 5 * 60 * 1000) {
        process.exit(1);
    }
}, 60000);

client.initialize();
