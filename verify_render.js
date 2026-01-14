require('dotenv').config();
const axios = require('axios');
const RSI = require('technicalindicators').RSI;
const SMA = require('technicalindicators').SMA;

async function reportRender() {
    const symbol = 'RENDERUSDT'; // Updated symbol
    const interval = '4h';

    console.log(`Fetching data for ${symbol} ${interval}...`);

    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=200`;
        const response = await axios.get(url);
        const closes = response.data.map(k => parseFloat(k[4]));
        const currentPrice = closes[closes.length - 1];

        // 1. RSI 22
        const rsi22Values = RSI.calculate({ values: closes, period: 22 });
        const rsi22 = rsi22Values[rsi22Values.length - 1];

        // 2. Logic from Bot: RSI 20 -> SMA 20 -> Tangent
        const rsi20Values = RSI.calculate({ values: closes, period: 20 });
        const smaInput = { period: 20, values: rsi20Values };
        const rsiSuavizadoValues = SMA.calculate(smaInput);

        const currentRsiSuavizado = rsiSuavizadoValues[rsiSuavizadoValues.length - 1];
        const prevRsiSuavizado = rsiSuavizadoValues[rsiSuavizadoValues.length - 2];
        const tangente = currentRsiSuavizado - prevRsiSuavizado;

        const message = `🧐 REPORTE DE VERIFICACIÓN (RENDER - NEW)
💎 Instrumento: ${symbol}
⏱ Temporalidad: ${interval}
💵 Precio Actual: ${currentPrice}
📊 RSI (22): ${rsi22.toFixed(2)}
📉 RSI Suavizado (20,20): ${currentRsiSuavizado.toFixed(2)}
📐 Tangente: ${tangente.toFixed(4)}`;

        console.log(message);

        const token = process.env.TELEGRAM_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;

        if (!token || !chatId) {
            console.error('Credentials missing.');
            return;
        }

        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: message
        });
        console.log('✅ Report sent to Telegram.');

    } catch (error) {
        console.error('Error:', error.message);
    }
}

reportRender();
