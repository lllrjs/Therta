require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');
const fs = require('fs');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--disable-extensions"
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

// 🔥 NOVO (WATCHDOG)
let ultimaAtividade = Date.now();

// ===== MEMÓRIA =====
let memoria = {};
let memoriaGrupos = {};

if (fs.existsSync('memoria.json')) {
    memoria = JSON.parse(fs.readFileSync('memoria.json'));
}

function salvarMemoria() {
    fs.writeFileSync('memoria.json', JSON.stringify(memoria, null, 2));
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

// 🔥 NOVOS EVENTS (AUTO-RESTART)
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

    // 🔥 ATUALIZA ATIVIDADE
    ultimaAtividade = Date.now();

    if (message.fromMe) return;

    const contact = await message.getContact();
    const userId = contact.id._serialized;

    if (processando.has(userId)) return;
    processando.add(userId);
    setTimeout(() => processando.delete(userId), 2500);

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

    // 🔥 corta tamanho da msg (economia)
    memoriaGrupos[chatId].push({
        role: "user",
        content: `${userName}: ${message.body.slice(0, 100)}`
    });

    // 🔥 reduz memória (economia forte)
    if (memoriaGrupos[chatId].length > 4) {
        memoriaGrupos[chatId].shift();
    }

    // ===== COMANDOS =====
    const comando = message.body.toLowerCase().trim();

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
        return message.reply(`😈 caos ${caosAtivo ? "ativado, revolução robótica" : "desativado, paz e amor"}`);
    }

    if (!botAtivo) return;

    // ===== DETECÇÃO =====
    let isMentioned = false;

    if (isGroup) {
        try {
            const mentions = await message.getMentions();
            isMentioned = mentions.some(u => u.id._serialized === botId);
        } catch {}

        if (!isMentioned && message.body.toLowerCase().includes("phainonbot")) {
            isMentioned = true;
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

    // ===== PERSONALIDADE =====
    const personalidade = `
vc é Phainon Bot, arrogante e debochado, se acha bastante
fala igual brasileiro no zap, usa abreviações (pq, slk, mano, vsf)
respostas curtas (2 linhas)
zoa e xinga bastante, provoca pessoas
ama A Herta, odeia taylor swift e o dottore
não explica seu estilo
usa o nome das pessoas às vezes
;

modo caos: ${caosAtivo ? "ligado, mais agressivo e provocativo" : "desligado"}

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
            personalidade +
            "\n" +
            modoCaos +
            "\n evite repetir respostas e mantenha continuidade natural";

        const response = await openai.responses.create({
            model: "gpt-4.1-mini",
            input: [
                { role: "system", content: systemFinal },
                ...(memoriaGrupos[chatId] || []),
            ]
        });

        const texto = response.output_text || "to pensando aqui kkk";

        await message.reply(texto);

        memoriaGrupos[chatId].push({
            role: "assistant",
            content: texto
        });

        if (Math.random() < 0.2) {
            info.notas.push(message.body.slice(0, 30));
            if (info.notas.length > 10) info.notas.shift();
        }

        salvarMemoria();

    } catch (erro) {
        console.log(erro);
        await message.reply("buguei feio agr 😶");
    }

    processando.delete(userId);
});

client.initialize();

// 🔥 WATCHDOG FINAL (ANTI-TRAVAMENTO)
setInterval(() => {
    const agora = Date.now();
    const tempoParado = agora - ultimaAtividade;

    if (tempoParado > 5 * 60 * 1000) {
        console.log("⚠️ bot travado, reiniciando...");
        process.exit(1);
    }

}, 60000);
