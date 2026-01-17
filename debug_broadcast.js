require('dotenv').config();

const TARGET_GROUP_ID = '-1003055730763';
const THREAD_ID = process.env.TELEGRAM_THREAD_ID;
const rawChatIds = process.env.TELEGRAM_CHAT_ID || '';
const envIds = rawChatIds.split(',').map(id => id.trim()).filter(id => id);

// Simulating subscribed users (e.g. just one for test)
const subscribedUsers = new Set(['1985505500']);

const allRecipients = new Set([...envIds, ...subscribedUsers]);

console.log('TARGET_GROUP_ID:', TARGET_GROUP_ID);
console.log('THREAD_ID:', THREAD_ID);
console.log('Env IDs:', envIds);
console.log('All Recipients:', [...allRecipients]);

for (const chatId of allRecipients) {
    const options = {};
    const isTarget = (chatId === TARGET_GROUP_ID);

    if (isTarget && THREAD_ID) {
        options.message_thread_id = parseInt(THREAD_ID);
    }

    console.log(`Sending to: '${chatId}'`);
    console.log(`  - Is Target Group? ${isTarget}`);
    console.log(`  - Options:`, options);

    if (isTarget && !options.message_thread_id) {
        console.error('  ⚠️  WARNING: Target Group detected but NO thread ID attached!');
    }
}
