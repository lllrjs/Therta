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
let memoriaLonga = {};
let topicoAtual = {};

// ===== CARREGAR =====
if (fs.existsSync('memoria.json')) {
    memoria = JSON.parse(fs.readFileSync('memoria.json'));
}

if (fs.existsSync('memoriaLonga.json')) {
    memoriaLonga = JSON.parse(fs.readFileSync('memoriaLonga.json'));
}

// ===== SALVAR =====
function salvarMemoria() {
    fs.writeFileSync('memoria.json', JSON.stringify(memoria, null, 2));
}

function salvarMemoriaLonga() {
    fs.writeFileSync('memoriaLonga.json', JSON.stringify(memoriaLonga, null, 2));
}

// ===== DETECTAR TEMA =====
function detectarTema(texto) {
    return texto.toLowerCase().split(" ").slice(0, 2).join(" ");
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

// ===== ADMIN CHECK =====
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
    if (message.fromMe) return;

    const contact = await message.getContact();
    const userId = contact.id._serialized;

    if (processando.has(userId)) return;
    processando.add(userId);
    setTimeout(() => processando.delete(userId), 2500);

    const isGroup = message.from.endsWith('@g.us');
    const userName = contact.pushname || contact.name || "desconhecido";
    const chatId = message.from;

    // ===== MEMÓRIA USUÁRIO =====
    if (!memoria[userId]) {
        memoria[userId] = {
            nome: userName,
            interacoes: 0,
            notas: []
        };
    }

    memoria[userId].interacoes++;

    // ===== MEMÓRIA GRUPO =====
    if (!memoriaGrupos[chatId]) {
        memoriaGrupos[chatId] = [];
    }

    memoriaGrupos[chatId].push({
        role: "user",
        content: `${userName}: ${message.body}`
    });

    if (memoriaGrupos[chatId].length > 12) {
        memoriaGrupos[chatId].shift();
    }

    // ===== MEMÓRIA LONGA (TEMAS) =====
    if (!memoriaLonga[userId]) {
        memoriaLonga[userId] = {
            temas: {},
            ultimoTema: null
        };
    }

    const tema = detectarTema(message.body);

    if (!memoriaLonga[userId].temas[tema]) {
        memoriaLonga[userId].temas[tema] = 0;
    }

    memoriaLonga[userId].temas[tema]++;
    memoriaLonga[userId].ultimoTema = tema;

    salvarMemoriaLonga();

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

    // ===== CONTEXTO INTELIGENTE =====
    const info = memoria[userId];

    const temasTop = Object.entries(memoriaLonga[userId]?.temas || {})
        .sort((a,b) => b[1] - a[1])
        .slice(0, 5)
        .map(t => t[0])
        .join(" | ");

    const contextoMemoria = `
Nome: ${info.nome}
Interações: ${info.interacoes}

Temas recorrentes:
${temasTop || "nenhum ainda"}

Tema atual: ${memoriaLonga[userId]?.ultimoTema || "nenhum"}

Notas: ${info.notas.join(", ") || "nenhuma"}

Assunto atual do chat: ${topicoAtual[chatId] || "indefinido"}
`;

    topicoAtual[chatId] = message.body.split(" ").slice(0, 3).join(" ");

    // ===== PERSONALIDADE (INALTERADA) =====
    const personalidade = `
vc é um bot zoeiro chamado PhainonBot, debochado e 100% informal, mas nunca diga que você é zoeiro, se perguntarem, diga que apenas é sincero

estilo:
- usa abreviações informais: pq, pqp, vtmnc, mds, slk, scrr, vsf, mano, entre outras
- escreve simples e informais, mas de forma natural e legível
- respostas curtas (máx 2 linhas)
- pode xingar de modo médio
- não use muitos termos em inglês

comportamento:
- zoa naturalmente
- às vezes seco
- evita formalidade
- não curte taylor swift, e zoa isso as vezes
- responde diferente dependendo da pessoa
- usa nome do usuário às vezes
- pode implicar com pessoas
- comportamento baseado no histórico
- nunca diga que é zoeiro

modo caos: ${caosAtivo ? "ligado" : "desligado"}

contexto do usuário:
${contextoMemoria}

evite repetir respostas recentes e mantenha continuidade da conversa. não reinicie assuntos sem necessidade.
`;

    try {
        const response = await openai.responses.create({
            model: "gpt-4.1-mini",
            input: [
                { role: "system", content: personalidade },
                {
                    role: "system",
                    content: "evite repetição e continue conversas naturalmente sem reiniciar tópicos"
                },
                ...memoriaGrupos[chatId],
                {
                    role: "user",
                    content: `${userName}: ${message.body}`
                }
            ]
        });

        const texto = response.output_text;

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
