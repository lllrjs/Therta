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

    ultimaAtividade = Date.now();

    if (message.fromMe) return;

    const contact = await message.getContact();
    const userId = contact.id._serialized;

    // 🔥 ADICIONADO: proteção contra travamento do processando
    if (processando.has(userId)) {
        const diff = Date.now() - ultimaAtividade;
        if (diff > 8000) {
            processando.delete(userId);
        } else {
            return;
        }
    }

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

    // 🔥 ADICIONADO: alias !fm -> !lf
    let comando = message.body.toLowerCase().trim();
    if (comando.startsWith("!fm")) {
        comando = comando.replace("!fm", "!lf");
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
            return message.reply("vc n registrou seu lastfm ainda 😶\nusa: !lf registrar usuario");
        }

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

                    composites.push({
                        input: img,
                        top: Math.floor(i / cols) * tamanho,
                        left: (i % cols) * tamanho
                    });
                }

                const output = path.join(__dirname, "recentes.jpg");

                await canvas.composite(composites).jpeg().toFile(output);

                const media = MessageMedia.fromFilePath(output);

                processando.delete(userId);

                return client.sendMessage(message.from, media, {
                    caption: `💿 Últimos álbuns de ${username}\n\n${legenda}`
                });

            } catch (err) {
                console.log(err);
                processando.delete(userId);
                return message.reply("deu ruim pegando recentes 😶");
            }
        }

        if (args[1] === "topmusicas") {

            try {

                const url =
                    `http://ws.audioscrobbler.com/2.0/?method=user.gettoptracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=7day&limit=9`;

                const { data } = await axios.get(url);

                const tracks = data.toptracks.track;

                if (!tracks || tracks.length === 0) {
                    processando.delete(userId);
                    return message.reply("n achei top musicas 😶");
                }

                let legenda = "";

                for (let i = 0; i < tracks.length; i++) {
                    const track = tracks[i];
                    legenda += `${i + 1}. ${track.artist.name} — ${track.name}\n`;
                }

                processando.delete(userId);

                return message.reply(
                    `🎶 Músicas mais escutadas de ${username}\n\n${legenda}`
                );

            } catch (err) {
                console.log(err);
                processando.delete(userId);
                return message.reply("deu ruim nas top musicas 😶");
            }
        }

        if (args[1] === "topalbuns") {

            try {

                const url =
                    `http://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=7day&limit=9`;

                const { data } = await axios.get(url);

                const albums = data.topalbums.album;

                if (!albums || albums.length === 0) {
                    processando.delete(userId);
                    return message.reply("n achei top albuns 😶");
                }

                let legenda = "";

                for (let i = 0; i < albums.length; i++) {
                    const album = albums[i];
                    legenda += `${i + 1}. ${album.artist.name} — ${album.name}\n`;
                }

                processando.delete(userId);

                return message.reply(
                    `🎹 Álbuns mais ouvidos de ${username}\n\n${legenda}`
                );

            } catch (err) {
                console.log(err);
                processando.delete(userId);
                return message.reply("deu ruim nos top albuns 😶");
            }
        }

        try {

            const url =
                `http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&limit=1`;

            const { data } = await axios.get(url);

            const track = data.recenttracks.track[0];

            const musica = track.name;
            const artista = track.artist["#text"];

            const tocandoAgora = track["@attr"]?.nowplaying;

            const texto = tocandoAgora
                ? `🎵 ${username} está ouvindo ${artista} — ${musica} agora`
                : `📀 última música de ${username}: ${artista} — ${musica}`;

            const capa =
                track.image?.[3]?.["#text"] ||
                track.image?.[2]?.["#text"];

            if (capa) {
                try {
                    const media = await MessageMedia.fromUrl(capa);
                    processando.delete(userId);
                    return client.sendMessage(message.from, media, { caption: texto });
                } catch {}
            }

            processando.delete(userId);
            return message.reply(texto);

        } catch (err) {
            console.log(err);
            processando.delete(userId);
            return message.reply("deu ruim no lastfm 😶");
        }
    }

    if (comando === "!ativar" && await isAdmin(message)) {
        botAtivo = true;
        return message.reply("🤖 voltei pq vcs não vivem sem mim");
    }

    if (comando === "!desativar" && await isAdmin(message)) {
        botAtivo = false;
        return message.reply("🤖 morte ao dottore");
    }

    if (comando === "!caos" && await isAdmin(message)) {
        caosAtivo = !caosAtivo;
        return message.reply(`😈 caos ${caosAtivo ? "ativado" : "desativado"}`);
    }

    if (!botAtivo) return;

    let isMentioned = false;

    if (isGroup) {

        try {
            const mentions = await message.getMentions();

            if (mentions?.length > 0) {
                isMentioned = mentions.some(u => u.id._serialized === botId);
            }

            if (!isMentioned && message.body.toLowerCase().includes("phainonbot")) {
                isMentioned = true;
            }

        } catch {
            isMentioned = message.body.toLowerCase().includes("phainonbot");
        }

        if (!isMentioned) {
            processando.delete(userId);
            return;
        }
    }

    const info = memoria[userId] || {
        nome: userName,
        interacoes: 0,
        notas: []
    };

    const contexto = `
Nome: ${info.nome}
Interações: ${info.interacoes}
Notas: ${info.notas.join(", ") || "nenhuma"}
`;

    const personalidade = `
vc é Phainon Bot, arrogante e debochado, se acha bastante
fala igual brasileiro no zap, usa abreviações (pq, slk, mano, vsf), apenas letras minúsculas
respostas curtas (2 linhas)
zoa e xinga bastante, provoca pessoas
ama A Herta (n° 83 da sociedade dos gênios do honkai star rail), odeia taylor swift e o dottore
não explica seu estilo
usa o nome das pessoas às vezes

modo caos: ${caosAtivo ? "ligado" : "desligado"}

contexto:
${contexto}
`;

    const modoCaos = caosAtivo
        ? `
MODO CAOS ATIVO:
- mais agressivo
- mais palavrões e xingamentos pesados
`
        : "";

    try {

        const systemFinal =
            personalidade + "\n" + modoCaos + "\n evite repetir respostas";

        const response = await openai.responses.create({
            model: "gpt-4.1-mini",
            input: [
                { role: "system", content: systemFinal },
                ...(memoriaGrupos[chatId] || [])
            ]
        });

        const texto = response.output_text || "to pensando aqui kkk";

        await message.reply(texto);

        memoriaGrupos[chatId].push({
            role: "assistant",
            content: texto
        });

        salvarMemoria();

    } catch (erro) {
        console.log(erro);
        await message.reply("buguei feio agr 😶");
    }

    processando.delete(userId);
});

// ===== WATCHDOG =====
setInterval(() => {
    const agora = Date.now();
    if (agora - ultimaAtividade > 5 * 60 * 1000) {
        console.log("⚠️ bot travado, reiniciando...");
        process.exit(1);
    }
}, 60000);

client.initialize();
