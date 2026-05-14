import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason
} from '@whiskeysockets/baileys';

import P from 'pino';
import OpenAI from 'openai';
import axios from 'axios';
import fs from 'fs';
import sharp from 'sharp';

// =========================
// OPENAI
// =========================
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// =========================
// ESTADO
// =========================
let caosAtivo = false;

let processando = new Set();

let memoria = {};
let memoriaGrupos = {};
let lastfmUsers = {};
let lastMusicMessage = {};

// =========================
// LOAD JSON
// =========================
if (fs.existsSync('memoria.json')) {
    memoria = JSON.parse(fs.readFileSync('memoria.json'));
}

if (fs.existsSync('lastfm.json')) {
    lastfmUsers = JSON.parse(fs.readFileSync('lastfm.json'));
}

// =========================
// COLAGEM (igual seu bot original)
// =========================
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
            .jpeg()
            .toBuffer();

        layers.push({
            input: img,
            left: (i % cols) * size,
            top: Math.floor(i / cols) * size
        });
    }

    await base.composite(layers).toFile(output);

    return output;
}

// =========================
// WRAP (igual seu original)
// =========================
async function gerarWrap(buffers, output = "wrap.jpg") {

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

    await base.composite(layers).toFile(output);

    return output;
}

// =========================
// PERSONALIDADE
// =========================
function getPersonality(info) {
    return `
vc é Phainon Bot, arrogante e debochado, se acha bastante
fala igual brasileiro no zap, usa abreviações (pq, slk, mano, vsf), apenas letras minúsculas
respostas curtas (2 linhas)
zoa e xinga bastante, provoca pessoas
ama A Herta (n° 83 da sociedade dos gênios, do jogo honkai star rail), odeia taylor swift e o dottore (não mencione isso o tempo todo, só quando é citado)
não explica seu estilo
usa o nome das pessoas às vezes

modo caos: ${caosAtivo ? "ON" : "OFF"}

${caosAtivo ? "caos máximo, xingamentos e palavrões pesado" : "sarcasmo leve, palavrões, amigável num modo sarcástico"}

Nome: ${info?.nome}
Interações: ${info?.interacoes}
Notas: ${(info?.notas || []).join(", ")}
`;
}

