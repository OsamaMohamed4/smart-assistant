require('dotenv').config();
const axios = require('axios');
const { loadCompany, listCompanies } = require('./companies');

const API = 'https://api.vapi.ai';
const KEY = process.env.VAPI_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

const h = { headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' } };

const ASSISTANT_PREFIX = 'smart-assistant:';

// Build the Vapi assistant payload. company.systemPrompt already contains
// MASTER_PROMPT + business prompt + inline KB (composed in companies.js).
function buildAssistant(company) {
  return {
    name: `${ASSISTANT_PREFIX}${company.id}`,

    model: {
      provider   : 'openai',
      model      : 'gpt-4o-mini',
      temperature: 0.6,
      maxTokens  : 150,
      messages   : [
        { role: 'system', content: company.systemPrompt },
      ],
      tools: [
        {
          type: 'endCall',
          // System speaks this line right before hanging up, guarantees a goodbye.
          messages: [
            {
              type   : 'request-start',
              content: 'في أمان الله، إلى اللقاء.',
            },
          ],
        },
      ],
    },

    voice: {
      provider               : '11labs',
      voiceId                : VOICE_ID,
      model                  : 'eleven_flash_v2_5',
      stability              : 0.5,
      similarityBoost        : 0.75,
      useSpeakerBoost        : true,
      optimizeStreamingLatency: 4,
    },

    transcriber: {
      provider: 'azure',
      language: 'ar-SA',
    },

    firstMessage    : `حياك الله في ${company.name}، أنا المساعد الذكي. كيف أقدر أخدمك؟`,
    firstMessageMode: 'assistant-speaks-first',
    backgroundDenoisingEnabled: false,
    silenceTimeoutSeconds     : 20,
    maxDurationSeconds        : 600,

    endCallPhrases: [],

    startSpeakingPlan: {
      waitSeconds            : 0.1,
      smartEndpointingEnabled: true,
    },
    stopSpeakingPlan: {
      numWords      : 1,
      voiceSeconds  : 0.1,
      backoffSeconds: 0.5,
    },
  };
}

async function findExisting(name) {
  const r = await axios.get(`${API}/assistant`, h);
  return (r.data || []).find((a) => a.name === name);
}

(async () => {
  console.log('Pushing Vapi assistants...');

  for (const id of listCompanies()) {
    const company  = loadCompany(id);
    const cfg      = buildAssistant(company);
    const existing = await findExisting(cfg.name);

    try {
      if (existing) {
        await axios.patch(`${API}/assistant/${existing.id}`, cfg, h);
        console.log(`   updated: ${cfg.name}`);
      } else {
        const r = await axios.post(`${API}/assistant`, cfg, h);
        console.log(`   created: ${cfg.name} | ${r.data.id}`);
      }
    } catch (e) {
      const msg = e.response?.data?.message || JSON.stringify(e.response?.data) || e.message;
      console.log(`   failed:  ${cfg.name}: ${msg}`);
    }
  }

  console.log('Done.');
})();
