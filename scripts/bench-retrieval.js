// Retrieval benchmark for lib/rag.js retrieve().
//
// The embedding API call dominates retrieval (~230-320ms) and its latency
// drifts between runs by more than the code changes being measured. So the
// headline comparison FREEZES the query embedding: each query is embedded once
// up front, then replayed, isolating the DB + CPU work that we control.
// The live embedding cost is reported separately as an external constant.
//
//   DATABASE_URL=postgres://postgres:test@localhost:5445/satest \
//   node --use-system-ca scripts/bench-retrieval.js [label]
require('dotenv').config({ quiet: true });
process.env.DB_DRIVER = 'postgres';

const { sql } = require('../db');
const { getPool, close, retrieveVec } = require('../lib/db-pg');
const rag = require('../lib/rag');

const LABEL = process.argv[2] || 'run';
const SAMPLES = Number(process.env.BENCH_SAMPLES || 15);
const COMPANIES = ['bench-150', 'bench-500', 'bench-1000'];

const QUERIES = [
  'كم سعر الشقة في مشروع درة الرياض؟',
  'وش عندكم في حي الياسمين؟',
  'أبغى فيلا أربع غرف كم مساحتها؟',
  'كم الدفعة الأولى وهل فيه تمويل بنكي؟',
  'هل عندكم فروع في جدة أو الدمام؟',
];

const stats = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return { med: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], min: s[0] };
};

(async () => {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL required'); process.exit(1); }
  getPool();
  console.log(`\n═══ RETRIEVAL BENCHMARK — "${LABEL}" — ${SAMPLES} samples ═══\n`);

  // ── external constant: live embedding API ──
  const realEmbed = rag.embedOne;
  const embedTimes = [];
  const vecs = new Map();
  for (const q of QUERIES) {
    const s = Date.now();
    vecs.set(q, await realEmbed(q));
    embedTimes.push(Date.now() - s);
  }
  const est = stats(embedTimes);
  console.log(`external — embedding API: ${est.med}ms med, ${est.min}ms min  (NOT affected by these changes)\n`);

  // Freeze embeddings so the measured section is only our code.
  Object.defineProperty(rag, 'embedOne', { value: async (t) => vecs.get(t) || realEmbed(t), writable: true });

  const summary = [];
  for (const companyId of COMPANIES) {
    const all = [];
    for (const q of QUERIES) {
      const times = [];
      for (let i = 0; i < SAMPLES; i++) {
        const s = Date.now();
        await rag.retrieve(companyId, q, { topK: 3 });
        times.push(Date.now() - s);
      }
      all.push(...times);
    }
    const st = stats(all);
    summary.push({ companyId, ...st });
    console.log(`  ${companyId.padEnd(11)} med ${String(st.med).padStart(4)}ms   p90 ${String(st.p90).padStart(4)}ms   min ${String(st.min).padStart(4)}ms`);
  }

  // ── cold vs warm corpus cache ──
  rag.invalidateChunkCache?.('bench-1000');
  let s = Date.now(); await rag.retrieve('bench-1000', QUERIES[0], { topK: 3 });
  const cold = Date.now() - s;
  s = Date.now(); await rag.retrieve('bench-1000', QUERIES[0], { topK: 3 });
  const warm = Date.now() - s;
  console.log(`\n  corpus cache (bench-1000): cold ${cold}ms → warm ${warm}ms`);

  // ── per-leg breakdown, embedding excluded ──
  console.log('\n─── per-leg breakdown (bench-500, embedding excluded) ───');
  const qv = new Float32Array(vecs.get(QUERIES[0]));
  s = Date.now(); await sql.countCompanyChunks.get('bench-500');
  console.log(`  countQuery       ${Date.now() - s} ms  (removed from hot path)`);
  s = Date.now(); await retrieveVec('bench-500', qv, { topK: 24, minScore: -1 });
  console.log(`  vectorSearch     ${Date.now() - s} ms`);
  s = Date.now(); const texts = await sql.listCompanyChunkTexts.all('bench-500');
  console.log(`  chunkTextFetch   ${Date.now() - s} ms  (${Math.round(texts.reduce((n, r) => n + r.text.length, 0) / 1024)} KB — cached after first call)`);
  const toks = rag.tokenizeQuery(QUERIES[0]);
  s = Date.now(); for (const r of texts) rag.keywordScore(toks, rag.normalizeArabic(r.text));
  console.log(`  keywordNormalize ${Date.now() - s} ms  (precomputed in cache)`);

  console.log('\n─── SUMMARY (code-controlled latency, embedding excluded) ───');
  for (const x of summary) console.log(`  ${x.companyId.padEnd(11)} med ${String(x.med).padStart(4)}ms  p90 ${String(x.p90).padStart(4)}ms`);
  console.log(`\n  + external embedding API: ~${est.med}ms (unchanged)`);
  await close();
})().catch((e) => { console.error('bench error:', e.message); process.exit(1); });
