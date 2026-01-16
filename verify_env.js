require('dotenv').config();

const rawChatIds = process.env.TELEGRAM_CHAT_ID;
console.log('Raw TELEGRAM_CHAT_ID:', rawChatIds);

if (rawChatIds) {
    const destinatarios = rawChatIds.split(',').map(id => id.trim()).filter(id => id);
    console.log('Parsed IDs:', destinatarios);
    console.log('Count:', destinatarios.length);
} else {
    console.log('TELEGRAM_CHAT_ID is undefined or empty');
}
