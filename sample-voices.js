// Generate a sample of the same Arabic sentence for each candidate voice.
require('dotenv').config();
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const OUT = path.join(__dirname, 'out', 'voices');
fs.mkdirSync(OUT, { recursive: true });

// Sentence that exercises numbers and difficult Arabic phonemes.
const SAMPLE = 'أهلاً بك في أكمي ترافيل، تذكرة من القاهرة إلى دبي تبدأ من أربعة آلاف وخمسمائة ريال، وتشمل ثلاثة وعشرين كيلو شحن. هل تحب نأكد الحجز؟';

const CANDIDATES = [
  { name: '1-nasser-aljubaily',  voiceId: 'cFUFIbKkO2iZFwS8cRnY', note: 'Saudi - White Dialect - Pro' },
  { name: '2-abdullah-narrator', voiceId: 'usjDi9nBY6UHvtKrL4ba', note: 'Saudi - Warm Narrator' },
  { name: '3-mohammad-calm',     voiceId: 'LCDnCIYLTaVg7otERNkl', note: 'Saudi - Calm & Clear' },
  { name: '4-mohammed-almansari',voiceId: '2bnoa3wtrtcUW41TrSJM', note: 'Saudi - Professional' },
  { name: '5-khalifa-emirati',   voiceId: 'pu898dCezKb5nwKM5RJV', note: 'Emirati Gulf' },
  { name: '6-sultan-emirati',    voiceId: 'rUaPbzcZIu8df8iNL9WZ', note: 'Emirati Gulf - Clear' },
];

async function synth(voiceId, model) {
  const t0 = Date.now();
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text          : SAMPLE,
      model_id      : model,
      output_format : 'mp3_44100_128',                          // higher quality for comparison
      voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true },
    },
    {
      headers      : { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      responseType : 'arraybuffer',
      validateStatus: () => true,
    }
  );
  if (res.status !== 200) {
    const err = Buffer.from(res.data).toString('utf8').slice(0, 200);
    throw new Error(`HTTP ${res.status}: ${err}`);
  }
  return { buf: Buffer.from(res.data), ms: Date.now() - t0 };
}

(async () => {
  console.log(`Generating samples of the same sentence:\n   "${SAMPLE}"`);
  console.log('Model: eleven_multilingual_v2 (clearer for Arabic than Flash)');

  for (const c of CANDIDATES) {
    try {
      const { buf, ms } = await synth(c.voiceId, 'eleven_multilingual_v2');
      const file = path.join(OUT, `${c.name}.mp3`);
      fs.writeFileSync(file, buf);
      console.log(`   ok    | ${c.name.padEnd(25)} | ${c.note.padEnd(28)} | ${(buf.length/1024).toFixed(0)}KB | ${ms}ms`);
      console.log(`         | ${file}`);
    } catch (e) {
      console.log(`   fail  | ${c.name.padEnd(25)} | ${e.message}`);
    }
  }

  console.log('Listen to the files in out/voices/ and pick a voice id.');
})();
