require('dotenv').config();
const axios = require('axios');
const RSI = require('technicalindicators').RSI;
const SMA = require('technicalindicators').SMA;
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'users.json');
let subscribedUsers = new Set();

// Cargar usuarios al inicio
function loadUsers() {
    if (fs.existsSync(USERS_FILE)) {
        try {
            const data = fs.readFileSync(USERS_FILE, 'utf8');
            const users = JSON.parse(data);
            if (Array.isArray(users)) {
                subscribedUsers = new Set(users);
                console.log(`👥 Usuarios cargados: ${subscribedUsers.size}`);
            }
        } catch (e) {
            console.error('Error cargando users.json:', e);
        }
    }
}

function saveUser(chatId) {
    // Convertir a string para consistencia
    const idStr = String(chatId);
    if (!subscribedUsers.has(idStr)) {
        subscribedUsers.add(idStr);
        try {
            fs.writeFileSync(USERS_FILE, JSON.stringify([...subscribedUsers]));
            console.log(`✅ Nuevo usuario suscrito: ${idStr}`);
        } catch (e) {
            console.error('Error guardando users.json:', e);
        }
    }
}

loadUsers();

// --- 1. CONFIGURACIÓN DINÁMICA ---
const SYMBOLS = [
    'BTCUSDT',
    'ETHUSDT',
    'SOLUSDT',
    'DOGEUSDT',
    'AVAXUSDT',
    'ADAUSDT',
    'RENDERUSDT',
    'NEARUSDT',
    'WLDUSDT' // User mentioned reportRNDR, so RENDERUSDT is likely correct for RNDR symbol mapping
];
const INTERVALS = ['2h']; // Eliminado '1h'
const CHECK_INTERVAL_MS = 60000;
const REQUEST_DELAY_MS = 250;

const app = express();
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

const TARGET_GROUP_ID = '-1003055730763';
const THREAD_ID = process.env.TELEGRAM_THREAD_ID;

let estadoAlertas = {};
let history = [];

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
function obtenerEstado(tangente, curveTrend) {
    if (tangente > 1) return { text: "LONG en euforia, no buscar SHORT", emoji: "🚀", color: "text-purple-400" };
    if (tangente > 0.10) return { text: "LONG en curso...", emoji: "🟢", color: "text-green-400" };

    if (tangente < -1) return { text: "SHORT en euforia, no buscar LONG", emoji: "🩸", color: "text-red-500" };
    if (tangente < -0.10) return { text: "SHORT en curso...", emoji: "🔴", color: "text-red-400" };

    // Rango -0.10 a 0.10
    if (curveTrend === 'DOWN') return { text: "En terreno de LONG", emoji: "🍏", color: "text-lime-400" };
    if (curveTrend === 'UP') return { text: "En terreno de SHORT", emoji: "🍎", color: "text-orange-400" };

    return { text: "En terreno de INDECISIÓN", emoji: "🦀", color: "text-gray-400" };
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
async function enviarTelegram(message) {
    if (!bot) return;

    const rawChatIds = process.env.TELEGRAM_CHAT_ID || '';
    const envIds = rawChatIds.split(',').map(id => id.trim()).filter(id => id);

    // Unificar destinatarios (Env IDs + Usuarios Suscritos)
    // Convertimos todo a string para evitar duplicados por tipo
    const allRecipients = new Set([...envIds, ...subscribedUsers]);

    for (const chatId of allRecipients) {
        try {
            const options = {};
            // Si es el grupo específico, añadir message_thread_id
            if (chatId === TARGET_GROUP_ID && THREAD_ID) {
                options.message_thread_id = parseInt(THREAD_ID);
            }

            await bot.sendMessage(chatId, message, options);
            console.log(`✅ Mensaje enviado a: ${chatId} (Thread: ${options.message_thread_id || 'N/A'})`);

        } catch (error) {
            console.error(`❌ ERROR enviando a ${chatId}:`, error.message);
        }
    }
}

// Escuchar comandos
if (bot) {
    // Comando /start
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        saveUser(chatId);
        bot.sendMessage(chatId, "👋 ¡Bienvenido a IndicAlerts Ditox!\n\nEstás suscrito a las alertas automáticas. También puedes usar comandos como /reportBTC o /reportSOL para ver el estado actual.");
    });

    bot.onText(/\/report(.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const threadId = msg.message_thread_id; // Thread desde donde se pide
        const rawSymbol = match[1].trim().toUpperCase();

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

    console.log('Bot escuchando comandos /report...');
}


// --- 5. BUCLE PRINCIPAL ---
async function procesarMercado() {
    console.log(`[${new Date().toLocaleTimeString()}] Escaneando...`);

    for (const symbol of SYMBOLS) {
        for (const interval of INTERVALS) { // Solo 2h ahora
            await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));

            const marketData = await fetchData(symbol, interval);
            if (!marketData) continue;

            const { closes, closeTimes } = marketData;
            const indicadores = calcularIndicadores(closes);
            if (!indicadores) continue;

            const lastCandleTime = closeTimes[closeTimes.length - 1];
            const signal = evaluarAlertas(symbol, interval, indicadores, lastCandleTime);

            // Guardar en alerta para mostrar en UI aunque no sea cross zero
            const estadoInfo = obtenerEstado(indicadores.tangente, indicadores.curveTrend);

            // Actualizamos estadoAlertas con más info para la UI
            const key = `${symbol}_${interval}`;
            if (!estadoAlertas[key]) estadoAlertas[key] = {};
            estadoAlertas[key].currentStateText = estadoInfo.text;
            estadoAlertas[key].currentStateEmoji = estadoInfo.emoji;
            estadoAlertas[key].currentPrice = indicadores.currentPrice;
            estadoAlertas[key].tangente = indicadores.tangente;


            if (signal) {
                const message = `🚀 ALERTA DITOX

💎 ${symbol}

⏱ Temporalidad: ${interval}
📈 Estado: ${estadoInfo.text} ${estadoInfo.emoji}`;

                await enviarTelegram(message);

                history.unshift({
                    time: new Date().toISOString(),
                    symbol, interval, signal,
                    estadoText: estadoInfo.text,
                    tangente: indicadores.tangente
                });
                if (history.length > 20) history.pop();
            }
        }
    }
}

