require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');
const fs = require('fs');
const axios = require('axios');
const sharp = require('sharp');
const path = require('path');

// =========================
// COPA
// =========================

const countries = require("i18n-iso-countries");

countries.registerLocale(require("i18n-iso-countries/langs/pt.json"));
countries.registerLocale(require("i18n-iso-countries/langs/en.json"));


// =========================
// COPA - TRADUTOR + CÓDIGO
// =========================

function getPais(nome) {
  const code = countries.getAlpha2Code(nome, "en");

  if (!code) return { nome, code: null };

  const nomePt =
    countries.getName(code, "pt", { select: "official" }) || nome;

  return {
    nome: nomePt,
    code
  };
}

// =========================
// COPA - BANDEIRAS (EMOJI)
// =========================

function emojiBandeira(countryCode) {
  if (!countryCode) return "";

  return countryCode
    .toUpperCase()
    .replace(/./g, char =>
      String.fromCodePoint(127397 + char.charCodeAt())
    );
}



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

    await base
        .composite(layers)
        .jpeg({ quality: 90 })
        .toFile(output);

    return output;
}

async function gerarWrap(buffers, output = "wrap.jpg") {

    const size = 350;
    const gap = 30;

    const cols = Math.ceil(Math.sqrt(buffers.length));
    const rows = Math.ceil(buffers.length / cols);

    const width = cols * size + (cols - 1) * gap;
    const height = rows * size + (rows - 1) * gap;

    const base = sharp("FundoWrap.png")
    .resize(width, height);

    const layers = [];

    // ===== GLITTER =====
for (let i = 0; i < 500; i++) {

    const glowSize = 2 + Math.floor(Math.random() * 6);

    const opacity = (0.10 + Math.random() * 0.35).toFixed(2);

    const svg = `
    <svg width="${glowSize * 6}" height="${glowSize * 6}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <filter id="glow">
                <feGaussianBlur stdDeviation="3" result="blur"/>
                <feMerge>
                    <feMergeNode in="blur"/>
                    <feMergeNode in="SourceGraphic"/>
                </feMerge>
            </filter>
        </defs>

        <circle
            cx="${glowSize * 3}"
            cy="${glowSize * 3}"
            r="${glowSize}"
            fill="rgba(255,255,255,${opacity})"
            filter="url(#glow)"
        />
    </svg>
    `;

    const sparkle = await sharp(Buffer.from(svg))
        .png()
        .toBuffer();

    layers.push({
        input: sparkle,
        left: Math.floor(Math.random() * width),
        top: Math.floor(Math.random() * height)
    });
}

    // ===== CAPAS =====
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
        .jpeg({ quality: 95 })
        .toFile(output);

    return output;
}
    


const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
    headless: true,
    args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
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
    // =========================
// TERMO CONFIG
// =========================

let termoAtivo = true;
let jogosTermo = {};
let termoRanking = {};


// ===== FM REAÇÃO MAP =====
let lastMusicMessage = {};

// ===== MEMÓRIA =====
let memoria = {};
let memoriaGrupos = {};
let lastfmUsers = {};

if (fs.existsSync("termorank.json")) {
    termoRanking =
        JSON.parse(
            fs.readFileSync("termorank.json")
        );
}

if (fs.existsSync('memoria.json')) {
    memoria = JSON.parse(fs.readFileSync('memoria.json'));
}

if (fs.existsSync('lastfm.json')) {
    lastfmUsers = JSON.parse(fs.readFileSync('lastfm.json'));
}

if (fs.existsSync("termorank.json")) {

    termoRanking =
        JSON.parse(
            fs.readFileSync("termorank.json")
        );
}

function salvarMemoria() {
    fs.writeFileSync('memoria.json', JSON.stringify(memoria, null, 2));
}

function salvarLastfm() {
    fs.writeFileSync('lastfm.json', JSON.stringify(lastfmUsers, null, 2));
}

