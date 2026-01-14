require('dotenv').config();
const axios = require('axios');

async function debugTelegram() {
    console.log('--- 🕵️‍♂️ DEBUGGING TELEGRAM ---');

    const token = process.env.TELEGRAM_TOKEN;
    const rawChatIds = process.env.TELEGRAM_CHAT_ID || '';

    console.log(`1. Verificando Token... ${token ? (token.substring(0, 5) + '...') : 'FALTA'}`);

    if (!token) {
        console.error('❌ NO hay token en .env');
        return;
    }

    const destinatarios = rawChatIds.split(',').map(id => id.trim()).filter(id => id);
    console.log(`2. IDs encontrados: ${destinatarios.length}`);
    console.log(`   IDs: ${JSON.stringify(destinatarios)}\n`);

    if (destinatarios.length === 0) {
        console.error('❌ NO hay destinatarios en TELEGRAM_CHAT_ID (separar con comas)');
        return;
    }

    for (const chatId of destinatarios) {
        console.log(`➡️ Intentando enviar a: [${chatId}]`);
        try {
            const url = `https://api.telegram.org/bot${token}/sendMessage`;
            const response = await axios.post(url, {
                chat_id: chatId,
                text: `🧐 DEBUG TEST para ID: ${chatId}\nSi ves esto, funciona.`
            });

            if (response.data && response.data.ok) {
                console.log(`   ✅ ÉXITO: El servidor de Telegram aceptó el mensaje.\n`);
            } else {
                console.log(`   ⚠️ RESPUESTA RARA:`, response.data, '\n');
            }

        } catch (error) {
            console.error(`   ❌ FALLÓ:`);
            if (error.response) {
                console.error(`   Status Code: ${error.response.status}`);
                console.error(`   Error Description: ${error.response.data.description}`);

                if (error.response.status === 400) {
                    console.error(`   👉 SUGERENCIA: El ID es incorrecto o "chat not found".`);
                }
                if (error.response.status === 401) {
                    console.error(`   👉 SUGERENCIA: El TOKEN del bot es incorrecto.`);
                }
                if (error.response.status === 403) {
                    console.error(`   👉 SUGERENCIA: El bot fue bloqueado por el usuario o expulsado del grupo.`);
                }
            } else {
                console.error(`   ${error.message}`);
            }
            console.log(''); // Nueva línea
        }
    }
    console.log('--- FIN DEL DEBUG ---');
}

debugTelegram();
