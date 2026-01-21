require('dotenv').config();
const axios = require('axios');
const RSI = require('technicalindicators').RSI;
const SMA = require('technicalindicators').SMA;
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'users.json');
let userDatabase = {}; // { chatId: { id, username, preferences: [] } }

// Cargar usuarios al inicio
function loadUsers() {
    if (fs.existsSync(USERS_FILE)) {
        try {
            const data = fs.readFileSync(USERS_FILE, 'utf8');
            const users = JSON.parse(data);

            if (Array.isArray(users)) {
                // Migración de formato viejo (Array de IDs) a nuevo formato (Objeto)
                users.forEach(id => {
                    const idStr = String(id);
                    userDatabase[idStr] = {
                        id: idStr,
                        username: 'Usuario',
                        preferences: [] // Por defecto solo alertas generales
                    };
                });
                // Guardar migración
                fs.writeFileSync(USERS_FILE, JSON.stringify(userDatabase, null, 2));
                console.log(`♻️ Migrados ${Object.keys(userDatabase).length} usuarios al nuevo formato.`);
            } else if (typeof users === 'object') {
                userDatabase = users;
                console.log(`👥 Usuarios cargados: ${Object.keys(userDatabase).length}`);
            }
        } catch (e) {
            console.error('Error cargando users.json:', e);
        }
    }
}

function saveUser(chatId, username = 'Usuario') {
    const idStr = String(chatId);
    let changed = false;

    if (!userDatabase[idStr]) {
        userDatabase[idStr] = {
            id: idStr,
            username: username || 'Usuario',
            preferences: []
        };
        changed = true;
    } else if (username && userDatabase[idStr].username !== username && username !== 'Usuario') {
        userDatabase[idStr].username = username;
        changed = true;
    }

    if (changed) {
        try {
            fs.writeFileSync(USERS_FILE, JSON.stringify(userDatabase, null, 2));
            console.log(`✅ Usuario actualizado/guardado: ${idStr} (${username})`);
        } catch (e) {
            console.error('Error guardando users.json:', e);
        }
    }
}

loadUsers();

// --- 1. CONFIGURACIÓN DINÁMICA ---
const SYMBOLS = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', // Large Caps
    'DOGEUSDT', 'AVAXUSDT', 'ADAUSDT', 'TRXUSDT', // Mid Caps
    'RENDERUSDT', 'NEARUSDT', 'WLDUSDT', 'SUIUSDT' // Small Caps
];

const CATEGORIES = {
    'Large Caps': ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'],
    'Mid Caps': ['DOGEUSDT', 'AVAXUSDT', 'ADAUSDT', 'TRXUSDT'],
    'Small Caps': ['RENDERUSDT', 'NEARUSDT', 'WLDUSDT', 'SUIUSDT']
};

const INTERVALS = ['2h'];
const CHECK_INTERVAL_MS = 60000;
const REQUEST_DELAY_MS = 250;

const app = express();
app.use(express.json()); // Necesario para parsear body JSON
const PORT = process.env.PORT || 3000;

// Servir archivos estáticos (para el icono)
app.use(express.static(__dirname));

// Configuración Telegram Bot
const token = process.env.TELEGRAM_TOKEN;
let bot = null;
if (token && token !== 'your_telegram_bot_token_here') {
    bot = new TelegramBot(token, { polling: true });
    console.log('Telegram Bot iniciado con polling.');
} else {
    console.warn('TELEGRAM_TOKEN no configurado. El bot no funcionará.');
}

const TARGET_GROUP_ID = process.env.TELEGRAM_REPORT_GROUP_ID || '-1003055730763';
const THREAD_ID = process.env.TELEGRAM_THREAD_ID || '15766';

let estadoAlertas = {};
let history = [];
let terrainAlertsTracker = {
    'LONG': [], // { symbol, timestamp }
    'SHORT': [],
    lastConsolidatedAlert: { 'LONG': 0, 'SHORT': 0 }
};
let waitingForNickname = new Set(); // IDs de usuarios a los que les pedimos apodo
let marketSummary = {
    rocketAngle: -90,
    rocketColor: 'rgb(156, 163, 175)',
    dominantState: 'Calculando...',
    terrainNote: 'Indecisión (No operar)',
    saturation: 0,
    opacity: 0.5,
    fireIntensity: 0
};

// --- 2. LÓGICA DE DATOS (Binance API) ---
async function fetchData(symbol, interval, limit = 100) {
    try {
        const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const response = await axios.get(url);
        const closes = response.data.map(k => parseFloat(k[4]));
        const closeTimes = response.data.map(k => k[6]);
        return { closes, closeTimes };
    } catch (error) {
        console.error(`Error fetching data for ${symbol} ${interval}:`, error.message);
        return null;
    }
}

// --- 3. MOTOR MATEMÁTICO ---
function calcularIndicadores(closes) {
    if (!closes || closes.length < 50) return null;

    // RSI de 20 períodos
    const rsiInput = { values: closes, period: 20 };
    const rsiValues = RSI.calculate(rsiInput);

    if (rsiValues.length < 20) return null;

    // RSI Suavizado: SMA de 20 sobre el RSI
    const smaInput = { period: 20, values: rsiValues };
    const rsiSuavizadoValues = SMA.calculate(smaInput);

    if (rsiSuavizadoValues.length < 15) return null;

    const currentRsiSuavizado = rsiSuavizadoValues[rsiSuavizadoValues.length - 1];
    const prevRsiSuavizado = rsiSuavizadoValues[rsiSuavizadoValues.length - 2];
    const tangente = currentRsiSuavizado - prevRsiSuavizado;

    // Análisis de Curvatura (Últimos 10 periodos)
    const recentValues = rsiSuavizadoValues.slice(-11, -1);
    let increasingCount = 0;
    let decreasingCount = 0;
    for (let i = 1; i < recentValues.length; i++) {
        if (recentValues[i] > recentValues[i - 1]) increasingCount++;
        if (recentValues[i] < recentValues[i - 1]) decreasingCount++;
    }

    let curveTrend = 'NEUTRAL';
    const threshold = recentValues.length - 1;
    if (decreasingCount >= threshold * 0.9) curveTrend = 'DOWN';
    else if (increasingCount >= threshold * 0.9) curveTrend = 'UP';

    // RSI 22 (Para referencia visual si se necesita, aunque no se usa en lógica crítica aquí)
    const rsi22Values = RSI.calculate({ values: closes, period: 22 });
    // const currentRsi22 = rsi22Values.length > 0 ? rsi22Values[rsi22Values.length - 1] : 0;

    return {
        rsiSuavizado: currentRsiSuavizado,
        tangente: tangente,
        curveTrend: curveTrend,
        currentPrice: closes[closes.length - 1]
    };
}

// Helper para determinar Estado y Emojis
function obtenerEstado(tangente, curveTrend, symbol) {
    if (tangente > 1) return { text: "LONG en euforia, no buscar SHORT", emoji: "🚀", color: "text-purple-400", weight: -10 };
    if (tangente > 0.10) return { text: "LONG en curso...", emoji: "🟢", color: "text-green-400", weight: -5 };

    if (tangente < -1) return { text: "SHORT en euforia, no buscar LONG", emoji: "🩸", color: "text-red-500", weight: 10 };
    if (tangente < -0.10) return { text: "SHORT en curso...", emoji: "🔴", color: "text-red-400", weight: 5 };

    // Rango -0.10 a 0.10
    if (curveTrend === 'DOWN') {
        trackTerrain('LONG', symbol);
        return { text: "En terreno de LONG", emoji: "🍏", color: "text-lime-400", weight: 0, terrain: 'LONG' };
    }
    if (curveTrend === 'UP') {
        trackTerrain('SHORT', symbol);
        return { text: "En terreno de SHORT", emoji: "🍎", color: "text-orange-400", weight: 0, terrain: 'SHORT' };
    }

    return { text: "Indecisión (No operar)", emoji: "🦀", color: "text-gray-400", weight: 0 };
}

