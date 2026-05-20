// Bind the Twilio number (from .env) to a specific company's Vapi assistant.
// Usage: node vapi-bind-phone.js <companyId>
require('dotenv').config();
const axios = require('axios');

const API = 'https://api.vapi.ai';
const KEY = process.env.VAPI_API_KEY;
const PHONE_ID = process.env.VAPI_PHONE_NUMBER_ID;
const ASSISTANT_PREFIX = 'smart-assistant:';

const companyId = process.argv[2];
if (!companyId) {
  console.error('Usage: node vapi-bind-phone.js <companyId>');
  console.error('Example: node vapi-bind-phone.js acme');
  process.exit(1);
}

const h = { headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' } };

(async () => {
  // Find the assistant by name.
  const all = (await axios.get(`${API}/assistant`, h)).data || [];
  const assistant = all.find((a) => a.name === `${ASSISTANT_PREFIX}${companyId}`);

  if (!assistant) {
    console.error(`No assistant named ${ASSISTANT_PREFIX}${companyId}`);
    console.error('Run: node vapi-create-assistants.js');
    process.exit(1);
  }

  // Bind.
  const r = await axios.patch(
    `${API}/phone-number/${PHONE_ID}`,
    { assistantId: assistant.id },
    h
  );

  console.log(`Bound ${r.data.number} to ${assistant.name}`);
  console.log(`assistantId: ${assistant.id}`);
  console.log(`Call ${r.data.number} to test.`);
})().catch((e) => {
  console.error('failed:', e.response?.status, JSON.stringify(e.response?.data) || e.message);
});
