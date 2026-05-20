// Inspect current Vapi account state: assistants + phone numbers.
require('dotenv').config();
const axios = require('axios');

const API = 'https://api.vapi.ai';
const KEY = process.env.VAPI_API_KEY;
const PHONE_ID = process.env.VAPI_PHONE_NUMBER_ID;

const h = { headers: { Authorization: `Bearer ${KEY}` } };

(async () => {
  console.log('Vapi account inspection:');

  // 1. Assistants
  try {
    const r = await axios.get(`${API}/assistant`, h);
    const list = r.data || [];
    console.log(`Assistants: ${list.length}`);
    list.forEach((a) => {
      console.log(`   - ${a.name || '(unnamed)'.padEnd(20)} | ${a.id}`);
      console.log(`     model: ${a.model?.provider}/${a.model?.model} | voice: ${a.voice?.provider}/${a.voice?.voiceId || a.voice?.model}`);
    });
  } catch (e) {
    console.log('   failed:', e.response?.status, e.response?.data || e.message);
  }

  // 2. Phone numbers
  try {
    const r = await axios.get(`${API}/phone-number`, h);
    const list = r.data || [];
    console.log(`Phone numbers: ${list.length}`);
    list.forEach((p) => {
      console.log(`   - ${p.number || p.name || p.id}`);
      console.log(`     id: ${p.id}`);
      console.log(`     provider: ${p.provider} | assistantId: ${p.assistantId || '(none)'}`);
    });
  } catch (e) {
    console.log('   failed:', e.response?.status, e.response?.data || e.message);
  }

  // 3. Specific phone from .env
  if (PHONE_ID) {
    try {
      const r = await axios.get(`${API}/phone-number/${PHONE_ID}`, h);
      console.log(`Phone in .env (${PHONE_ID}):`);
      console.log(JSON.stringify(r.data, null, 2));
    } catch (e) {
      console.log('   failed:', e.response?.status, e.response?.data || e.message);
    }
  }
})();
