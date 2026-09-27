// Profiles real production call latency from the provider's own per-turn
// metrics, so a config change can be judged on real conversations rather than
// synthetic benchmarks.
//
// Run before and after any latency change:
//   node --use-system-ca scripts/profile-calls.js [limit]
//
// IMPORTANT — this reports LESS than its predecessor did, and that is a
// property of the platform, not an omission here. The previous provider
// published a fixed four-stage breakdown per turn (transcriber · endpointing ·
// model · voice). ElevenLabs Agents expose `conversation_turn_metrics` on each
// transcript turn instead, and the set of keys inside it is not contractually
// fixed. So rather than hardcode field names that might not exist — and print
// confident zeros for them — this script DISCOVERS whichever numeric metrics
// the API actually returns and aggregates exactly those. If a future release
// adds a stage, it shows up here with no code change; if one disappears, you
// see it disappear instead of reading a silent 0ms.
require('dotenv').config({ quiet: true });

const KEY = process.env.ELEVENLABS_API_KEY;
const BASE = (process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '');
const LIMIT = Number(process.argv[2] || 100);
const H = { 'xi-api-key': KEY };

const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;
};

async function get(url) {
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Metrics arrive as either { key: 123 } or { key: { value: 123 } }. Flatten one
// level so both shapes aggregate identically.
function flattenMetrics(m, out = {}, prefix = '') {
  if (!m || typeof m !== 'object') return out;
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[prefix + k] = v;
    else if (v && typeof v === 'object') flattenMetrics(v, out, `${prefix}${k}.`);
  }
  return out;
}

(async () => {
  if (!KEY) { console.error('ELEVENLABS_API_KEY not set'); process.exit(1); }

  const list = await get(`${BASE}/v1/convai/conversations?page_size=${Math.min(100, LIMIT)}`);
  const summaries = (list.conversations || []).slice(0, LIMIT);
  if (!summaries.length) { console.log('No conversations found.'); return; }

  const agg = {};            // metric key -> samples
  const perCall = [];
  let calls = 0;
  let turns = 0;

  for (const s of summaries) {
    const id = s.conversation_id;
    if (!id) continue;
    let c;
    try { c = await get(`${BASE}/v1/convai/conversations/${encodeURIComponent(id)}`); }
    catch (e) { console.error(`  skip ${id}: ${e.message}`); continue; }

    const turnList = (c.transcript || []).filter((t) => t.conversation_turn_metrics);
    calls++;
    const callAgg = {};
    for (const t of turnList) {
      turns++;
      const flat = flattenMetrics(t.conversation_turn_metrics);
      for (const [k, v] of Object.entries(flat)) {
        (agg[k] ||= []).push(v);
        (callAgg[k] ||= []).push(v);
      }
    }
    const meta = c.metadata || {};
    perCall.push({
      when    : new Date((meta.start_time_unix_secs || 0) * 1000).toISOString().slice(5, 16),
      dir     : meta.phone_call?.direction || 'web',
      turns   : turnList.length,
      durSec  : meta.call_duration_secs ?? null,
      // Credits, not dollars — the API reports no fiat amount (see
      // services/voice/elevenlabs.js). The column header says so.
      credits : meta.cost ?? null,
      metrics : Object.fromEntries(Object.entries(callAgg)
        .map(([k, v]) => [k, Math.round(v.reduce((n, x) => n + x, 0) / v.length)])),
    });
  }

  console.log(`\n═══ PRODUCTION CALL PROFILE — ${calls} calls · ${turns} turns with metrics ═══\n`);
  console.log('  when          dir       turns    dur(s)   credits');
  for (const p of perCall.sort((a, b) => (a.when < b.when ? -1 : 1))) {
    console.log(`  ${p.when}  ${String(p.dir).padEnd(9)}${String(p.turns).padStart(6)}${String(p.durSec ?? '-').padStart(10)}${String(p.credits ?? '-').padStart(10)}`);
  }

  const keys = Object.keys(agg);
  if (!keys.length) {
    console.log('\nNo per-turn metrics were returned for these conversations.');
    console.log('That is an API-surface fact, not a failure of this script — compare');
    console.log('end-to-end call duration and listener feedback instead.');
    return;
  }

  // Scale the bars against the largest median so the biggest cost is obvious
  // at a glance, which is the whole point of running this.
  const medians = Object.fromEntries(keys.map((k) => [k, pct(agg[k], 0.5)]));
  const worst = Math.max(...Object.values(medians), 1);

  console.log(`\n─── AGGREGATE (${turns} turns) ───`);
  console.log('  metric                         median      p90      max');
  for (const k of keys.sort((a, b) => medians[b] - medians[a])) {
    const a = agg[k];
    const bar = '█'.repeat(Math.round(20 * medians[k] / worst));
    console.log(`  ${k.padEnd(28)}${String(medians[k]).padStart(6)}ms${String(pct(a, 0.9)).padStart(8)}ms${String(Math.max(...a)).padStart(8)}ms  ${bar}`);
  }

  const durations = perCall.map((p) => p.durSec).filter((d) => typeof d === 'number');
  if (durations.length) {
    console.log(`\n  call duration: median ${pct(durations, 0.5)}s · p90 ${pct(durations, 0.9)}s`);
  }
})().catch((e) => { console.error('profile error:', e.message); process.exit(1); });
