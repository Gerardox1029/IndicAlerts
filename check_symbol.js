const axios = require('axios');

async function checkSymbols() {
    try {
        console.log('Checking RNDRUSDT...');
        const r1 = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=RNDRUSDT').catch(e => e.response.data);
        console.log('RNDRUSDT Result:', r1.data || r1);

        console.log('Checking RENDERUSDT...');
        const r2 = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=RENDERUSDT').catch(e => e.response.data);
        console.log('RENDERUSDT Result:', r2.data || r2);

    } catch (error) {
        console.error('Error:', error.message);
    }
}

checkSymbols();
