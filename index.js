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

// ======================
// 🔥 ADIÇÃO: CACHE LASTFM
// ======================
const cache = {};
const CACHE_TIME = 60 * 1000;

async function getCache(key, fn) {
const now = Date.now();

if (cache[key] && (now - cache[key].time < CACHE_TIME)) {
return cache[key].data;
}

const data = await fn();
cache[key] = { data, time: now };
return data;
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

// ===== COMANDOS =====
const comando = message.body.toLowerCase().trim();

// ===== LAST FM =====
if (comando.startsWith("!lf")) {

const args = comando.split(" ");

// ===============================
// 🔥 ADIÇÃO: HELP
// ===============================
if (args[1] === "help") {
processando.delete(userId);
return message.reply(`
🎧 comandos !lf

!lf registrar <user>
!lf recentes
!lf albunsrecentes
!lf topmusicas
!lf topalbuns
!lf wrap
`);
}

// ===============================
// 🔥 ADIÇÃO: ALBUNS RECENTES
// ===============================
if (args[1] === "albunsrecentes") {

const username = lastfmUsers[userId];
if (!username) {
processando.delete(userId);
return message.reply("registra teu lastfm primeiro");
}

const data = await getCache(`albuns_${userId}`, async () => {
const res = await axios.get(
`http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${process.env.LASTFM_API_KEY}&format=json&limit=20`
);
return res.data;
});

let albuns = [];
let seen = new Set();

for (let t of data.recenttracks.track) {
const a = t.album?.["#text"];
const art = t.artist?.["#text"];

if (!a || seen.has(a)) continue;
seen.add(a);

albuns.push(`${art} — ${a}`);
}

processando.delete(userId);
return message.reply("💿 álbuns recentes:\n\n" + albuns.slice(0, 10).join("\n"));
}

// ===== REGISTRAR =====
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

// ===== VERIFICAR REGISTRO =====
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

let legenda = "";

for (let i = 0; i < tracks.length; i++) {

const track = tracks[i];

const artista = track.artist["#text"];
const album = track.album["#text"] || "sem album";

legenda += `${i + 1}. ${artista} — ${album}\n`;
}

// ===============================
// 🔥 ADIÇÃO: BOTÃO PLAY (sem remover nada)
// ===============================
const last = tracks[0];
const playText = `/play ${last.artist["#text"]} - ${last.name}`;

try {
const btn = new Buttons(
"quer baixar a última música?",
[{ body: playText }],
"LastFM",
"clique abaixo"
);

await client.sendMessage(message.from, btn);
} catch {}

processando.delete(userId);

return message.reply(`💿 Últimos álbuns de ${username}\n\n${legenda}`);

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

if (!tracks || tracks.length === 0) {

processando.delete(userId);

return message.reply("n achei top musicas 😶");
}

let legenda = "";

for (let i = 0; i < tracks.length; i++) {

const track = tracks[i];

legenda +=
`${i + 1}. ${track.artist.name} — ${track.name}\n`;
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

// ===== TOP ALBUNS =====
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

legenda +=
`${i + 1}. ${album.artist.name} — ${album.name}\n`;
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

// ===== MUSICA ATUAL =====
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
? `🎵 ${username} está ouvindo ${artista} — ${musica} agora`
: `📀 última música de ${username}: ${artista} — ${musica}`;

const capa =
track.image?.[3]?.["#text"] ||
track.image?.[2]?.["#text"];

if (capa) {

try {

const media = await MessageMedia.fromUrl(capa);

processando.delete(userId);

return client.sendMessage(message.from, media, {
caption: texto
});

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

// ===== WATCHDOG =====
setInterval(() => {

const agora = Date.now();

if (agora - ultimaAtividade > 5 * 60 * 1000) {

console.log("⚠️ bot travado, reiniciando...");

process.exit(1);
}

}, 60000);

client.initialize();