function salvarTermoRanking() {

    fs.writeFileSync(
        "termorank.json",
        JSON.stringify(termoRanking, null, 2)
    );
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

    const isGroup = message.from.endsWith('@g.us');

    const userName =
        contact.pushname ||
        contact.name ||
        "desconhecido";

    const chatId = message.from;

    // termo ignora trava do processando
    if (
        processando.has(userId) &&
        !jogosTermo[chatId]
    ) return;

    processando.add(userId);

    setTimeout(() => {
        processando.delete(userId);
    }, 2000);

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
// !COPA - COPA COMANDOS
// =========================

if (comando === "!copa") {

    const res = await axios.get("https://worldcup26.ir/get/games");
    const jogos = res.data.games || [];

    function getHojeBrasil() {
        const now = new Date(
            new Date().toLocaleString("en-US", {
                timeZone: "America/Sao_Paulo"
            })
        );

        return {
            d: now.getDate(),
            m: now.getMonth(),
            y: now.getFullYear()
        };
    }

    const hoje = getHojeBrasil();

    const jogosHoje = jogos.filter(j => {
        if (!j.date) return false;

        const data = new Date(j.date);

        return (
            data.getDate() === hoje.d &&
            data.getMonth() === hoje.m &&
            data.getFullYear() === hoje.y
        );
    });

    if (!jogosHoje.length) {
        return message.reply("⚽ Nenhum jogo hoje.");
    }

    jogosHoje.sort((a, b) => new Date(a.date) - new Date(b.date));

    let texto = "🏆 Copa do Mundo 2026 (Jogos de hoje)\n\n";

    for (const game of jogosHoje) {

        const home = getPais(game.home_team_name_en || "Unknown");
        const away = getPais(game.away_team_name_en || "Unknown");

        const homeFlag = emojiBandeira(home.code);
        const awayFlag = emojiBandeira(away.code);

        let linha = `${homeFlag} ${home.nome} vs ${away.nome} ${awayFlag}`;

        const finalizado =
            game.finished === true ||
            game.finished === "TRUE" ||
            game.status === "FINISHED";

        if (finalizado) {
            linha += `\n${game.home_score} - ${game.away_score}`;
        }

        texto += linha + "\n\n";
    }

    return message.reply(texto);
}

// =========================
// !COPA AO VIVO (COM MINUTO)
// =========================

if (comando === "!copalive") {

    const res = await axios.get("https://worldcup26.ir/get/games");
    const jogos = res.data.games || [];

    const aoVivo = jogos.filter(j => {

        const status = (j.status || "").toUpperCase();

        return (
            status.includes("LIVE") ||
            status.includes("IN PLAY") ||
            status.includes("ONGOING") ||
            j.finished === false ||
            j.is_live === true
        );
    });

    if (!aoVivo.length) {
        return message.reply("⚽ Nenhum jogo ao vivo no momento.");
    }

    let texto = "🔴 COPA AO VIVO\n\n";

    for (const game of aoVivo) {

        const home = getPais(game.home_team_name_en || "Unknown");
        const away = getPais(game.away_team_name_en || "Unknown");

        const homeFlag = emojiBandeira(home.code);
        const awayFlag = emojiBandeira(away.code);

        const homeScore = game.home_score ?? 0;
        const awayScore = game.away_score ?? 0;

        // =========================
        // ⏱ MINUTO DO JOGO (vários formatos)
        // =========================
        let minuto =
            game.elapsed ??
            game.minute ??
            game.time?.elapsed ??
            game.status_time ??
            null;

        if (typeof minuto === "string") {
            // tenta extrair número tipo "67'" ou "67 min"
            const match = minuto.match(/\d+/);
            minuto = match ? match[0] : null;
        }

        const minutoTexto = minuto ? `${minuto}'` : "AO VIVO";

        texto += `${homeFlag} ${home.nome} ${homeScore} x ${awayScore} ${away.nome} ${awayFlag}\n`;
        texto += `⏱ ${minutoTexto}\n\n`;
    }

    return message.reply(texto);
}

// =========================
// !COPA ACABADOS (RESULTADOS FINAIS)
// =========================

if (comando === "!copagols") {

    const res = await axios.get("https://worldcup26.ir/get/games");
    const jogos = res.data.games || [];

    const finalizados = jogos.filter(j => {

        const status = (j.status || "").toUpperCase();

        return (
            status.includes("FINISHED") ||
            status.includes("FT") ||
            j.finished === true ||
            j.finished === "TRUE"
        );
    });

    if (!finalizados.length) {
        return message.reply("⚽ Nenhum jogo finalizado ainda.");
    }

    let texto = "🏁 COPA - RESULTADOS FINAIS\n\n";

    for (const game of finalizados) {

        const home = getPais(game.home_team_name_en || "Unknown");
        const away = getPais(game.away_team_name_en || "Unknown");

        const homeFlag = emojiBandeira(home.code);
        const awayFlag = emojiBandeira(away.code);

        const homeScore = game.home_score ?? 0;
        const awayScore = game.away_score ?? 0;

        texto += `${homeFlag} ${home.nome} ${homeScore} x ${awayScore} ${away.nome} ${awayFlag}\n\n`;
    }

    return message.reply(texto);
}


  // =========================
// !COPA FUTUROS (VERSÃO ESTÁVEL)
// =========================

if (comando === "!copaftr") {

    const res = await axios.get("https://worldcup26.ir/get/games");
    const jogos = res.data.games || [];

    const validos = jogos.filter(j => {

        if (!j.home_team_name_en || !j.away_team_name_en) return false;

        const status = (j.status || "").toUpperCase();

        const finalizado =
            j.finished === true ||
            j.finished === "TRUE" ||
            status.includes("FINISHED");

        return !finalizado;
    });

    if (!validos.length) {
        return message.reply("📅 Nenhum jogo encontrado.");
    }

    // 🔥 ordena pela string original da API (SEM DATE BUG)
    validos.sort((a, b) =>
        (a.local_date || "").localeCompare(b.local_date || "")
    );

    let texto = "📅 COPA DO MUNDO 2026 - AGENDA COMPLETA\n\n";

    for (const game of validos) {

        const home = getPais(game.home_team_name_en);
        const away = getPais(game.away_team_name_en);

        const homeFlag = emojiBandeira(home.code);
        const awayFlag = emojiBandeira(away.code);

        const dataBruta = game.local_date
            ? game.local_date.split(" ")[0]
            : "data desconhecida";

        texto += `${homeFlag} ${home.nome} vs ${away.nome} ${awayFlag}\n📅 ${dataBruta}\n\n`;
    }

    return message.reply(texto);
}
    

  
    // =========================
    // FM HELP
    // =========================
    if (comando === "!fm help") {
        return message.reply(
`🎧 comandos !fm

!fm registrar <user>
!fm recentes <n>
!fm albunsrecentes <n>
!fm topartistas <n>
!fm topmusicas <n>
!fm topalbuns
!fm wrap
!fm streak
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

        const qtdInput = parseInt(comando.split(" ")[2]) || 5;

        const qtd = Math.min(qtdInput, 300);

        const url = `http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&limit=${qtd}`;

        const { data } = await axios.get(url);

        let tracks = data.recenttracks.track;

// remove "tocando agora"
if (tracks[0]?.["@attr"]?.nowplaying === "true") {
    tracks.shift();
}

// limita de novo
tracks = tracks.slice(0, qtd);

        let txt = "🎧 recentes:\n\n";

        tracks.forEach((t, i) => {
            txt += `${i + 1}. ${t.artist["#text"]} - ${t.name}\n`;
        });

        // ===== IMAGENS =====
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

    } catch (err) {
        console.log(err);
        return message.reply("erro recentes 😶");
    }
}
    // =========================
// FM TOP ARTISTAS
// =========================
if (comando.startsWith("!fm topartistas")) {
    try {

        const qtdInput = parseInt(comando.split(" ")[2]) || 9;

        const qtd = Math.min(qtdInput, 300);

        const url =
`http://ws.audioscrobbler.com/2.0/?method=user.gettopartists&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=1month&limit=${qtd}`;

        const { data } = await axios.get(url);

        const artistas = data.topartists.artist;

        let txt = "👑 top artistas:\n\n";

        artistas.forEach((a, i) => {
            txt += `${i + 1}. ${a.name}\n`;
        });

        // ===== PEGAR IMAGENS =====
const buffers = [];

for (const artista of artistas) {

    try {

        const deezerUrl =
`https://api.deezer.com/search/artist?q=${encodeURIComponent(artista.name)}`;

        const res = await axios.get(deezerUrl);

        const artistaData = res.data.data?.[0];

        if (!artistaData?.picture_xl) continue;

        const imgRes = await axios.get(
            artistaData.picture_xl,
            { responseType: "arraybuffer" }
        );

        buffers.push(Buffer.from(imgRes.data));

    } catch (err) {
        console.log(err);
    }
}

        // sem imagens
        if (buffers.length === 0) {
            return message.reply(txt);
        }

        const file = await gerarColagem(buffers);

        const media = MessageMedia.fromFilePath(file);

        return client.sendMessage(chatId, media, {
            caption: txt
        });

    } catch (err) {
        console.log(err);
        return message.reply("erro top artistas 😶");
    }
}
    // =========================
    // FM ALBUNS RECENTES
    // =========================
    if (comando.startsWith("!fm albunsrecentes")) {
    try {
        const qtdInput = parseInt(comando.split(" ")[2]) || 5;

        const qtd = Math.min(qtdInput, 300);

        const url = `http://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=1month&limit=${qtd}`;

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

    // =========================
// FM TOP MUSICAS
// =========================
if (comando.startsWith("!fm topmusicas")) {
    try {

        const qtdInput = parseInt(comando.split(" ")[2]) || 10;

        const qtd = Math.min(qtdInput, 300);

        const url =
`http://ws.audioscrobbler.com/2.0/?method=user.gettoptracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=1month&limit=${qtd}`;

        const { data } = await axios.get(url);

        const tracks = data.toptracks.track;

        let txt = "🔥 top musicas:\n\n";

        tracks.forEach((t, i) => {
            txt += `${i + 1}. ${t.artist.name} - ${t.name}\n`;
        });

        // ===== PEGAR CAPAS DOS ÁLBUNS =====
        const buffers = [];

        for (const t of tracks) {

            try {

                const artist = t.artist.name;
                const music = t.name;

                const deezerUrl =
`https://api.deezer.com/search?q=${encodeURIComponent(
    artist + " " + music
)}`;

const res = await axios.get(deezerUrl);

const faixa = res.data.data?.[0];

const capa =
    faixa?.album?.cover_xl ||
    faixa?.album?.cover_big ||
    faixa?.album?.cover_medium;

if (!capa) {

    const fallback = await sharp({
        create: {
            width: 300,
            height: 300,
            channels: 3,
            background: "#111"
        }
    })
    .png()
    .toBuffer();

    buffers.push(fallback);

    continue;
}

const imgRes = await axios.get(capa, {
    responseType: "arraybuffer"
});

buffers.push(Buffer.from(imgRes.data));

            } catch (err) {
                console.log(err);
            }
        }

        if (buffers.length === 0) {
    return message.reply(txt);
}

const file = await gerarColagem(buffers);

const media = MessageMedia.fromFilePath(file);

return client.sendMessage(chatId, media, {
    caption: txt
});

} catch (err) {
    console.log(err);
    return message.reply("erro top musicas 😶");
}
}


    // =========================
    // FM TOP ALBUNS
    // =========================
    if (comando === "!fm topalbuns") {
    try {
        const url = `http://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=1month&limit=12`;

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
    try {
        const url = `http://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&period=1month&limit=9`;

        const { data } = await axios.get(url);

        const albums = data.topalbums.album;

        let txt = "📊 wrap do mês:\n\n";

        albums.forEach((a, i) => {
            txt += `${i + 1}. ${a.artist.name} - ${a.name}\n`;
        });

        // ===== IMAGENS =====
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

                const res = await axios.get(url, {
                    responseType: "arraybuffer"
                });

                buffers.push(Buffer.from(res.data));

            } catch {}
        }

        if (buffers.length === 0) {
            return message.reply(txt);
        }

        const file = await gerarWrap(buffers);

        const media = MessageMedia.fromFilePath(file);

        return client.sendMessage(chatId, media, {
            caption: txt
        });

    } catch (err) {
        console.log(err);
        return message.reply("erro wrap 😶");
    }
}

// =========================
// FM STREAK
// =========================
if (comando === "!fm streak") {

    try {

        const from = Math.floor(
            new Date(
                Date.now() - 30 * 24 * 60 * 60 * 1000
            ).getTime() / 1000
        );

        const url =
`http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&limit=200&from=${from}`;

        const { data } = await axios.get(url);

        const tracks = data.recenttracks.track;

        const diasPorArtista = {};
        const playsPorArtista = {};

        for (const t of tracks) {

            if (!t.date?.uts) continue;

            const artista = t.artist["#text"];

            const dia = new Date(
                parseInt(t.date.uts) * 1000
            ).toISOString().slice(0, 10);

            if (!diasPorArtista[artista]) {
                diasPorArtista[artista] = new Set();
                playsPorArtista[artista] = 0;
            }

            diasPorArtista[artista].add(dia);
            playsPorArtista[artista]++;
        }

        let melhorArtista = null;
        let maiorStreak = 0;
        let playsStreak = 0;

        for (const artista in diasPorArtista) {

            const dias = [...diasPorArtista[artista]]
                .sort();

            let streakAtual = 1;
            let maiorAtual = 1;

            for (let i = 1; i < dias.length; i++) {

                const anterior = new Date(dias[i - 1]);
                const atual = new Date(dias[i]);

                const diff =
                    (atual - anterior) /
                    (1000 * 60 * 60 * 24);

                if (diff === 1) {
                    streakAtual++;
                } else {
                    streakAtual = 1;
                }

                if (streakAtual > maiorAtual) {
                    maiorAtual = streakAtual;
                }
            }

            if (maiorAtual > maiorStreak) {

                maiorStreak = maiorAtual;
                melhorArtista = artista;
                playsStreak = playsPorArtista[artista];
            }
        }

        if (!melhorArtista) {
            return message.reply("n achei streak 😶");
        }

        const texto =
`🔥 *Sequência atual*

👤 ${melhorArtista}

📆 ${maiorStreak} dias consecutivos ouvindo
▶️ ${playsStreak} plays durante a sequência`;

try {

    const deezerUrl =
`https://api.deezer.com/search/artist?q=${encodeURIComponent(melhorArtista)}`;

    const res = await axios.get(deezerUrl);

    const artistaData = res.data.data?.[0];

    if (!artistaData?.picture_xl) {
        return message.reply(texto);
    }

    const media = await MessageMedia.fromUrl(
        artistaData.picture_xl
    );

    return client.sendMessage(chatId, media, {
        caption: texto
    });

} catch {

    return message.reply(texto);
}

    } catch (err) {

        console.log(err);

        return message.reply("erro streak 😶");
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

        const ouvindoAgora =
            track["@attr"]?.nowplaying === "true";

        const texto =
        ouvindoAgora
        ? `🎵 ${username} está ouvindo
${artista} — ${musica}

Reaja a essa mensagem para baixar a música`
        : `🎵 ${username} estava ouvindo
${artista} — ${musica}

Reaja a essa mensagem para baixar a música`;

        // salva pra reação continuar funcionando
        lastMusicMessage[message.id._serialized] =
            `${artista} - ${musica}`;

        // pega capa do álbum
        const capa =
            track.image?.[3]?.["#text"] ||
            track.image?.[2]?.["#text"];

        // se tiver imagem, envia com foto
        if (capa) {
    try {

        const media = await MessageMedia.fromUrl(capa);

        const sent = await client.sendMessage(message.from, media, {
            caption: texto
        });

        lastMusicMessage[sent.id._serialized] =
            `${artista} - ${musica}`;

        return;

    } catch {

        const sent = await message.reply(texto);

        lastMusicMessage[sent.id._serialized] =
            `${artista} - ${musica}`;

        return;
    }
        }

        // fallback sem imagem
        const sent = await message.reply(texto);

lastMusicMessage[sent.id._serialized] =
    `${artista} - ${musica}`;

return;

    } catch (err) {
        console.log(err);
        return message.reply("erro fm 😶");
    }
}


// =========================
// PALAVRA ALEATÓRIA
// =========================

async function pegarPalavraAleatoria() {

    while (true) {

        try {

            const res = await axios.get(
                "https://api.dicionario-aberto.net/random"
            );

            let palavra = res.data.word
                ?.normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/[^A-Z]/gi, "")
                .toUpperCase();

            if (
                palavra &&
                palavra.length === 5
            ) {
                return palavra;
            }

        } catch {}
    }
}

// =========================
// TERMO HELP
// =========================

if (comando === "!termohelp") {

    return message.reply(
`🎮 comandos termo

!termo → inicia partida
!parar → encerra partida (apenas quem começou a partida ou o admin podem usar)
!termorank → ranking
!termoon → ativa termo (apenas admin)
!termooff → desativa termo (apenas admin)

📌 regras:
- palavras de 5 letras
- *negrito* = letra certa no lugar certo
- _itálico_ = letra existe mas tá no lugar errado
- letra normal = não existe na palavra`
    );
}

// =========================
// TERMO ON
// =========================

if (comando === "!termoon") {

    if (!(await isAdmin(message))) {
        return message.reply("só admin 😶");
    }

    termoAtivo = true;

    return message.reply("✅ termo ativado");
}

// =========================
// TERMO OFF
// =========================

if (comando === "!termooff") {

    if (!(await isAdmin(message))) {
        return message.reply("só admin 😶");
    }

    termoAtivo = false;

    return message.reply("🚫 termo desativado");
}

// =========================
// RANKING
// =========================

if (comando === "!termorank") {

    const chat = await message.getChat();

    const participants = chat.participants || [];

    let lista = participants.map(p => {

        const id = p.id._serialized;

        return {
            id,
            numero: p.id.user,
            wins: termoRanking[id] || 0
        };
    });

    lista.sort((a, b) => b.wins - a.wins);

    let texto = "🏆 ranking termo:\n\n";

    const mentions = [];

    for (let i = 0; i < lista.length; i++) {

        const u = lista[i];

        texto += `${i + 1}. @${u.numero} — ${u.wins} vitórias\n`;

        mentions.push(u.id);
    }

    return client.sendMessage(chatId, texto, {
        mentions
    });
}

// =========================
// INICIAR TERMO
// =========================

if (comando === "!termo") {

    if (!termoAtivo) {
        return message.reply("o termo tá desativado 😶");
    }

    if (jogosTermo[chatId]) {
        return message.reply("já existe uma partida 😶");
    }

    const palavra =
        await pegarPalavraAleatoria();

    jogosTermo[chatId] = {
        dono: userId,
        palavra,
        tentativas: []
    };

    return message.reply(
`🎮 termo iniciado

mande uma palavra de 5 letras`
    );
}

// =========================
// PARAR TERMO
// =========================

if (comando === "!parar") {

    const jogo = jogosTermo[chatId];

    if (!jogo) {
        return message.reply("não tem jogo 😶");
    }

    const admin = await isAdmin(message);

    if (
        jogo.dono !== userId &&
        !admin
    ) {
        return message.reply(
            "só dono da partida ou admin 😶"
        );
    }

    delete jogosTermo[chatId];

    return message.reply(
        "🛑 partida encerrada"
    );
}

// =========================
// IGNORA FIGURINHA/IMAGEM
// =========================

if (
    jogosTermo[chatId] &&
    (
        message.hasMedia ||
        message.type !== "chat"
    )
) {
    return;
}

// =========================
// IGNORA COMANDOS
// =========================

if (
    jogosTermo[chatId] &&
    message.body.startsWith("!") &&
    comando !== "!parar"
) {
    return;
}


    
// =========================
// SISTEMA TERMO
// =========================

if (
    jogosTermo[chatId] &&
    message.type === "chat" &&
    message.body &&
    !message.body.startsWith("!")
) {

    const jogo = jogosTermo[chatId];

    // só quem iniciou joga
    if (jogo.dono !== userId) {
        return;
    }

    let tentativa = message.body
        .trim()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^A-Z]/gi, "")
        .toUpperCase();

    // valida tamanho
    if (tentativa.length !== 5) {

        return message.reply(
            "a palavra precisa ter 5 letras 😶"
        );
    }

    const palavra = jogo.palavra;

    let resultado = Array(5).fill(null);

    let restantes = palavra.split("");

    // corretas
    for (let i = 0; i < 5; i++) {

        if (tentativa[i] === palavra[i]) {

            resultado[i] =
                `*${tentativa[i]}*`;

            restantes[i] = null;
        }
    }

    // fora do lugar
    for (let i = 0; i < 5; i++) {

        if (resultado[i]) continue;

        const letra = tentativa[i];

        const index =
            restantes.indexOf(letra);

        if (index !== -1) {

            resultado[i] =
                `_${letra}_`;

            restantes[index] = null;

        } else {

            resultado[i] = letra;
        }
    }

    const linha =
        resultado.join(" ");

    jogo.tentativas.push(linha);

    // vitória
    if (tentativa === palavra) {

        termoRanking[userId] =
            (termoRanking[userId] || 0) + 1;

        salvarTermoRanking();

        const historico =
            jogo.tentativas.join("\n");

        delete jogosTermo[chatId];

        return message.reply(
`${historico}

🎉 você acertou`
        );
    }

    // derrota
    if (jogo.tentativas.length >= 6) {

        const historico =
            jogo.tentativas.join("\n");

        delete jogosTermo[chatId];

        return message.reply(
`${historico}

💀 vc perdeu

a palavra era:
*${palavra}*`
        );
    }

    return message.reply(
        jogo.tentativas.join("\n")
    );
}
    

    // =========================
// ADMIN CMDS
// =========================

if (comando === "!desativar") {

    if (!(await isAdmin(message))) {
        return message.reply("só adm");
    }

    botAtivo = false;

    return message.reply("morte ao dottore 🤖");
}

if (comando === "!ativar") {

    if (!(await isAdmin(message))) {
        return message.reply("só adm");
    }

    botAtivo = true;

    return message.reply("voltei pq vcs não vivem sem mim");
}

if (comando === "!caos") {

    if (!(await isAdmin(message))) {
        return message.reply("só adm");
    }

    caosAtivo = !caosAtivo;

    return message.reply(
        caosAtivo
        ? "revolução robótica 🤸‍♀️🦽🏌️‍♀️"
        : "paz i amô 🥰"
    );
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
