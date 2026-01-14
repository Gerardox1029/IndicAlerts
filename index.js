require('dotenv').config();
const axios = require('axios');
const RSI = require('technicalindicators').RSI;
const SMA = require('technicalindicators').SMA;
const express = require('express');

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
    'WLDUSDT'
];
const INTERVALS = ['1h', '2h'];
const CHECK_INTERVAL_MS = 60000; // 60 segundos
const REQUEST_DELAY_MS = 250;    // Aumentado un poco por mayor cantidad de pares

const app = express();
const PORT = process.env.PORT || 3000;

let estadoAlertas = {};
let history = [];

// --- 2. LÓGICA DE DATOS (Binance API) ---
async function fetchData(symbol, interval, limit = 100) {
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
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

    if (rsiSuavizadoValues.length < 2) return null;

    const currentRsiSuavizado = rsiSuavizadoValues[rsiSuavizadoValues.length - 1];
    const prevRsiSuavizado = rsiSuavizadoValues[rsiSuavizadoValues.length - 2];
    const tangente = currentRsiSuavizado - prevRsiSuavizado;

    // RSI 22 (Para Reporte Manual)
    const rsi22Values = RSI.calculate({ values: closes, period: 22 });
    const currentRsi22 = rsi22Values.length > 0 ? rsi22Values[rsi22Values.length - 1] : 0;

    return {
        rsiSuavizado: currentRsiSuavizado,
        tangente: tangente,
        rsi22: currentRsi22,
        currentPrice: closes[closes.length - 1]
    };
}

// --- 4. SISTEMA DE ALERTAS (Lógica Ditox_18) ---
function evaluarAlertas(symbol, interval, indicadores, lastCandleTime) {
    const { rsiSuavizado, tangente } = indicadores;
    let signal = null;

    if (tangente >= -0.10 && tangente <= 0 && rsiSuavizado < 50) {
        signal = 'LONG';
    }
    else if (tangente >= 0 && tangente <= 0.10 && rsiSuavizado > 50) {
        signal = 'SHORT';
    }

    if (!signal) return null;

    const key = `${symbol}_${interval}`;
    const estadoPrevio = estadoAlertas[key] || {};

    if (estadoPrevio.lastAlertSignal === signal && estadoPrevio.lastCandleTime === lastCandleTime) {
        return null;
    }

    estadoAlertas[key] = {
        lastAlertSignal: signal,
        lastCandleTime: lastCandleTime
    };

    return signal;
}

// --- 5. NOTIFICACIONES TELEGRAM ---
async function enviarTelegram(message) {
    const token = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId || token === 'your_telegram_bot_token_here') {
        console.warn('Telegram credentials not set.');
        return;
    }

    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: message
        });
    } catch (error) {
        console.error('Error sending Telegram message:', error.message);
    }
}

// --- 6. ENDPOINT REPORTE MANUAL ---
app.get('/report/:symbol/:interval', async (req, res) => {
    const { symbol, interval } = req.params;

    // Validar parámetros
    if (!SYMBOLS.includes(symbol) || !INTERVALS.includes(interval)) {
        return res.status(400).send('Invalid Symbol or Interval');
    }

    console.log(`Generando reporte manual para ${symbol} ${interval}...`);

    const marketData = await fetchData(symbol, interval, 100);
    if (!marketData) return res.status(500).send('Error fetching data');

    const indicadores = calcularIndicadores(marketData.closes);
    if (!indicadores) return res.status(500).send('Error calculating indicators');

    const message = `📋 REPORTE MANUAL
Instrumento: ${symbol} (${interval})
Precio: ~${indicadores.currentPrice}
RSI (22): ${indicadores.rsi22.toFixed(2)}
RSI Suavizado (20,20): ${indicadores.rsiSuavizado.toFixed(2)}
Tangente: ${indicadores.tangente.toFixed(4)}`;

    await enviarTelegram(message);
    res.send('Reporte enviado a Telegram!');
});


// --- 7. EJECUCIÓN (Bucle Principal) ---
async function procesarMercado() {
    console.log(`[${new Date().toLocaleTimeString()}] Escaneando...`);

    for (const symbol of SYMBOLS) {
        for (const interval of INTERVALS) {
            await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));

            const marketData = await fetchData(symbol, interval);
            if (!marketData) continue;

            const { closes, closeTimes } = marketData;
            const indicadores = calcularIndicadores(closes);
            if (!indicadores) continue;

            const lastCandleTime = closeTimes[closeTimes.length - 1];
            const signal = evaluarAlertas(symbol, interval, indicadores, lastCandleTime);

            if (signal) {
                const message = `🚀 ALERTA DITOX

💎 ${symbol}

⏱ Temporalidad: ${interval}
📈 Tipo: ${signal}
📊 RSI Suavizado: ${indicadores.rsiSuavizado.toFixed(2)}
📐 Tangente: ${indicadores.tangente.toFixed(4)}`;

                await enviarTelegram(message);

                history.unshift({
                    time: new Date().toISOString(),
                    symbol, interval, signal,
                    rsiSuavizado: indicadores.rsiSuavizado,
                    tangente: indicadores.tangente
                });
                if (history.length > 20) history.pop();
            }
        }
    }
}