function trackTerrain(type, symbol) {
    const now = Date.now();
    const list = terrainAlertsTracker[type];

    // Check if already tracking this symbol for this type in the last hour
    const existing = list.find(item => item.symbol === symbol);
    if (existing) {
        existing.timestamp = now; // Update timestamp to keep it alive
    } else {
        list.push({ symbol, timestamp: now });
    }
}

function evaluarAlertas(symbol, interval, indicadores, lastCandleTime) {
    const { tangente, curveTrend } = indicadores;
    let signal = null;

    if (tangente >= -0.10 && tangente <= 0.10) {
        if (curveTrend === 'DOWN') signal = 'LONG';
        else if (curveTrend === 'UP') signal = 'SHORT';
    }

    if (!signal) return null;

    const key = `${symbol}_${interval}`;
    const estadoPrevio = estadoAlertas[key] || {};

    // Evitar repetición en la misma vela
    if (estadoPrevio.lastAlertSignal === signal && estadoPrevio.lastCandleTime === lastCandleTime) {
        return null;
    }

    estadoAlertas[key] = {
        lastAlertSignal: signal,
        lastCandleTime: lastCandleTime
    };

    return signal;
}


// --- 4. TELEGRAM BOT LOGIC ---

// Enviar Mensaje (Broadcast + Thread ID específico + Usuarios Suscritos)
async function enviarTelegram(message, symbol = null) {
    if (!bot) return;

    // 1. Obtener IDs del .env (TELEGRAM_CHAT_ID puede ser una lista separada por comas)
    const rawChatIds = process.env.TELEGRAM_CHAT_ID || '';
    const envIds = rawChatIds.split(',').map(id => id.trim()).filter(id => id);

    // 2. Filtrar usuarios según preferencias si hay un símbolo específico
    const filteredSubscribers = [];
    for (const chatId in userDatabase) {
        const user = userDatabase[chatId];
        // Si no hay símbolo (alerta general), o el usuario tiene el símbolo en sus preferencias
        if (!symbol || (user.preferences && user.preferences.includes(symbol))) {
            filteredSubscribers.push(chatId);
        }
    }

    // 3. Combinar con IDs de ENV y el grupo objetivo (estos siempre reciben TODO)
    const allRecipients = new Set([...envIds, ...filteredSubscribers, TARGET_GROUP_ID]);

    console.log(`📢 Enviando difusión a ${allRecipients.size} destinatarios (Símbolo: ${symbol || 'GENERAL'})`);

    const sentMessages = [];

    for (const chatId of allRecipients) {
        try {
            const options = {};
            if (String(chatId).trim() === String(TARGET_GROUP_ID).trim() && THREAD_ID) {
                options.message_thread_id = parseInt(THREAD_ID);
            }

            const sentMsg = await bot.sendMessage(chatId, message, options);
            sentMessages.push({
                chatId: chatId,
                messageId: sentMsg.message_id
            });

        } catch (error) {
            console.error(`❌ ERROR enviando a ${chatId}:`, error.message);
        }
    }
    return sentMessages;
}

// --- 4. TELEGRAM BOT LOGIC & SIMULATION HELPERS ---

// Helper para simular señales (limpieza y reutilización)
async function simulateSignalEffect(symbol, type, options = {}) {
    const sUpper = symbol.toUpperCase();
    const tUpper = type.toUpperCase();
    const interval = '2h';
    let text = "Desconocido", emoji = "❓", tangente = 0, curveTrend = 'NEUTRAL';

    if (tUpper.includes('LONG')) {
        tangente = tUpper.includes('EUPHORIA') ? 1.5 : 0.05;
        curveTrend = 'DOWN';
        text = tUpper.includes('EUPHORIA') ? "LONG en euforia, no buscar SHORT" : "En terreno de LONG";
        emoji = tUpper.includes('EUPHORIA') ? "🚀" : "🍏";
    } else if (tUpper.includes('SHORT')) {
        tangente = tUpper.includes('EUPHORIA') ? -1.5 : -0.05;
        curveTrend = 'UP';
        text = tUpper.includes('EUPHORIA') ? "SHORT en euforia, no buscar LONG" : "En terreno de SHORT";
        emoji = tUpper.includes('EUPHORIA') ? "🩸" : "�";
    }

    if (options.trackTerrain) trackTerrain(tUpper.includes('LONG') ? 'LONG' : 'SHORT', sUpper);

    if (options.updatePanel) {
        marketSummary.rocketAngle = tUpper.includes('LONG') ? (tUpper.includes('EUPHORIA') ? -90 : -45) : (tUpper.includes('EUPHORIA') ? 90 : 45);
        marketSummary.dominantState = text;
        marketSummary.rocketColor = tUpper.includes('LONG') ? "rgb(74, 222, 128)" : "rgb(248, 113, 113)";
        marketSummary.fireIntensity = tUpper.includes('LONG') ? (tUpper.includes('EUPHORIA') ? 1 : 0.8) : 0;
        marketSummary.opacity = tUpper.includes('LONG') ? 1 : 0.6;
        marketSummary.saturation = tUpper.includes('LONG') ? 1 : 0.4;
    }

    const message = `🚀 ALERTA DITOX (SIMULACRO)\n\n💎 ${sUpper}\n\n⏱ Temporalidad: ${interval}\n📈 Estado: ${text} ${emoji}`;
    const sentMessages = await enviarTelegram(message, sUpper);

    history.unshift({
        time: new Date().toISOString(),
        symbol: sUpper, interval, signal: tUpper.includes('LONG') ? 'LONG' : 'SHORT',
        estadoText: text,
        estadoEmoji: emoji,
        tangente,
        sentMessages: sentMessages || [],
        observation: null,
        id: Date.now()
    });
    if (history.length > 20) history.pop();
    return message;
}

// Endpoint de prueba simple
app.get('/test-alert', async (req, res) => {
    await enviarTelegram(`🧪 ALERTA DE PRUEBA\n\nSi ves esto, la conexión con Telegram es correcta.`);
    res.send('Prueba enviada.');
});

// Endpoint GENÉRICO para SIMULAR
app.get('/simulate/:symbol/:type', async (req, res) => {
    const { symbol, type } = req.params;
    await simulateSignalEffect(symbol, type, { updatePanel: true });
    res.send(`Simulacro de ${type} para ${symbol} ejecutado.`);
});

