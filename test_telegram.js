require('dotenv').config();
const axios = require('axios');

async function testTelegram() {
    const token = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    console.log('--- Telegram Configuration Test ---');
    if (!token || token === 'your_telegram_bot_token_here') {
        console.error('❌ ERROR: TELEGRAM_TOKEN is missing or default.');
        return;
    }
    if (!chatId || chatId === 'your_chat_id_here') {
        console.error('❌ ERROR: TELEGRAM_CHAT_ID is missing or default.');
        return;
    }
    console.log('✅ Credentials found.');

    try {
        const message = '🔔 Test Message from Crypto Monitor: Your integration is working!';
        console.log('Sending test message...');

        const response = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: message
        });

        if (response.data.ok) {
            console.log('✅ SUCCESS: Message sent successfully!');
        } else {
            console.error('❌ FAILED: Telegram API returned error:', response.data);
        }
    } catch (error) {
        console.error('❌ EXCEPTION:', error.response ? error.response.data : error.message);
    }
}

testTelegram();
