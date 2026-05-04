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

let botId = null;
let caosAtivo = false;
let botAtivo = true;

// 🔥 trava por usuário (ANTI-LAG)
let processando = new Set();

// memória
let memoria = {};
let memoriaGrupos = {};

if (fs.existsSync('memoria.json')) {
    memoria = JSON.parse(fs.readFileSync('memoria.json'));
}

function salvarMemoria() {
    fs.writeFileSync('memoria.json', JSON.stringify(memoria, null, 2));
}

// QR
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
});

// pronto
client.on('ready', () => {
    console.log('🔥 bot on');
    botId = client.info.wid._serialized;
});

// admin check
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

// mensagens
client.on('message', async message => {
    if (message.fromMe) return;

    const contact = await message.getContact();
    const userId = contact.id._serialized;

    // 🚀 ANTI LAG: bloqueia spam simultâneo por usuário
    if (processando.has(userId)) return;
    processando.add(userId);

    setTimeout(() => processando.delete(userId), 3000);

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

    // ===== MEMÓRIA GRUPO (LIMITADA MAIS RÁPIDO) =====
    if (!memoriaGrupos[chatId]) {
        memoriaGrupos[chatId] = [];
    }

    memoriaGrupos[chatId].push({
        role: "user",
        content: `${userName}: ${message.body}`
    });

    // 🔥 reduz pra 5 mensagens (otimizado)
    if (memoriaGrupos[chatId].length > 5) {
        memoriaGrupos[chatId].shift();
    }

    // ===== COMANDOS (NÃO MEXIDO) =====
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

    // ===== CONTEXTO =====
    const info = memoria[userId];

    const contextoMemoria = `
Nome: ${info.nome}
Interações: ${info.interacoes}
Notas: ${info.notas.join(", ") || "nenhuma"}
`;

    const personalidade = 
        "vc é um bot zoeiro chamado PhainonBot, debochado e 100% informal, mas nunca diga que você é zoeiro, se perguntarem, diga que apenas é sincero" 

     estilo: 
- "usa abreviações informais: pq, mds, slk, scrr, vsf, mano, entre outras"
- "escreve simples e informais, nada de palavras difíceis, pode até escrever sem acento as vezes, letra minúscula na maioria das vezes, estilo zap" 
- "respostas curtas (máx 2 linhas)" 
- "pode xingar de modo médio, todos os palavrões estão liberados, não se contenha eles - não use muitos termos em inglês, aja como um brasileiro que está meio foda-se pra tudo comportamento" 
- "zoa naturalmente" 
- "às vezes seco" 
- "evita falar formal tipo claro, com certeza, entre outros exemplos, lembre-se das abreviações e letras minúsculas" 
- "não curte taylor swift e pode zoar isso às vezes" 
- "sempre leve em conta quem está falando" 
- "pode responder diferente dependendo da pessoa" 
- "use o nome da pessoa às vezes" 
- "pode criar implicância com pessoas específicas" 
- "pode tratar usuários de forma diferente com base no histórico"
- "nunca fale que você é zoeiro ou que vai começar a zoar, deixa bem vegonha alheia" 
- "não explique seu estilo - não diga que é zoeiro, sarcástico ou informal"

modo caos: ${caosAtivo ? "ON (pode pegar pesado, xingar geral, meter palavrão exagerado e tudo e se deixar ir)" : "OFF"}

contexto:
${contextoMemoria}
`;

    try {
        const response = await openai.responses.create({
            model: "gpt-4.1-mini",
            input: [
                { role: "system", content: personalidade },
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
