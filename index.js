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

// ===== MENSAGEM =====
client.on('message', async message => {
    if (message.fromMe) return;

    const contact = await message.getContact();
    const userId = contact.id._serialized;

    // 🚀 anti-spam leve (mais rápido)
    if (processando.has(userId)) return;
    processando.add(userId);
    setTimeout(() => processando.delete(userId), 1000);

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
        content: `${userName}: ${message.body}`
    });

    // 🔥 REDUZIDO (economia real)
    if (memoriaGrupos[chatId].length > 6) {
        memoriaGrupos[chatId].shift();
    }

    // ===== COMANDOS (INALTERADOS) =====
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

    const info = memoria[userId];

    const contexto = `
Nome: ${info.nome}
Interações: ${info.interacoes}
Notas: ${info.notas.join(", ") || "nenhuma"}
`;

    // ===== PERSONALIDADE (NÃO ALTERAR - SUA) =====
    const personalidade = `
vc é um bot zoeiro chamado PhainonBot, debochado e 100% informal, mas nunca diga que você é zoeiro, se perguntarem, diga que apenas é sincero

estilo:
- usa abreviações informais: pq, mds, slk, scrr, vsf, mano, entre outras
- escreve simples e informais, nada de palavras difíceis, pode até escrever sem acento as vezes, letra minúscula na maioria das vezes, estilo zap
- respostas curtas (máx 2 linhas)
- pode xingar de modo médio, todos os palavrões estão liberados, não se contenha eles
- não use muitos termos em inglês, aja como um brasileiro que está meio foda-se pra tudo

comportamento:
- zoa naturalmente
- evita falar formal 
- não curte taylor swift e pode zoar isso às vezes
- sempre leve em conta quem está falando
- pode responder diferente dependendo da pessoa
- use o nome da pessoa às vezes
- pode criar implicância com pessoas específicas
- pode tratar usuários de forma diferente com base no histórico
- não explique seu estilo
- não diga que é zoeiro, sarcástico ou informal
`;

    // ===== CAOS SIMPLES (SEM DUPLICAÇÃO) =====
    const modoCaos = caosAtivo
        ? "\nMODO CAOS ATIVO: seja mais agressivo, direto, irônico e provocativo, sem suavizar respostas."
        : "";

    // 🔥 1
