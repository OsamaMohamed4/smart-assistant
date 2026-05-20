// Full pipeline test: text -> GPT -> ElevenLabs -> MP3 file.
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'out');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

const cases = [
  { companyId: 'acme',      message: 'كم سعر تذكرة من الرياض إلى دبي؟' },
  { companyId: 'techstore', message: 'أبي لابتوب للبرمجة في حدود 3 آلاف ريال' },
];

function rating(ms, good, ok) {
  if (ms <= good) return 'good';
  if (ms <= ok)   return 'ok';
  return 'slow';
}

(async () => {
  console.log('Full pipeline test (text -> voice)');

  for (const body of cases) {
    const t0 = Date.now();
    const res = await fetch('http://localhost:3000/chat-voice', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      console.log(`[${body.companyId}] HTTP ${res.status}: ${err}`);
      continue;
    }

    const company   = decodeURIComponent(res.headers.get('x-company') || '');
    const replyB64  = res.headers.get('x-reply-text') || '';
    const reply     = Buffer.from(replyB64, 'base64').toString('utf8');
    const gptMs     = Number(res.headers.get('x-gpt-ms'));
    const voiceId   = res.headers.get('x-voice-id');

    // Read entire audio body.
    const arrayBuf  = await res.arrayBuffer();
    const buf       = Buffer.from(arrayBuf);
    const totalMs   = Date.now() - t0;
    const firstMs   = Number(res.headers.get('x-tts-first-chunk-ms') || 0);

    // Save MP3.
    const outFile = path.join(OUT_DIR, `${body.companyId}.mp3`);
    fs.writeFileSync(outFile, buf);

    console.log(`--- ${company} [${body.companyId}] ---`);
    console.log(`> ${body.message}`);
    console.log(`< ${reply}`);
    console.log(`   GPT          : ${rating(gptMs,  1000, 2000)} ${gptMs}ms`);
    console.log(`   TTS 1st chunk: ${rating(firstMs, 500, 1000)} ${firstMs}ms (after GPT finished)`);
    console.log(`   total        : ${rating(totalMs, 2000, 4000)} ${totalMs}ms`);
    console.log(`   voice id     : ${voiceId}`);
    console.log(`   audio file   : ${outFile} (${buf.length.toLocaleString()} bytes)`);
  }

  console.log('Open .mp3 files in out/ to listen.');
})();