setInterval(procesarMercado, CHECK_INTERVAL_MS);
procesarMercado();


// --- 6. DASHBOARD FRONTEND ---
app.get('/', (req, res) => {
    const cardsHtml = SYMBOLS.map(s => {
        const i = '2h';
        const key = `${s}_${i}`;
        const estado = estadoAlertas[key] || {};
        const price = estado.currentPrice ? `$${estado.currentPrice}` : 'Cargando...';
        const statusText = estado.currentStateText || 'Esperando datos...';
        const statusEmoji = estado.currentStateEmoji || '⏳';

        // Determinar color basado en el texto del estado (algo sucio pero funcional rápido)
        // O mejor re-usar obtenerEstado si tuviéramos la tangente aquí guardada.
        // Usamos una clase genérica y luego JS en cliente o clases condicionales.
        // Simplificación: texto blanco/gris si no hay data.

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

    const historyRows = history.map(h => `
        <tr class="border-b border-gray-700/50 hover:bg-white/5 transition-colors">
            <td class="py-4 px-6 text-gray-400 font-mono text-xs">${new Date(h.time).toLocaleTimeString()}</td>
            <td class="py-4 px-6 text-blue-300 font-bold">${h.symbol}</td>
            <td class="py-4 px-6 text-gray-400 text-xs">${h.interval}</td>
            <td class="py-4 px-6">
                <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${h.signal === 'LONG' ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'}">
                    ${h.estadoText}
                </span>
            </td>
            <td class="py-4 px-6 text-gray-300 font-mono text-sm">${h.tangente.toFixed(4)}</td>
        </tr>
    `).join('');

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
    </style>
</head>
<body class="text-gray-200 min-h-screen p-4 md:p-8">

    <div class="max-w-7xl mx-auto">
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
            </div>
        </header>

        <!-- Stats Grid -->
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 mb-16">
            ${cardsHtml}
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
                        </tr>
                    </thead>
                    <tbody class="text-sm divide-y divide-gray-700/50">
                        ${historyRows.length ? historyRows : '<tr><td colspan="5" class="py-8 text-center text-gray-500 italic">Esperando primeras señales del mercado...</td></tr>'}
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
                    </ul>
                </div>

                <div>
                    <h4 class="font-bold text-white mb-1">Su mejor atributo:</h4>
                    <p>Avisarte cuando es buen momento de analizar, ahorrándote tiempo de estar pendiente al mercado todo el día.</p>
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
