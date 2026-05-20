// Search the ElevenLabs library for Arabic voices, ranking Saudi/Gulf first.
require('dotenv').config();
const axios = require('axios');

const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) {
  console.error('ELEVENLABS_API_KEY missing in .env');
  process.exit(1);
}

(async () => {
  console.log('Searching ElevenLabs library for Arabic voices...');

  // 1. My Voices
  try {
    const my = await axios.get('https://api.elevenlabs.io/v2/voices', {
      headers: { 'xi-api-key': API_KEY },
      params : { search: 'arabic', page_size: 100 },
    });
    console.log('My Voices:');
    const list = my.data.voices || [];
    if (!list.length) console.log('   (none)');
    list.forEach((v) => {
      console.log(`   - ${v.name.padEnd(28)} | ${v.voice_id} | ${v.labels?.accent || ''} ${v.labels?.gender || ''}`);
    });
  } catch (e) {
    console.log('   failed to fetch My Voices:', e.response?.data?.detail || e.message);
  }

  // 2. Shared library
  console.log('Shared library (Arabic):');
  try {
    const shared = await axios.get('https://api.elevenlabs.io/v1/shared-voices', {
      headers: { 'xi-api-key': API_KEY },
      params : { language: 'ar', page_size: 50 },
    });
    const voices = shared.data.voices || [];
    if (!voices.length) {
      console.log('   (none)');
      return;
    }

    // Rank: Saudi first, then Gulf, then generic Arabic, then the rest.
    const score = (v) => {
      const text = `${v.name} ${v.description || ''} ${v.accent || ''} ${(v.labels || []).join(' ')}`.toLowerCase();
      if (text.includes('saudi') || text.includes('سعودي'))   return 3;
      if (text.includes('gulf')  || text.includes('khaleej')) return 2;
      if (text.includes('arabic')|| text.includes('عربي'))    return 1;
      return 0;
    };

    voices
      .sort((a, b) => score(b) - score(a))
      .slice(0, 25)
      .forEach((v) => {
        const tag = score(v) === 3 ? '[SA]' : score(v) === 2 ? '[GULF]' : '[AR]';
        console.log(`   ${tag} ${v.name.padEnd(20)} | ${v.voice_id} | ${(v.accent || '').padEnd(15)} | ${v.gender || ''} | ${v.description?.slice(0,60) || ''}`);
      });
    console.log('[SA] = Saudi   [GULF] = Gulf   [AR] = Arabic generic');
  } catch (e) {
    console.log('   failed to fetch shared voices:', e.response?.data?.detail || e.message);
  }
})();
