require('dotenv').config();
const OpenAI = require('openai');
const axios  = require('axios');
const fs     = require('fs');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Latency rating helper ──────────────────────────────────
function rating(ms, good, ok) {
  if (ms <= good) return 'good';
  if (ms <= ok)   return 'ok';
  return 'slow';
}

async function testAll() {
  console.log('API latency check');

  // ─── 1. OpenAI ────────────────────────────────────────────
  console.log('OpenAI (gpt-4o-mini)...');
  const t1 = Date.now();
  try {
    const res = await openai.chat.completions.create({
      model      : 'gpt-4o-mini',
      messages   : [{ role: 'user', content: 'قل مرحبا باختصار' }],
      max_tokens : 20,
    });
    const ms1 = Date.now() - t1;
    console.log(`   reply: "${res.choices[0].message.content}"`);
    console.log(`   ${rating(ms1, 800, 1500)} ${ms1}ms  (target: < 800ms)`);
  } catch (e) {
    console.log(`   failed: ${e.message}`);
  }

  // ─── 2. ElevenLabs streaming ──────────────────────────────
  console.log('ElevenLabs Flash v2.5 (streaming)...');
  const t2 = Date.now();
  let firstChunkMs = null;
  try {
    const stream = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}/stream`,
      {
        text          : 'مرحباً، كيف يمكنني مساعدتك؟',
        model_id      : 'eleven_flash_v2_5',
        output_format : 'mp3_44100_64',          // faster than higher quality
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      },
      {
        headers      : { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
        responseType : 'stream',
      }
    );

    await new Promise((resolve, reject) => {
      const chunks = [];
      stream.data.on('data', (chunk) => {
        if (!firstChunkMs) firstChunkMs = Date.now() - t2; // first bytes arrived
        chunks.push(chunk);
      });
      stream.data.on('end', () => {
        const total     = Buffer.concat(chunks);
        const totalMs   = Date.now() - t2;
        // Save audio for manual verification.
        fs.writeFileSync('test-output.mp3', total);
        console.log(`   first chunk : ${rating(firstChunkMs, 500, 1000)} ${firstChunkMs}ms  (target: < 500ms)`);
        console.log(`   full audio  : ${rating(totalMs, 1500, 3000)} ${totalMs}ms  |  ${total.length} bytes`);
        console.log(`   saved       : test-output.mp3`);
        resolve();
      });
      stream.data.on('error', reject);
    });
  } catch (e) {
    console.log(`   failed: ${e.message}`);
  }

  // ─── 3. Vapi ──────────────────────────────────────────────
  console.log('Vapi.ai...');
  const t3 = Date.now();
  try {
    const vapi = await axios.get('https://api.vapi.ai/assistant', {
      headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
    });
    const ms3 = Date.now() - t3;
    const count = Array.isArray(vapi.data) ? vapi.data.length : '-';
    console.log(`   assistants currently: ${count}`);
    console.log(`   ${rating(ms3, 300, 600)} ${ms3}ms  (target: < 300ms)`);
  } catch (e) {
    console.log(`   failed: ${e.message}`);
  }

  console.log('Legend: good < target | ok  < 2x target | slow >= 2x target');
  console.log('Done.');
}

testAll().catch(console.error);
