// Trigger Vapi to place an outbound call to your number.
// Usage: node vapi-call-me.js +201XXXXXXXXX [companyId]
require('dotenv').config();
const axios = require('axios');

const YOUR_NUMBER = process.argv[2];
const COMPANY_ID  = process.argv[3] || 'acme';

if (!YOUR_NUMBER) {
  console.error('Usage:   node vapi-call-me.js +201XXXXXXXXX [companyId]');
  console.error('Example: node vapi-call-me.js +201001234567 acme');
  process.exit(1);
}

const API_KEY  = process.env.VAPI_API_KEY;
const PHONE_ID = process.env.VAPI_PHONE_NUMBER_ID;

if (!API_KEY || !PHONE_ID) {
  console.error('Make sure VAPI_API_KEY and VAPI_PHONE_NUMBER_ID are set in .env');
  process.exit(1);
}

// Look up the assistantId by name.
async function getAssistantId(companyId) {
  const r = await axios.get('https://api.vapi.ai/assistant', {
    headers: { Authorization: `Bearer ${API_KEY}` }
  });
  const name = `smart-assistant:${companyId}`;
  const found = (r.data || []).find(a => a.name === name);
  if (!found) throw new Error(`No assistant named "${name}" - run Vapi sync first.`);
  return found.id;
}

(async () => {
  console.log(`Vapi will call ${YOUR_NUMBER} as "${COMPANY_ID}"...`);

  try {
    const assistantId = await getAssistantId(COMPANY_ID);
    console.log(`   assistantId  : ${assistantId}`);
    console.log(`   phoneNumberId: ${PHONE_ID}`);

    const r = await axios.post(
      'https://api.vapi.ai/call',
      {
        phoneNumberId: PHONE_ID,
        assistantId  : assistantId,
        customer     : { number: YOUR_NUMBER },
      },
      { headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' } }
    );

    console.log(`Call dispatched.`);
    console.log(`   Call ID: ${r.data.id}`);
    console.log(`   Status : ${r.data.status}`);
    console.log(`Wait a few seconds for the phone to ring.`);

  } catch (e) {
    const msg = e.response?.data?.message || e.message;
    console.error(`Failed: ${msg}`);
    if (msg.includes('international') || msg.includes('E.164')) {
      console.error('Hint: use international format (+201001234567, not 01001234567).');
    }
    if (msg.includes('phoneNumberId')) {
      console.error('Hint: check VAPI_PHONE_NUMBER_ID in .env. Run: node vapi-inspect.js');
    }
  }
})();
