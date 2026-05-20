// Summarize chat sessions and call transcripts using gpt-4o-mini.
require('dotenv').config();
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 20_000, maxRetries: 1 });

const SYSTEM = 'أنت مساعد يلخّص محادثة بين مساعد ذكي وعميل. اكتب الملخّص في 1-2 جملة مختصرة باللهجة السعودية الواضحة، يذكر: غرض العميل، النتيجة، أي قرار أو إجراء مطلوب. لا تذكر أي رأي، فقط حقائق المحادثة.';

async function summarize(transcript) {
  if (!transcript || transcript.trim().length < 20) return null;
  try {
    const r = await openai.chat.completions.create({
      model      : 'gpt-4o-mini',
      max_tokens : 120,
      temperature: 0.3,
      messages   : [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: transcript.slice(0, 6000) },
      ],
    });
    return r.choices[0].message.content.trim();
  } catch (e) {
    console.error('summarize error:', e.message);
    return null;
  }
}

function chatToTranscript(rows) {
  return rows
    .map((r) => `العميل: ${r.user_message}\nالمساعد: ${r.assistant_reply || ''}`)
    .join('\n\n');
}

module.exports = { summarize, chatToTranscript };
