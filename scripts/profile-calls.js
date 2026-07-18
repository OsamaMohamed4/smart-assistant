// Profiles real production call latency from Vapi's own performanceMetrics.
//
// Vapi records a per-turn breakdown on every call artifact:
//   transcriberLatency · endpointingLatency · modelLatency · voiceLatency
// This aggregates them across recent calls so a config change can be judged on
// real conversations rather than synthetic benchmarks.
//
// Run before and after any latency change:
//   node --use-system-ca scripts/profile-calls.js [limit]
require('dotenv').config({ quiet: true });

const KEY = process.env.VAPI_API_KEY;
const LIMIT = Number(process.argv[2] || 100);
const H = { Authorization: `Bearer ${KEY}` };

const STAGES = [
  ['transcriberLatency', 'STT (transcriber)'],
  ['endpointingLatency', 'Endpointing'],
  ['modelLatency', 'LLM (model)'],
  ['voiceLatency', 'TTS (voice)'],
];

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };

async function get(url) {
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(`vapi ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

(async () => {
  if (!KEY) { console.error('VAPI_API_KEY not set'); process.exit(1); }
  const list = await get(`https://api.vapi.ai/call?limit=${LIMIT}`);

  const agg = Object.fromEntries([...STAGES.map(([k]) => [k, []]), ['turnLatency', []]]);
  let calls = 0, turns = 0;
  const perCall = [];

  for (const s of list) {
    const c = await get(`https://api.vapi.ai/call/${s.id}`);
    const tl = c.artifact?.performanceMetrics?.turnLatencies;
    if (!tl?.length) continue;
    calls++; turns += tl.length;
    for (const t of tl) for (const k of Object.keys(agg)) if (typeof t[k] === 'number') agg[k].push(t[k]);
    const avg = (k) => Math.round(tl.reduce((n, t) => n + (t[k] || 0), 0) / tl.length);
    perCall.push({
      when: (c.startedAt || c.createdAt || '').slice(5, 16),
      type: (c.type || '').replace('PhoneCall', 'Phone').replace('outbound', 'out'),
      turns: tl.length,
      stt: avg('transcriberLatency'), ep: avg('endpointingLatency'),
      llm: avg('modelLatency'), tts: avg('voiceLatency'), turn: avg('turnLatency'),
      cachedTok: c.costBreakdown?.llmCachedPromptTokens ?? null,
      promptTok: c.costBreakdown?.llmPromptTokens ?? null,
    });
  }

  if (!turns) { console.log('No calls with performanceMetrics found.'); return; }

  console.log(`\n═══ PRODUCTION CALL PROFILE — ${calls} calls · ${turns} turns ═══\n`);
  console.log('  when          type        turns     STT   endpt     LLM     TTS    TURN');
  for (const p of perCall.sort((a, b) => (a.when < b.when ? -1 : 1))) {
    console.log(`  ${p.when}  ${p.type.padEnd(10)} ${String(p.turns).padStart(5)} ${String(p.stt).padStart(7)} ${String(p.ep).padStart(7)} ${String(p.llm).padStart(7)} ${String(p.tts).padStart(7)} ${String(p.turn).padStart(7)}`);
  }

  const turnMed = pct(agg.turnLatency, 0.5);
  console.log(`\n─── AGGREGATE (${turns} turns) ───`);
  console.log('  stage                median      p90      max    share of turn');
  for (const [k, label] of STAGES) {
    const a = agg[k]; if (!a.length) continue;
    const m = pct(a, 0.5);
    const bar = '█'.repeat(Math.round(20 * m / turnMed));
    console.log(`  ${label.padEnd(20)}${String(m).padStart(6)}ms${String(pct(a, 0.9)).padStart(8)}ms${String(Math.max(...a)).padStart(8)}ms   ${String((100 * m / turnMed).toFixed(0) + '%').padStart(4)} ${bar}`);
  }
  console.log(`  ${'TOTAL TURN'.padEnd(20)}${String(turnMed).padStart(6)}ms${String(pct(agg.turnLatency, 0.9)).padStart(8)}ms${String(Math.max(...agg.turnLatency)).padStart(8)}ms`);

  // Prompt caching actually observed in production.
  const cached = perCall.filter((p) => p.cachedTok != null && p.promptTok);
  if (cached.length) {
    const rate = cached.reduce((n, p) => n + p.cachedTok / p.promptTok, 0) / cached.length;
    console.log(`\n  prompt cache hit rate: ${(100 * rate).toFixed(0)}% of prompt tokens across ${cached.length} calls`);
  }
})().catch((e) => { console.error('profile error:', e.message); process.exit(1); });