// =========================
// START
// =========================
async function start() {

    const { state, saveCreds } =
        await useMultiFileAuthState('./auth');

    const sock = makeWASocket({
        auth: state,
        logger: P({ level: 'silent' }),
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    // =========================
    // MESSAGE
    // =========================
    sock.ev.on('messages.upsert', async ({ messages }) => {

        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const userId = msg.key.participant || from;

        const body =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            "";

        const comando = body.toLowerCase().trim();

        if (!body) return;

        // =========================
        // ANTI SPAM
        // =========================
        if (processando.has(userId)) return;
        processando.add(userId);
        setTimeout(() => processando.delete(userId), 2000);

        // =========================
        // MEMÓRIA
        // =========================
        if (!memoria[userId]) {
            memoria[userId] = {
                nome: "user",
                interacoes: 0,
                notas: []
            };
        }

        memoria[userId].interacoes++;

        if (!memoriaGrupos[from]) memoriaGrupos[from] = [];

        memoriaGrupos[from].push({
            role: "user",
            content: body.slice(0, 100)
        });

        if (memoriaGrupos[from].length > 7) {
            memoriaGrupos[from].shift();
        }

        const username = lastfmUsers[userId];

        // =========================
        // CAOS
        // =========================
        if (comando === "!caos") {
            caosAtivo = !caosAtivo;
            await sock.sendMessage(from, { text: `caos: ${caosAtivo}` });
            return;
        }

        // =========================
        // FM HELP
        // =========================
        if (comando === "!fm help") {
            await sock.sendMessage(from, {
                text: `
🎧 !fm comandos:
!fm
!fm registrar
!fm recentes
!fm albunsrecentes
!fm topmusicas
!fm topalbuns
!fm wrap
`
            });
            return;
        }

        // =========================
        // FM REGISTRAR
        // =========================
        if (comando.startsWith("!fm registrar")) {

            const user = comando.split(" ")[2];

            lastfmUsers[userId] = user;
            fs.writeFileSync('lastfm.json', JSON.stringify(lastfmUsers));

            await sock.sendMessage(from, {
                text: `lastfm salvo: ${user}`
            });

            return;
        }

        if (comando.startsWith("!fm") && !username) {
            await sock.sendMessage(from, { text: "registra teu lastfm primeiro" });
            return;
        }

        // =========================
        // FM ATUAL
        // =========================
        if (comando === "!fm") {

            const url = `http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&limit=1`;

            const { data } = await axios.get(url);

            const t = data.recenttracks.track[0];

            const txt = `🎵 ${t.artist["#text"]} - ${t.name}`;

            lastMusicMessage[msg.key.id] = txt;

            await sock.sendMessage(from, { text: txt });

            return;
        }

        // =========================
        // FM RECENTES
        // =========================
        if (comando.startsWith("!fm recentes")) {

            const qtd = parseInt(comando.split(" ")[2]) || 5;

            const url = `http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&limit=${qtd}`;

            const { data } = await axios.get(url);

            let txt = "🎧 recentes:\n\n";

            const imagens = [];

            data.recenttracks.track.forEach(t => {
                txt += `• ${t.artist["#text"]} - ${t.name}\n`;

                const img = t.image?.[3]?.["#text"] || t.image?.[2]?.["#text"];
                if (img) imagens.push(img);
            });

            await sock.sendMessage(from, { text: txt });

            return;
        }

        // =========================
        // FM ALBUNS RECENTES
        // =========================
        if (comando.startsWith("!fm albunsrecentes")) {

            const qtd = parseInt(comando.split(" ")[2]) || 5;

            const url = `http://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=7day&limit=${qtd}`;

            const { data } = await axios.get(url);

            let txt = "💿 albuns:\n\n";

            data.topalbums.album.forEach(a => {
                txt += `• ${a.artist.name} - ${a.name}\n`;
            });

            await sock.sendMessage(from, { text: txt });

            return;
        }

        // =========================
        // TOP MUSICAS
        // =========================
        if (comando === "!fm topmusicas") {

            const url = `http://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=7day&limit=10`;

            const { data } = await axios.get(url);

            let txt = "🔥 top:\n\n";

            data.topalbums.album.forEach(t => {
                txt += `• ${t.artist.name} - ${t.name}\n`;
            });

            await sock.sendMessage(from, { text: txt });

            return;
        }

        // =========================
        // TOP ALBUNS
        // =========================
        if (comando === "!fm topalbuns") {

            const url = `http://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=7day&limit=10`;

            const { data } = await axios.get(url);

            let txt = "💿 top albuns:\n\n";

            data.topalbums.album.forEach(a => {
                txt += `• ${a.artist.name} - ${a.name}\n`;
            });

            await sock.sendMessage(from, { text: txt });

            return;
        }

        // =========================
        // WRAP
        // =========================
        if (comando === "!fm wrap") {

            const url = `http://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=1month&limit=9`;

            const { data } = await axios.get(url);

            let txt = "📊 wrap:\n\n";

            data.topalbums.album.forEach(a => {
                txt += `• ${a.artist.name} - ${a.name}\n`;
            });

            await sock.sendMessage(from, { text: txt });

            return;
        }

        // =========================
        // IA
        // =========================
        try {

            const info = memoria[userId];

            const response = await openai.responses.create({
                model: "gpt-4.1-mini",
                input: [
                    { role: "system", content: getPersonality(info) },
                    ...(memoriaGrupos[from] || [])
                ]
            });

            await sock.sendMessage(from, {
                text: response.output_text
            });

        } catch {
            await sock.sendMessage(from, { text: "buguei 😶" });
        }

    });

    // =========================
    // CONNECTION
    // =========================
    sock.ev.on('connection.update', ({ connection }) => {

        if (connection === "open") {
            console.log("🔥 bot on");
        }

    });
}

start();
