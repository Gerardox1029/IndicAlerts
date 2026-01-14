require('dotenv').config();
const axios = require('axios');

async function getChatIds() {
    const token = process.env.TELEGRAM_TOKEN;
    if (!token || token === 'your_telegram_bot_token_here') {
        console.error('❌ Error: Configura tu TELEGRAM_TOKEN en el archivo .env primero.');
        return;
    }

    console.log('📡 Buscando mensajes recientes para obtener IDs...\n');
    console.log('IMPORTANTE: Para ver el ID de un grupo:');
    console.log('1. Agrega al bot al grupo.');
    console.log('2. Escribe cualquier mensaje en el grupo (ej: "hola bot").');
    console.log('3. Espera unos segundos y mira aquí abajo.\n');

    try {
        const response = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`);
        const updates = response.data.result;

        if (updates.length === 0) {
            console.log('📭 No hay mensajes nuevos. Escribe algo al bot y vuelve a ejecutar este script.');
            return;
        }

        console.log('⬇️ LISTA DE CHATS ENCONTRADOS ⬇️');
        updates.forEach(u => {
            if (u.message && u.message.chat) {
                const chat = u.message.chat;
                const type = chat.type === 'private' ? '👤 Privado' : '👥 Grupo';
                const name = chat.title || chat.username || chat.first_name;
                console.log(`[${type}] ${name} => ID: ${chat.id}`);
            }
        });
        console.log('\n✅ Copia el ID que necesites y pégalo en tu archivo .env (separado por comas si son varios).');

    } catch (error) {
        console.error('❌ Error al conectar con Telegram:', error.message);
    }
}

getChatIds();