// Escuchar comandos
if (bot) {
    // Comando /start
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        const name = msg.from.username || msg.from.first_name;

        saveUser(chatId, name);

        bot.sendMessage(chatId, `👋 ¡Bienvenido a IndicAlerts Ditox! ${name ? `Hola ${name}.` : ''}\n\nEstás suscrito a las alertas automáticas. Para mejorar tu experiencia, **por favor responde a este mensaje con un apodo o nombre** que prefieras que usemos en el panel.`);
        waitingForNickname.add(chatId);
    });

    bot.onText(/\/reportALL/i, async (msg) => {
        const chatId = msg.chat.id;
        const username = msg.from.username || msg.from.first_name || 'Usuario';
        saveUser(chatId, username);
        const threadId = msg.message_thread_id;
        const dateStr = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit' });

        const reportMsg = `📊 REPORTE GENERAL - ${dateStr}\n\nEstado Dominante: ${marketSummary.dominantState}\n${marketSummary.terrainNote !== "Indecisión (No operar) ⚖️" ? `Tendencia: ${marketSummary.terrainNote}` : ''}\n\nBy Ditox🔥`;

        bot.sendMessage(chatId, reportMsg, { message_thread_id: threadId });
    });

    bot.onText(/\/report(?!\s*ALL\b)(.+)/i, async (msg, match) => {
        const chatId = msg.chat.id;
        const username = msg.from.username || msg.from.first_name || 'Usuario';
        saveUser(chatId, username); // Suscribir automáticamente a quien pida reportes
        const threadId = msg.message_thread_id; // Thread desde donde se pide
        const rawSymbol = match[1].trim().toUpperCase();
        if (rawSymbol === 'ALL') return; // Salvaguarda extra

        // Mapeo básico o intento directo
        // Si escribe /reportBTC -> BTC, luego buscamos BTCUSDT
        // Si escribe /reportRNDR -> RNDR -> RENDERUSDT
        // Si ya escribe USDT, lo dejamos.

        let symbol = rawSymbol;
        if (!symbol.includes('USDT')) {
            if (symbol === 'RNDR') symbol = 'RENDERUSDT';
            else symbol += 'USDT';
        }

        if (!SYMBOLS.includes(symbol)) {
            // Intentar responder error? O ignorar.
            // Mejor responder para feedback
            bot.sendMessage(chatId, `⚠️ Símbolo no monitoreado: ${symbol}`, { message_thread_id: threadId });
            return;
        }

        bot.sendMessage(chatId, `🔍 Analizando ${symbol}...`, { message_thread_id: threadId });

        // Ejecutar análisis (siempre 2h según requerimiento)
        const interval = '2h';
        const marketData = await fetchData(symbol, interval, 100);

        if (marketData) {
            const indicadores = calcularIndicadores(marketData.closes);
            if (indicadores) {
                const estadoInfo = obtenerEstado(indicadores.tangente, indicadores.curveTrend);

                const reportMsg = `✍️ REPORTE MANUAL
💎 ${symbol} (${interval})
Precio: $${indicadores.currentPrice}
Estado: ${estadoInfo.text} ${estadoInfo.emoji}`;

                // Responder en el MISMO hilo
                bot.sendMessage(chatId, reportMsg, { message_thread_id: threadId });
            } else {
                bot.sendMessage(chatId, `❌ Error calculando indicadores para ${symbol}`, { message_thread_id: threadId });
            }
        } else {
            bot.sendMessage(chatId, `❌ Error obteniendo datos de ${symbol}`, { message_thread_id: threadId });
        }
    });


    bot.onText(/\/simulate_triple_(long|short)/i, async (msg, match) => {
        const type = match[1].toUpperCase();
        bot.sendMessage(msg.chat.id, `🧪 Iniciando simulación de 3 terrenos de ${type}...`);

        const simSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
        for (const s of simSymbols) {
            await simulateSignalEffect(s, type, { trackTerrain: true });
        }

        await checkConsolidatedAlerts();
        bot.sendMessage(msg.chat.id, `✅ Simulación de ${type} ejecutada.`);
    });

    app.get('/simulate-triple-terrain', async (req, res) => {
        const type = req.query.type?.toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
        const simSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
        for (const s of simSymbols) {
            await simulateSignalEffect(s, type, { trackTerrain: true });
        }
        await checkConsolidatedAlerts();
        res.send(`Simulación de triple terreno de ${type} enviada.`);
    });

    // Comandos de simulación rápida de panel
    bot.onText(/\/simulate_(long|short)_(terrain|euphoria)/i, async (msg, match) => {
        const type = `${match[2].toUpperCase()}_${match[1].toUpperCase()}`;
        await simulateSignalEffect('BTCUSDT', type, { updatePanel: true });
        bot.sendMessage(msg.chat.id, `✅ Panel simulado como ${type}.`);
    });

    // CAPTURA GLOBAL: Guardar ID de CUALQUIER persona que escriba al bot
    bot.on('message', (msg) => {
        if (!msg.chat || !msg.chat.id || msg.text?.startsWith('/')) return;
        const chatId = msg.chat.id;

        if (waitingForNickname.has(chatId)) {
            const nickname = msg.text.trim().substring(0, 20); // Limitar largo
            saveUser(chatId, nickname);
            bot.sendMessage(chatId, `✅ ¡Perfecto! Te hemos guardado como **${nickname}**. Ya puedes recibir alertas y usar comandos como /reportALL.`);
            waitingForNickname.delete(chatId);
            return;
        }

        const username = msg.from ? (msg.from.username || msg.from.first_name) : 'Usuario';
        saveUser(chatId, username);
    });

    console.log('Bot escuchando comandos y capturando usuarios...');
}