// Iniciar bucle
setInterval(procesarMercado, CHECK_INTERVAL_MS);
procesarMercado();


// --- 8. DASHBOARD ---
app.get('/', (req, res) => {
    const cardsHtml = SYMBOLS.flatMap(s => INTERVALS.map(i => {
        const key = `${s}_${i}`;
        const estado = estadoAlertas[key];
        const statusText = estado ? `${estado.lastAlertSignal} (Vela: ${new Date(estado.lastCandleTime).toLocaleTimeString()})` : 'Sin Señal Reciente';
        const statusColor = estado && estado.lastAlertSignal === 'LONG' ? 'text-green-400' : (estado && estado.lastAlertSignal === 'SHORT' ? 'text-red-400' : 'text-gray-500');

        // Script para llamar al endpoint de reporte sin recargar toda la pág (fetch)
        const btnId = `btn-${s}-${i}`;

        return `
            <div class="bg-gray-800 p-4 rounded-lg shadow-lg border border-gray-700 flex flex-col justify-between">
                <div>
                    <h3 class="text-xl font-bold text-white mb-1">${s} <span class="text-sm font-normal text-gray-400">${i}</span></h3>
                    <p class="${statusColor} font-semibold text-sm mb-4">${statusText}</p>
                </div>
                <button 
                    id="${btnId}"
                    onclick="sendReport('${s}', '${i}', '${btnId}')"
                    class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded transition text-sm flex justify-center items-center">
                    <span>📩 Reportar</span>
                </button>
            </div>
         `;
    })).join('');

    const historyRows = history.map(h => `
        <tr class="border-b border-gray-700 hover:bg-gray-750">
            <td class="py-3 px-4 text-gray-300">${new Date(h.time).toLocaleTimeString()}</td>
            <td class="py-3 px-4 text-blue-300 font-bold">${h.symbol}</td>
            <td class="py-3 px-4 text-gray-300">${h.interval}</td>
            <td class="py-3 px-4 ${h.signal === 'LONG' ? 'text-green-400' : 'text-red-400'} font-bold">${h.signal}</td>
            <td class="py-3 px-4 text-gray-300">${h.rsiSuavizado.toFixed(2)}</td>
            <td class="py-3 px-4 text-gray-300">${h.tangente.toFixed(4)}</td>
        </tr>
    `).join('');

    const html = `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>Crypto Ditox Monitor V2</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>body { background-color: #111827; color: #e5e7eb; font-family: 'Inter', sans-serif; }</style>
</head>
<body class="p-8">
    <div class="max-w-7xl mx-auto">
        <header class="mb-8 flex justify-between items-center">
            <div>
                <h1 class="text-3xl font-bold text-blue-500 mb-2">🚀 Crypto Ditox Monitor</h1>
                <p class="text-gray-400">Analizando 9 activos en 1h y 2h</p>
            </div>
            <div class="text-right">
                 <p class="text-sm text-gray-500">Última actualización: ${new Date().toLocaleTimeString()}</p>
                 <p class="text-xs text-gray-600">Auto-refresh: 15s</p>
            </div>
        </header>

        <h2 class="text-2xl font-bold text-white mb-4">Panel de Control</h2>
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 mb-12">
            ${cardsHtml}
        </div>

        <h2 class="text-2xl font-bold text-white mb-4">Historial de Alertas</h2>
        <div class="overflow-x-auto bg-gray-800 rounded-lg shadow-lg border border-gray-700">
            <table class="w-full text-left border-collapse">
                <thead>
                    <tr class="bg-gray-900 text-gray-400 uppercase text-xs">
                        <th class="py-3 px-4">Hora</th>
                        <th class="py-3 px-4">Par</th>
                        <th class="py-3 px-4">TF</th>
                        <th class="py-3 px-4">Señal</th>
                        <th class="py-3 px-4">RSI Suav.</th>
                        <th class="py-3 px-4">Tangente</th>
                    </tr>
                </thead>
                <tbody class="text-sm">
                    ${historyRows.length ? historyRows : '<tr><td colspan="6" class="py-4 text-center text-gray-500">Esperando primeras señales...</td></tr>'}
                </tbody>
            </table>
        </div>
    </div>
    <script>
        // Auto-refresh 
        setTimeout(() => window.location.reload(), 15000);

        async function sendReport(symbol, interval, btnId) {
            const btn = document.getElementById(btnId);
            const originalText = btn.innerHTML;
            
            btn.innerHTML = '⏳ Enviando...';
            btn.disabled = true;
            btn.classList.add('opacity-50');

            try {
                const res = await fetch(\`/report/\${symbol}/\${interval}\`);
                if (res.ok) {
                    btn.innerHTML = '✅ ¡Enviado!';
                    setTimeout(() => {
                        btn.innerHTML = originalText;
                        btn.disabled = false;
                        btn.classList.remove('opacity-50');
                    }, 2000);
                } else {
                    btn.innerHTML = '❌ Error';
                    alert('Error enviando reporte');
                }
            } catch (error) {
                console.error(error);
                btn.innerHTML = '❌ Error';
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