// Admin: Enviar mensaje personalizado
app.post('/admin/send-direct-message', async (req, res) => {
    const { password, userId, message } = req.body;
    if (password !== 'awd ') return res.status(403).json({ success: false });

    try {
        await bot.sendMessage(userId, `📩 **MENSAJE DEL ADMINISTRADOR:**\n\n${message}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Endpoint ADMIN para actualizar señal

app.post('/admin/update-signal', async (req, res) => {
    const { password, signalId, observationType } = req.body;

    if (password !== 'awd ') { // Contraseña "awd " con espacio
        return res.status(403).json({ success: false, message: 'Contraseña incorrecta' });
    }

    const signalIndex = history.findIndex(h => h.id == signalId);
    if (signalIndex === -1) {
        return res.status(404).json({ success: false, message: 'Señal no encontrada' });
    }

    const signalEntry = history[signalIndex];

    // Si ya tenía observación, la actualizamos.
    signalEntry.observation = observationType;

    // Reconstruir mensaje original + observación
    // Recalculamos el estadoInfo original basado en tangente almacenada o texto almacenado
    // Para simplificar, usamos el texto guardado en history.

    const obsEmojis = { "Señal dudosa": "🤔", "Señal FALSA": "❌", "Liquidaciones a favor": "💰", "Liquidaciones en contra": "💀" };
    const obsEmoji = obsEmojis[observationType] || "";

    // Reconstruir el mensaje base. NOTA: Esto debe coincidir con el formato original.
    // Como no guardamos el mensaje exacto, lo reconstruimos.
    // Buscamos el emoji del estado original.
    // Esto es un poco hacky si cambió la lógica, pero servirá.

    // MEJORA: Guardar el mensaje base en history o reconstruirlo igual.
    // Reconstrucción:
    const baseMessage = `🚀 ALERTA DITOX

💎 ${signalEntry.symbol}

⏱ Temporalidad: ${signalEntry.interval}
📈 Estado: ${signalEntry.estadoText} ${signalEntry.estadoText.includes('LONG') && signalEntry.tangente > 1 ? '🚀' :
            signalEntry.estadoText.includes('LONG') ? '🟢' :
                signalEntry.estadoText.includes('SHORT') && signalEntry.tangente < -1 ? '🩸' :
                    signalEntry.estadoText.includes('SHORT') ? '🔴' :
                        signalEntry.estadoText.includes('Terreno de LONG') ? '🍏' : '🍎'}
 Observación (by Ditox): ${observationType} ${obsEmoji}`;

    console.log(`📝 Actualizando señal ${signalId} con observación: ${observationType}`);

    // Iterar y editar mensajes
    if (signalEntry.sentMessages && Array.isArray(signalEntry.sentMessages)) {
        for (const msgInfo of signalEntry.sentMessages) {
            try {
                if (bot) {
                    await bot.editMessageText(baseMessage, {
                        chat_id: msgInfo.chatId,
                        message_id: msgInfo.messageId
                    });
                    console.log(`Message updated for chat ${msgInfo.chatId}`);
                }
            } catch (error) {
                console.error(`Failed to edit message for ${msgInfo.chatId}:`, error.message);
            }
        }
    }

    res.json({ success: true, message: 'Observación actualizada y mensajes editados.' });
});

// Admin: Obtener lista de usuarios
app.get('/admin/users', (req, res) => {
    // En un entorno real, validar password aquí también si es necesario
    const userList = Object.values(userDatabase);
    res.json(userList);
});

// Admin: Actualizar preferencias de usuario
app.post('/admin/update-user-prefs', (req, res) => {
    const { password, userId, preferences } = req.body;
    if (password !== 'awd ') return res.status(403).json({ success: false });

    if (userDatabase[userId]) {
        userDatabase[userId].preferences = preferences;
        fs.writeFileSync(USERS_FILE, JSON.stringify(userDatabase, null, 2));
        return res.json({ success: true });
    }
    res.status(404).json({ success: false });
});

// Admin: Eliminar usuario
app.post('/admin/delete-user', (req, res) => {
    const { password, userId } = req.body;
    if (password !== 'awd ') return res.status(403).json({ success: false });

    if (userDatabase[userId]) {
        delete userDatabase[userId];
        fs.writeFileSync(USERS_FILE, JSON.stringify(userDatabase, null, 2));
        return res.json({ success: true });
    }
    res.status(404).json({ success: false });
});

// Admin: Simular alerta general para un usuario específico
app.post('/admin/simulate-user-alert', async (req, res) => {
    const { password, userId } = req.body;
    if (password !== 'awd ') return res.status(403).json({ success: false });

    const user = userDatabase[userId];
    if (user) {
        const msg = `🧪 SIMULACRO DE ALERTA GENERAL\n\nHola ${user.username}, esto es una prueba del sistema de alertas generales.`;
        try {
            await bot.sendMessage(userId, msg);
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ success: false, message: e.message });
        }
    }
    res.status(404).json({ success: false });
});


// --- 5. BUCLE PRINCIPAL ---
async function procesarMercado() {
    console.log(`[${new Date().toLocaleTimeString()}] Escaneando...`);

    let totalWeight = 0;
    let longTerrainCount = 0;
    let shortTerrainCount = 0;

    // Limpiar trackings viejos (>1h)
    const now = Date.now();
    const oneHour = 3600000;
    terrainAlertsTracker.LONG = terrainAlertsTracker.LONG.filter(t => now - t.timestamp < oneHour);
    terrainAlertsTracker.SHORT = terrainAlertsTracker.SHORT.filter(t => now - t.timestamp < oneHour);

    for (const symbol of SYMBOLS) {
        for (const interval of INTERVALS) {
            await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));

            const marketData = await fetchData(symbol, interval);
            if (!marketData) continue;

            const { closes, closeTimes } = marketData;
            const indicadores = calcularIndicadores(closes);
            if (!indicadores) continue;

            const lastCandleTime = closeTimes[closeTimes.length - 1];
            const estadoInfo = obtenerEstado(indicadores.tangente, indicadores.curveTrend, symbol);

            // Resumen de mercado
            totalWeight += estadoInfo.weight || 0;
            if (estadoInfo.terrain === 'LONG') longTerrainCount++;
            if (estadoInfo.terrain === 'SHORT') shortTerrainCount++;

            const key = `${symbol}_${interval}`;
            if (!estadoAlertas[key]) estadoAlertas[key] = {};
            estadoAlertas[key].currentStateText = estadoInfo.text;
            estadoAlertas[key].currentStateEmoji = estadoInfo.emoji;
            estadoAlertas[key].currentPrice = indicadores.currentPrice;
            estadoAlertas[key].tangente = indicadores.tangente;

            const signal = evaluarAlertas(symbol, interval, indicadores, lastCandleTime);

            if (signal) {
                const message = `🚀 ALERTA DITOX\n\n💎 ${symbol}\n\n⏱ Temporalidad: ${interval}\n📈 Estado: ${estadoInfo.text} ${estadoInfo.emoji}`;
                const sentMessages = await enviarTelegram(message, symbol);

                history.unshift({
                    time: new Date().toISOString(),
                    symbol, interval, signal,
                    estadoText: estadoInfo.text,
                    estadoEmoji: estadoInfo.emoji,
                    tangente: indicadores.tangente,
                    sentMessages: sentMessages || [],
                    observation: null,
                    id: Date.now()
                });
                if (history.length > 20) history.pop();
            }
        }
    }

    // Calcular Resumen
    const maxPossibleWeight = SYMBOLS.length * 10;
    marketSummary.rocketAngle = (totalWeight / maxPossibleWeight) * 90;

    // Color cohete
    if (longTerrainCount > 0 || shortTerrainCount > 0) {
        const totalTerrain = longTerrainCount + shortTerrainCount;
        const greenRatio = longTerrainCount / totalTerrain;
        const red = Math.floor(255 * (1 - greenRatio));
        const green = Math.floor(255 * greenRatio);
        marketSummary.rocketColor = `rgb(${red}, ${green}, 0)`;
        marketSummary.terrainNote = longTerrainCount >= shortTerrainCount ? "En terreno de LONG 🚀" : "En terreno de SHORT 🔻";
    } else {
        marketSummary.rocketColor = 'rgb(156, 163, 175)'; // Gray
        marketSummary.terrainNote = "Indecisión (No operar) ⚖️";
    }

    // --- Lógica Avanzada del Cohete (Reversada según usuario) ---
    const val = marketSummary.rocketAngle;

    // Fuego (Bullish < -15) - AHORA EN LA ZONA VERDE
    if (val <= -15) {
        marketSummary.fireIntensity = (val - (-15)) / ((-90) - (-15));
    } else {
        marketSummary.fireIntensity = 0;
    }

    // Saturation y Opacidad (Bearish > 15) - AHORA EN LA ZONA ROJA
    if (val >= 15) {
        const factor = (val - 90) / (15 - 90);
        marketSummary.saturation = factor;
        marketSummary.opacity = 0.4 + (factor * 0.6);
    } else {
        marketSummary.saturation = 1;
        marketSummary.opacity = 1;
    }

    // --- Mapeo de Estado Dominante (Mega Título) y Color Dinámico ---
    if (marketSummary.terrainNote && marketSummary.terrainNote !== "Indecisión (No operar) ⚖️") {
        marketSummary.dominantState = marketSummary.terrainNote;
    } else {
        if (val >= 45) marketSummary.dominantState = "SHORT en Euforia 🔻💀";
        else if (val > 15) marketSummary.dominantState = "Short en curso... 📉";
        else if (val <= -45) marketSummary.dominantState = "LONG en Euforia 🚀🔥";
        else if (val < -15) marketSummary.dominantState = "Long en curso... 📈";
        else marketSummary.dominantState = "Indecisión ⚖️";
    }

    // Calcular Color Dinámico (Interpolación RGB)
    // Gris: (156, 163, 175)
    // Verde: (74, 222, 128) -> Usar para val < 0
    // Rojo: (248, 113, 113) -> Usar para val > 0
    const startColor = [156, 163, 175];
    const targetColor = val < 0 ? [74, 222, 128] : [248, 113, 113];
    const absVal = Math.min(Math.abs(val) / 90, 1);

    const r = Math.floor(startColor[0] + (targetColor[0] - startColor[0]) * absVal);
    const g = Math.floor(startColor[1] + (targetColor[1] - startColor[1]) * absVal);
    const b = Math.floor(startColor[2] + (targetColor[2] - startColor[2]) * absVal);
    marketSummary.rocketColor = `rgb(${r}, ${g}, ${b})`;

    // Alertas Consolidadas
    await checkConsolidatedAlerts();
}

async function checkConsolidatedAlerts() {
    const now = Date.now();
    const oneHour = 3600000;

    for (const type of ['LONG', 'SHORT']) {
        const hits = terrainAlertsTracker[type];
        if (hits.length >= 3) {
            if (now - terrainAlertsTracker.lastConsolidatedAlert[type] > oneHour) {
                const dominantPairs = hits.map(h => h.symbol.replace('USDT', '')).join(', ');
                const dateStr = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit' });

                const message = `🚨 ALERTA DE MERCADO DITOX - ${dateStr}\n\nEn terreno de ${type},\nA TRADEAR! 🚀🔥\n\nDominantes: ${dominantPairs}`;

                await enviarTelegram(message);
                terrainAlertsTracker.lastConsolidatedAlert[type] = now;
            }
        }
    }
}

setInterval(procesarMercado, CHECK_INTERVAL_MS);
procesarMercado();


// --- 6. DASHBOARD FRONTEND ---
app.get('/', (req, res) => {
    const generateCards = (symbols) => symbols.map(s => {
        const i = '2h';
        const key = `${s}_${i}`;
        const estado = estadoAlertas[key] || {};
        const price = estado.currentPrice ? `$${estado.currentPrice}` : 'Cargando...';
        const statusText = estado.currentStateText || 'Esperando datos...';
        const statusEmoji = estado.currentStateEmoji || '⏳';

        return `
            <div data-symbol="${s}" data-price="${price}" data-status="${statusText} ${statusEmoji}" 
                 class="crypto-card relative overflow-hidden bg-gray-800/50 backdrop-blur-md p-6 rounded-2xl border border-gray-700/50 hover:border-blue-500/50 transition-all duration-300 group">
                <div class="absolute inset-0 bg-gradient-to-br from-blue-500/10 to-purple-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                
                <div class="relative z-10 flex justify-between items-start mb-4">
                    <div>
                        <h3 class="text-2xl font-bold text-white tracking-tight">${s} <span class="text-xs font-mono text-blue-400 bg-blue-900/30 px-2 py-1 rounded ml-2">2H</span></h3>
                        <p class="text-gray-400 text-sm font-light mt-1">${price}</p>
                    </div>
                    <div class="text-3xl filter drop-shadow-lg animate-pulse-slow">${statusEmoji}</div>
                </div>
                
                <div class="relative z-10 mb-6">
                    <p class="text-sm font-medium text-gray-300">${statusText}</p>
                </div>

                <button onclick="openReviewModal('${s}', '${price}', '${statusText}', '${statusEmoji}')" 
                    class="relative z-10 w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-semibold py-2 px-4 rounded-xl shadow-lg hover:shadow-blue-500/30 transition-all duration-300 transform hover:-translate-y-0.5 active:translate-y-0 text-sm">
                    Revisar
                </button>
            </div>
         `;
    }).join('');

    const largeCapsHtml = generateCards(CATEGORIES['Large Caps']);
    const midCapsHtml = generateCards(CATEGORIES['Mid Caps']);
    const smallCapsHtml = generateCards(CATEGORIES['Small Caps']);

    const historyRows = history.map(h => {
        const obs = h.observation ? `<span class="block text-xs text-yellow-400 mt-1">📝 ${h.observation}</span>` : '';
        const adminControls = `
            <div class="ditox-admin hidden mt-2">
                <select id="obs-select-${h.id}" class="bg-gray-700 text-xs text-white p-1 rounded mb-1 w-full">
                    <option value="">Seleccionar Observación...</option>
                    <option value="Señal dudosa">Señal dudosa</option>
                    <option value="Señal FALSA">Señal FALSA</option>
                    <option value="Liquidaciones a favor de la señal">Liquidaciones a favor</option>
                    <option value="Liquidaciones en contra de la señal">Liquidaciones en contra</option>
                </select>
                <button onclick="updateSignal('${h.id}')" class="bg-blue-600 hover:bg-blue-500 text-white text-xs px-2 py-1 rounded w-full">
                    Actualizar Reporte
                </button>
            </div>
        `;

        return `
        <tr class="border-b border-gray-700/50 hover:bg-white/5 transition-colors">
            <td class="py-4 px-6 text-gray-400 font-mono text-xs">${new Date(h.time).toLocaleTimeString()}</td>
            <td class="py-4 px-6 text-blue-300 font-bold">${h.symbol}</td>
            <td class="py-4 px-6 text-gray-400 text-xs">${h.interval}</td>
            <td class="py-4 px-6">
                <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${h.signal === 'LONG' ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'}">
                    ${h.estadoText}
                </span>
                ${obs}
            </td>
            <td class="py-4 px-6 text-gray-300 font-mono text-sm">
                ${h.tangente.toFixed(4)}
                <!-- Columna "Observación (by Ditox)" está integrada visualmente aquí o en una nueva columna si se prefiere. 
                     El usuario pidió "exactamente en una última columna". Vamos a agregar esa columna en el thead y aquí. -->
            </td>
            <td class="py-4 px-6 text-gray-400 text-xs ditox-column hidden">
                ${h.observation || 'Ninguna'}
                ${adminControls}
            </td>
        </tr>
    `}).join('');

    const html = `
<!DOCTYPE html>
<html lang="es" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IndicAlerts | Ditox OS</title>
    <link rel="icon" type="image/jpeg" href="/icono_ditox10.jpeg">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    fontFamily: { sans: ['Outfit', 'sans-serif'] },
                    animation: { 'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite' }
                }
            }
        }
    </script>
    <style>
        body { background: #0f111a; background-image: radial-gradient(circle at 15% 50%, rgba(76, 29, 149, 0.1), transparent 25%), radial-gradient(circle at 85% 30%, rgba(37, 99, 235, 0.1), transparent 25%); }
        dialog::backdrop { background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(4px); }
        dialog[open] { animation: zoomIn 0.2s ease-out; }
        @keyframes zoomIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
        /* Scrollbar custom */
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #1f2937; }
        ::-webkit-scrollbar-thumb { background: #4b5563; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #6b7280; }

        /* Rocket Gauge Styles */
        .gauge-container { position: relative; width: 250px; height: 440px; overflow: hidden; border-left: 4px solid #334155; margin: 0 auto; }
        .gauge-arc { position: absolute; width: 440px; height: 440px; border-radius: 50%; left: -220px; background: conic-gradient(from 0deg, #4ade80 0deg, #facc15 90deg, #f87171 180deg); -webkit-mask: radial-gradient(circle, transparent 64%, black 65%); mask: radial-gradient(circle, transparent 64%, black 65%); }
        .rocket-pivot { position: absolute; top: 50%; left: 0; width: 200px; height: 2px; transform-origin: left center; transition: transform 0.8s cubic-bezier(0.34, 1.56, 0.64, 1); animation: oscillate 3s infinite ease-in-out; }
        .rocket-wrapper { position: absolute; right: 0; top: 50%; transform: translateY(-50%) rotate(45deg); display: flex; align-items: center; justify-content: center; transition: filter 0.5s ease-out; }
        .rocket { font-size: 5rem; z-index: 2; user-select: none; }
        .rocket-wrapper::after { content: "🔥"; position: absolute; font-size: 2rem; bottom: -18px; left: -18px; transform: rotate(45deg) scale(var(--fire-scale)); opacity: var(--fire-opacity); filter: blur(0.5px); animation: flicker 0.1s infinite alternate; z-index: 1; }
        
        /* Animations */
        @keyframes flicker { from { transform: rotate(45deg) scale(calc(var(--fire-scale) * 0.9)); } to { transform: rotate(45deg) scale(calc(var(--fire-scale) * 1.1)) translateY(2px); } }
        @keyframes oscillate { 0%, 100% { transform: translateY(-50%) translateY(0px) rotate(var(--rot-base)); } 50% { transform: translateY(-50%) translateY(5px) rotate(calc(var(--rot-base) + 2deg)); } }
        @keyframes breathing { 0%, 100% { opacity: 1; } 50% { opacity: 0.75; } }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }

        .animate-fadeInUp { animation: fadeInUp 0.8s ease-out forwards; }
        .animate-breathing { animation: breathing 3s infinite ease-in-out; }
    </style>
</head>
<body class="text-gray-200 min-h-screen p-4 md:p-8">

    <div class="max-w-7xl mx-auto animate-fadeInUp">
        <!-- Header -->
        <header class="mb-12 flex flex-col md:flex-row justify-between items-center gap-4">
            <div class="flex items-center gap-3">
                <div class="p-3 bg-blue-600/20 rounded-xl border border-blue-500/30">
                    <span class="text-3xl">🚀</span>
                </div>
                <div>
                    <h1 class="text-4xl font-bold text-white tracking-tight">IndicAlerts <span class="text-blue-500">Ditox</span></h1>
                    <p class="text-gray-400 text-sm">Sistema de Monitoreo según RSI22 Suavizado</p>
                </div>
            </div>
            
            <div class="flex items-center gap-4">
                <button onclick="document.getElementById('modal-info').showModal()" class="text-sm text-gray-400 hover:text-white transition-colors">¿Qué es?</button>
                <div class="h-4 w-px bg-gray-700"></div>
                <button onclick="document.getElementById('modal-alert').showModal()" class="text-sm text-red-400 hover:text-red-300 transition-colors">⚠️ Disclaimer</button>
                <div class="h-4 w-px bg-gray-700"></div>
                <button onclick="toggleDitoxMode()" class="text-sm text-purple-400 hover:text-purple-300 transition-colors bg-purple-900/20 px-3 py-1 rounded border border-purple-500/20">Soy Ditox</button>
            </div>
        </header>

        <!-- Mercado Summary Section -->
        <section class="mb-16 bg-gray-800/30 backdrop-blur-lg rounded-3xl border border-gray-700/50 p-8">
            <h2 class="text-2xl font-bold text-white mb-8 border-b border-gray-700 pb-4 uppercase">Resumen del Mercado</h2>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
                <!-- Left: Advanced Rocket Gauge -->
                <div class="flex flex-col items-center">
                    <h3 class="text-lg font-semibold text-gray-400 mb-8">¿Hacia dónde vamos?</h3>
                    <div class="gauge-container" style="--fire-scale: ${marketSummary.fireIntensity * 1.4}; --fire-opacity: ${marketSummary.fireIntensity};">
                        <div class="gauge-arc"></div>
                        <div class="rocket-pivot" style="--rot-base: ${marketSummary.rocketAngle}deg; transform: translateY(-50%) rotate(${marketSummary.rocketAngle}deg);">
                            <div class="rocket-wrapper" style="filter: grayscale(${1 - marketSummary.saturation}) opacity(${marketSummary.opacity});">
                                <div class="rocket">🚀</div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Right: Mega State -->
                <div class="text-center md:text-left">
                    <p class="text-gray-400 text-sm uppercase tracking-widest mb-2 font-semibold">Estado Dominante</p>
                    <h2 class="text-5xl md:text-6xl font-black tracking-tighter leading-none transition-all duration-100 animate-breathing" 
                        style="color: ${marketSummary.rocketColor}">
                        ${marketSummary.dominantState.toUpperCase()}
                    </h2>
                </div>
            </div>
        </section>

        <!-- Stats Grid (Categorized) -->
        <div class="space-y-12 mb-16">
            <section>
                <div class="flex items-center gap-4 mb-6">
                    <h2 class="text-2xl font-bold text-blue-400">Large Caps</h2>
                    <div class="h-px flex-grow bg-gradient-to-r from-blue-500/50 to-transparent"></div>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    ${largeCapsHtml}
                </div>
            </section>

            <section>
                <div class="flex items-center gap-4 mb-6">
                    <h2 class="text-2xl font-bold text-green-400">Mid Caps</h2>
                    <div class="h-px flex-grow bg-gradient-to-r from-green-500/50 to-transparent"></div>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    ${midCapsHtml}
                </div>
            </section>

            <section>
                <div class="flex items-center gap-4 mb-6">
                    <h2 class="text-2xl font-bold text-orange-400">Small Caps</h2>
                    <div class="h-px flex-grow bg-gradient-to-r from-orange-500/50 to-transparent"></div>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    ${smallCapsHtml}
                </div>
            </section>
        </div>

        <!-- Historial -->
        <div class="bg-gray-800/40 backdrop-blur-xl rounded-3xl border border-gray-700/50 overflow-hidden shadow-2xl">
            <div class="p-6 border-b border-gray-700/50 flex justify-between items-center">
                <h2 class="text-xl font-bold text-white">Historial de Señales (Últimas 20)</h2>
                <div class="flex gap-2">
                    <span class="h-3 w-3 rounded-full bg-red-500 block"></span>
                    <span class="h-3 w-3 rounded-full bg-yellow-500 block"></span>
                    <span class="h-3 w-3 rounded-full bg-green-500 block"></span>
                </div>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="bg-gray-900/50 text-gray-400 text-xs uppercase tracking-wider">
                            <th class="py-4 px-6 font-semibold">Hora</th>
                            <th class="py-4 px-6 font-semibold">Par</th>
                            <th class="py-4 px-6 font-semibold">TF</th>
                            <th class="py-4 px-6 font-semibold">Señal / Estado</th>
                            <th class="py-4 px-6 font-semibold">Tangente (RSI22 Suav)</th>
                            <th class="py-4 px-6 font-semibold ditox-column hidden">Observación (by Ditox)</th>
                        </tr>
                    </thead>
                    <tbody class="text-sm divide-y divide-gray-700/50">
                        ${historyRows.length ? historyRows : '<tr><td colspan="6" class="py-8 text-center text-gray-500 italic">Esperando primeras señales del mercado...</td></tr>'}
                    </tbody>
                </table>
            </div>
        </div>

        <!-- Gestión de Usuarios (Ditox Mode Only) -->
        <div class="ditox-admin hidden mt-16 bg-gray-800/40 backdrop-blur-xl rounded-3xl border border-purple-500/30 overflow-hidden shadow-2xl">
            <div class="p-6 border-b border-purple-500/30 flex justify-between items-center bg-purple-900/10">
                <h2 class="text-xl font-bold text-purple-400 flex items-center gap-2">
                    <span>👥</span> Gestión de Usuarios y Alertas Individuales
                </h2>
                <span class="text-xs text-purple-300/50 uppercase tracking-widest">Panel de Control Ditox</span>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="bg-gray-900/50 text-gray-400 text-xs uppercase tracking-wider">
                            <th class="py-4 px-6 font-semibold">ID</th>
                            <th class="py-4 px-6 font-semibold">Usuario</th>
                            <th class="py-4 px-6 font-semibold">Configuración de Alertas (Pares)</th>
                            <th class="py-4 px-6 font-semibold">Acciones</th>
                        </tr>
                    </thead>
                    <tbody id="user-table-body" class="text-sm divide-y divide-gray-700/50">
                        <tr><td colspan="4" class="py-8 text-center text-gray-500">Cargando base de datos de usuarios...</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <!-- Modals -->
    <dialog id="modal-info" class="bg-gray-900 text-white rounded-2xl p-0 w-full max-w-2xl shadow-2xl backdrop:bg-black/80 border border-gray-700">
        <div class="p-8">
            <h3 class="text-2xl font-bold mb-4 text-blue-400">¿Cómo funciona IndicAlert?</h3>
            <div class="space-y-4 text-gray-300 leading-relaxed">
                <p>Todo parte desde el <strong class="text-white">RSI suavizado</strong>, que en pocas palabras, determina la tendencia de la fuerza del mercado.</p>
                <p>Cuando este suavizado es horizontal o plano, IndicAlert notificará porque es un buen momento de buscar una operación.</p>
                <div class="bg-gray-800 p-4 rounded-xl border border-gray-700">
                    <p class="text-sm">🤖 <strong class="text-white">Algoritmo:</strong> Toma los últimos 10 periodos anteriores para determinar si se viene de una fuerza bajista o alcista, determinando un posible LONG o SHORT.</p>
                </div>
                
                <div>
                    <h4 class="font-bold text-white mb-2 text-lg">Significado de los Estados:</h4>
                    <ul class="space-y-3 text-sm">
                        <li class="bg-purple-900/20 p-3 rounded-lg border border-purple-500/30">
                            <strong class="text-purple-400 block mb-1">🚀 En euforia:</strong> 
                            El movimiento tiene mucha fuerza, por lo que buscar una op al sentido contrario tiene bajas probabilidades de salir bien.
                        </li>
                        <li class="bg-blue-900/20 p-3 rounded-lg border border-blue-500/30">
                            <strong class="text-blue-400 block mb-1">⚡ En curso...:</strong> 
                            Ya se está dando el movimiento. Si no entraste, espera a que se calme el mercado. Si estás dentro, ten la confianza en que si se mantiene este estado, puedes estar tranquilo esperando más ganancias.
                        </li>
                        <li class="bg-green-900/20 p-3 rounded-lg border border-green-500/30">
                            <strong class="text-green-400 block mb-1">🍏 En terreno de...:</strong> 
                            El mercado se calmó y probablemente esté a puertas de dar otro movimiento; el movimiento anterior se desaceleró y puede cambiar de dirección.
                        </li>
                        <li class="bg-gray-800/50 p-3 rounded-lg border border-gray-600/30">
                            <strong class="text-gray-400 block mb-1">🦀 Indecisión:</strong>
                            El mercado no habla claro, lo mejor es abstenerse.
                        </li>
                    </ul>
                </div>

                <div>
                    <h4 class="font-bold text-white mb-2 text-lg">Resumen del Mercado y Cohete:</h4>
                    <p class="text-sm mb-3">El cohete central es un indicador dinámico del sentimiento global:</p>
                    <ul class="space-y-2 text-sm text-gray-400">
                        <li class="flex items-start gap-2">
                            <span class="text-white">•</span>
                            <span><strong>Inclinación:</strong> El rango es de 90° (Bajista Extremo) a -90° (Alcista Extremo). Se entra en <strong>Euforia</strong> al superar los 45° en cualquier dirección.</span>
                        </li>
                        <li class="flex items-start gap-2">
                            <span class="text-white">•</span>
                            <span><strong>Color:</strong> Se vuelve más verde mientras más activos estén en "Terreno de LONG" y más rojo en "Terreno de SHORT".</span>
                        </li>
                    </ul>
                </div>

                <div>
                    <h4 class="font-bold text-white mb-1">Alertas Inteligentes:</h4>
                    <p class="text-sm">Para reducir ruido, las alertas de "Terreno de..." ahora se consolidan. Solo recibirás una notificación general cuando al menos <strong class="text-white">3 activos diferentes</strong> entren en dicho terreno en un lapso de 1 hora.</p>
                </div>
            </div>
            <div class="mt-8 text-right">
                <button onclick="this.closest('dialog').close()" class="bg-gray-700 hover:bg-gray-600 text-white px-6 py-2 rounded-lg font-medium transition-colors">Entendido</button>
            </div>
        </div>
    </dialog>

    <dialog id="modal-alert" class="bg-gray-900 text-white rounded-2xl p-0 w-full max-w-lg shadow-2xl backdrop:bg-black/80 border border-red-900/50">
        <div class="p-8 border-l-4 border-red-500">
            <h3 class="text-2xl font-bold mb-4 text-red-500">⚠️ Advertencia de Riesgo</h3>
            <p class="text-gray-300 mb-6 leading-relaxed">
                IndicAlert <strong class="text-white">NO es una herramienta de asesoría financiera</strong> y sus señales no deben tomarse como consejos de inversión segura.
                El mercado de criptomonedas es altamente volátil. Opera bajo tu propio riesgo y realiza siempre tu propio análisis (DYOR).
            </p>
            <div class="text-right">
                <button onclick="this.closest('dialog').close()" class="text-gray-400 hover:text-white text-sm underline">Cerrar</button>
            </div>
        </div>
    </dialog>

    <dialog id="modal-review" class="bg-slate-900 text-white rounded-3xl p-0 w-full max-w-md shadow-2xl border border-blue-500/30">
        <div class="relative overflow-hidden p-8 text-center">
            <div class="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-blue-500 to-purple-600"></div>
            
            <div class="mb-6">
                 <div id="review-emoji" class="text-6xl mb-4 filter drop-shadow-xl animate-bounce"></div>
                 <h3 id="review-symbol" class="text-3xl font-bold text-white mb-1"></h3>
                 <p class="text-blue-400 font-mono text-sm tracking-widest">TIMEFRAME: 2H</p>
            </div>

            <div class="bg-slate-800/50 rounded-2xl p-6 mb-6 border border-slate-700">
                <div class="grid grid-cols-2 gap-4 text-left">
                    <div>
                        <p class="text-xs text-slate-400 uppercase">Precio Actual</p>
                        <p id="review-price" class="text-xl font-mono text-white"></p>
                    </div>
                    <div>
                        <p class="text-xs text-slate-400 uppercase">Estado</p>
                        <p id="review-status" class="text-sm font-bold text-white leading-tight"></p>
                    </div>
                </div>
            </div>

            <button onclick="this.closest('dialog').close()" class="w-full py-3 rounded-xl bg-white text-slate-900 font-bold hover:bg-gray-200 transition-colors">
                Cerrar Vista
            </button>
        </div>
    </dialog>

    <!-- Custom Prompt Modal -->
    <dialog id="modal-prompt" class="bg-gray-900 text-white rounded-3xl p-0 w-full max-w-md shadow-2xl backdrop:bg-black/80 border border-purple-500/30">
        <div class="p-8">
            <h3 id="prompt-title" class="text-2xl font-bold mb-4 bg-gradient-to-r from-purple-400 to-blue-400 bg-clip-text text-transparent"></h3>
            <div class="mb-6">
                <textarea id="prompt-input" class="w-full bg-gray-800/50 border border-gray-700 rounded-2xl p-4 text-sm focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none transition-all placeholder-gray-600" rows="3"></textarea>
            </div>
            <div class="flex justify-end gap-3">
                <button onclick="closePrompt()" class="px-6 py-2 text-sm font-semibold text-gray-400 hover:text-white transition-colors">Cancelar</button>
                <button onclick="handlePromptConfirm()" class="px-8 py-2 bg-gradient-to-r from-purple-600 to-blue-600 rounded-xl text-sm font-bold hover:shadow-[0_0_20px_rgba(168,85,247,0.4)] transition-all transform active:scale-95 text-white">Confirmar</button>
            </div>
        </div>
    </dialog>

    <script>
        // Auto-refresh suave
        setTimeout(() => window.location.reload(), 30000); // 30s para no ser molesto

        function openReviewModal(symbol, price, status, emoji) {
            document.getElementById('review-symbol').textContent = symbol;
            document.getElementById('review-price').textContent = price;
            document.getElementById('review-status').textContent = status;
            document.getElementById('review-emoji').textContent = emoji;
            document.getElementById('modal-review').showModal();
        }

        // --- CUSTOM PROMPT LOGIC ---
        let currentPromptResolver = null;

        function showPrompt(title, placeholder = "", isPassword = false) {
            return new Promise((resolve) => {
                const modal = document.getElementById('modal-prompt');
                document.getElementById('prompt-title').textContent = title;
                const input = document.getElementById('prompt-input');
                input.value = "";
                input.placeholder = placeholder;
                input.type = isPassword ? "password" : "text"; // Aunque sea textarea, type no funciona igual, pero para referencia.
                
                // Hack para password en textarea si fuera necesario, pero mejor textarea para mensajes largos.
                // Si es password, usamos un estilo que oculte o un input separado?
                // Vamos a usar un input type password si es para login.
                
                if (isPassword) {
                    input.style.webkitTextSecurity = "disc";
                } else {
                    input.style.webkitTextSecurity = "none";
                }

                currentPromptResolver = resolve;
                modal.showModal();
                input.focus();
            });
        }

        function handlePromptConfirm() {
            const val = document.getElementById('prompt-input').value;
            document.getElementById('modal-prompt').close();
            if (currentPromptResolver) {
                const res = currentPromptResolver;
                currentPromptResolver = null;
                res(val);
            }
        }

        function closePrompt() {
            document.getElementById('modal-prompt').close();
            if (currentPromptResolver) {
                const res = currentPromptResolver;
                currentPromptResolver = null;
                res(null);
            }
        }

        // --- DITOX ADMIN MODE ---
        async function toggleDitoxMode() {
            const current = localStorage.getItem('isDitox');
            if (current === 'true') {
                // Logout
                localStorage.removeItem('isDitox');
                location.reload();
            } else {
                // Login
                const pwd = await showPrompt("Acceso Administrador", "Introduce la contraseña...");
                if (pwd === "awd ") { // "awd " con espacio
                    localStorage.setItem('isDitox', 'true');
                    location.reload();
                } else if (pwd !== null) {
                    alert("Contraseña incorrecta");
                }
            }
        }

        // Al cargar, verificar modo admin
        document.addEventListener('DOMContentLoaded', () => {
            const isDitox = localStorage.getItem('isDitox') === 'true';
            if (isDitox) {
                // Mostrar columnas y controles ocultos
                document.querySelectorAll('.ditox-column').forEach(el => el.classList.remove('hidden'));
                document.querySelectorAll('.ditox-admin').forEach(el => el.classList.remove('hidden'));
                
                // Cambiar texto de botón
                const btn = document.querySelector('button[onclick="toggleDitoxMode()"]');
                if(btn) {
                    btn.textContent = "Salir Modo Ditox";
                    btn.classList.add("bg-red-900/20", "border-red-500/20");
                }

                // Cargar tabla de usuarios
                loadAdminUserTable();
            }
        });

        async function loadAdminUserTable() {
            try {
                const res = await fetch('/admin/users');
                const users = await res.json();
                const symbols = ${JSON.stringify(SYMBOLS)};
                const container = document.getElementById('user-table-body');
                
                if (!users.length) {
                    container.innerHTML = '<tr><td colspan="4" class="py-8 text-center text-gray-500 italic">No hay usuarios registrados aún.</td></tr>';
                    return;
                }

                container.innerHTML = users.map(user => {
                    const id = user.id;
                    const prefCheckboxes = symbols.map(s => {
                        const isChecked = user.preferences && user.preferences.includes(s);
                        const sClean = s.replace('USDT', '');
                        return \`
                            <label class="inline-flex items-center bg-gray-900/50 px-2 py-1 rounded border border-gray-700 hover:border-blue-500/50 cursor-pointer transition-colors m-1">
                                <input type="checkbox" class="mr-2 accent-blue-500" data-user="\${id}" data-symbol="\${s}" \${isChecked ? 'checked' : ''} onchange="updateUserPref('\${id}')">
                                <span class="text-[10px] font-mono">\${sClean}</span>
                            </label>
                        \`;
                   }).join('');

                    return \`
                        <tr class="hover:bg-purple-500/5 transition-colors">
                            <td class="py-4 px-6 text-gray-500 font-mono text-xs">\${id}</td>
                            <td class="py-4 px-6 font-bold text-gray-200">\${user.username || 'Usuario'}</td>
                            <td class="py-4 px-6 flex flex-wrap max-w-xl">\${prefCheckboxes}</td>
                            <td class="py-4 px-6">
                                <div class="flex flex-col gap-2">
                                    <button onclick="sendDirectMessage('\${id}')" class="bg-purple-600/20 text-purple-400 border border-purple-500/30 px-3 py-1 rounded text-xs hover:bg-purple-600/40 transition-all font-bold">Enviar Mensaje</button>
                                    <button onclick="simulateUserAlert('\${id}')" class="bg-blue-600/20 text-blue-400 border border-blue-500/30 px-3 py-1 rounded text-xs hover:bg-blue-600/40 transition-all font-bold">Simular Gral</button>
                                    <button onclick="deleteUser('\${id}')" class="bg-red-600/20 text-red-400 border border-red-500/30 px-3 py-1 rounded text-xs hover:bg-red-600/40 transition-all">Eliminar</button>
                                </div>
                            </td>
                        </tr>
                    \`;
                }).join('');

            } catch (e) {
                console.error("Error loading user table", e);
            }
        }

        async function updateUserPref(userId) {
            const checkboxes = document.querySelectorAll(\`input[data-user="\${userId}"]\`);
            const prefs = Array.from(checkboxes).filter(c => c.checked).map(c => c.getAttribute('data-symbol'));
            
            try {
                await fetch('/admin/update-user-prefs', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: 'awd ', userId, preferences: prefs })
                });
                console.log("Preferencias actualizadas para " + userId);
            } catch (e) {
                console.error(e);
            }
        }

        async function deleteUser(userId) {
            if (!confirm("¿Seguro que quieres eliminar a este usuario de la base de datos?")) return;
            try {
                const res = await fetch('/admin/delete-user', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: 'awd ', userId })
                });
                if ((await res.json()).success) {
                    loadAdminUserTable();
                }
            } catch (e) { console.error(e); }
        }

        async function simulateUserAlert(userId) {
            try {
                const res = await fetch('/admin/simulate-user-alert', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: 'awd ', userId })
                });
                const data = await res.json();
                if (data.success) alert("Simulación enviada!");
                else alert("Error: " + data.message);
            } catch (e) { console.error(e); }
        }

        async function sendDirectMessage(userId) {
            const msg = await showPrompt("Enviar Mensaje Directo", "Escribe el mensaje para el usuario...");
            if (!msg) return;

            try {
                const res = await fetch('/admin/send-direct-message', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: 'awd ', userId, message: msg })
                });
                const data = await res.json();
                if (data.success) alert("Mensaje enviado exitosamente.");
                else alert("Error: " + data.message);
            } catch (e) { console.error(e); }
        }

        async function updateSignal(id) {
            const select = document.getElementById('obs-select-' + id);
            const val = select.value;
            if (!val) {
                alert("Selecciona una observación primero.");
                return;
            }

            // Confimación eliminada a petición del usuario
            // if (!confirm('¿Actualizar reporte con: "' + val + '"? Esto editará el mensaje de Telegram.')) return;

            try {
                const res = await fetch('/admin/update-signal', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        password: 'awd ', // Enviamos auth
                        signalId: id,
                        observationType: val
                    })
                });
                const data = await res.json();
                if (data.success) {
                    alert("Reporte actualizado exitosamente.");
                    location.reload();
                } else {
                    alert("Error: " + data.message);
                }
            } catch (e) {
                console.error(e);
                alert("Error de red al actualizar.");
            }
        }
    </script>
</body>
</html>
    `;
    res.send(html);
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

// Exportar para tests (si se requiere)
module.exports = {
    calcularIndicadores,
    obtenerEstado,
    evaluarAlertas,
    enviarTelegram,
    app
};
