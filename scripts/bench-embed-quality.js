// Compares text-embedding-3-small vs text-embedding-3-large on Saudi Arabic
// real-estate retrieval, using a LABELED corpus: every chunk carries a unique
// unit number, so for each probe query we know exactly which chunk is correct.
//
// Reports recall@1 / recall@3 / MRR plus embedding latency, so "keep it only
// if quality is equal or better" can be decided on numbers.
//
//   DATABASE_URL=postgres://postgres:test@localhost:5445/satest \
//   node --use-system-ca scripts/bench-embed-quality.js
require('dotenv').config({ quiet: true });
process.env.DB_DRIVER = 'postgres';

const OpenAI = require('openai');
const { getPool, close } = require('../lib/db-pg');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000, maxRetries: 2 });
const SRC = 'bench-500';
const MODELS = ['text-embedding-3-small', 'text-embedding-3-large'];
const DIMS = 1536;

const lit = (v) => '[' + Array.from(v, (x) => x.toFixed(6)).join(',') + ']';

async function embed(model, inputs) {
  const out = [];
  for (let i = 0; i < inputs.length; i += 64) {
    const r = await openai.embeddings.create({ model, input: inputs.slice(i, i + 64), dimensions: DIMS });
    out.push(...r.data.map((d) => d.embedding));
  }
  return out;
}

// Build probe queries from the corpus itself: each targets one known chunk by
// its distinctive facts, phrased the way a caller would actually ask.
function probesFor(rows) {
  const probes = [];
  for (const r of rows) {
    const unit = /رقم الوحدة (\d+)/.exec(r.text)?.[1];
    const proj = /### (.+?) —/.exec(r.text)?.[1];
    const dist = /في حي ([^\n.]+)/.exec(r.text)?.[1]?.trim();
    const area = /المساحة (\d+) متر/.exec(r.text)?.[1];
    const price = /السعر ([\d,]+) ريال/.exec(r.text)?.[1];
    if (!unit || !proj || !dist) continue;
    probes.push({ gold: r.id, q: `كم سعر الوحدة رقم ${unit} في ${proj}؟` });
    if (area)  probes.push({ gold: r.id, q: `الوحدة ${unit} في حي ${dist} كم مساحتها؟` });
    if (price) probes.push({ gold: r.id, q: `أبغى تفاصيل الوحدة رقم ${unit} بمشروع ${proj} في حي ${dist}` });
  }
  return probes;
}

(async () => {
  const pool = getPool();
  const rows = (await pool.query('SELECT id, text FROM kb_chunks WHERE company_id=$1 ORDER BY id', [SRC])).rows;
  const probes = probesFor(rows).slice(0, 150);
  console.log(`\ncorpus ${rows.length} chunks · ${probes.length} labeled probe queries\n`);

  const results = {};
  for (const model of MODELS) {
    const tbl = `bench_emb_${model.split('-').pop()}`;
    await pool.query(`DROP TABLE IF EXISTS ${tbl}`);
    await pool.query(`CREATE TABLE ${tbl} (id BIGINT PRIMARY KEY, embedding vector(${DIMS}))`);

    process.stdout.write(`  ${model}: embedding corpus… `);
    const vecs = await embed(model, rows.map((r) => r.text));
    for (let i = 0; i < rows.length; i++) {
      await pool.query(`INSERT INTO ${tbl} (id, embedding) VALUES ($1, $2::vector)`, [rows[i].id, lit(vecs[i])]);
    }
    process.stdout.write('querying… ');

    const qv = await embed(model, probes.map((p) => p.q));
    let r1 = 0, r3 = 0, mrr = 0;
    const lat = [];
    for (let i = 0; i < probes.length; i++) {
      const s = Date.now();
      const got = await pool.query(
        `SELECT id FROM ${tbl} ORDER BY embedding <=> $1::vector, id LIMIT 5`, [lit(qv[i])]);
      lat.push(Date.now() - s);
      const ids = got.rows.map((x) => Number(x.id));
      const rank = ids.indexOf(Number(probes[i].gold));
      if (rank === 0) r1++;
      if (rank >= 0 && rank < 3) r3++;
      if (rank >= 0) mrr += 1 / (rank + 1);
    }
    lat.sort((a, b) => a - b);
    results[model] = {
      r1: (100 * r1 / probes.length), r3: (100 * r3 / probes.length),
      mrr: mrr / probes.length, searchMs: lat[Math.floor(lat.length / 2)],
    };
    console.log('done');
  }

  // Live query-embedding latency, measured separately from search.
  console.log('\n  measuring query-embedding API latency…');
  for (const model of MODELS) {
    const t = [];
    for (let i = 0; i < 6; i++) {
      const s = Date.now();
      await openai.embeddings.create({ model, input: 'كم سعر الشقة في مشروع درة الرياض؟', dimensions: DIMS });
      t.push(Date.now() - s);
    }
    t.sort((a, b) => a - b);
    results[model].embedMs = t[3];
  }

  console.log('\n─── RETRIEVAL QUALITY (higher is better) ───');
  console.log('  model                       recall@1   recall@3      MRR   embedAPI   search');
  for (const m of MODELS) {
    const x = results[m];
    console.log(`  ${m.padEnd(26)} ${(x.r1.toFixed(1) + '%').padStart(7)}   ${(x.r3.toFixed(1) + '%').padStart(8)}   ${x.mrr.toFixed(3).padStart(6)}   ${(x.embedMs + 'ms').padStart(8)}   ${(x.searchMs + 'ms').padStart(6)}`);
  }
  const [s, l] = MODELS.map((m) => results[m]);
  console.log(`\n  Δ recall@1 ${(l.r1 - s.r1 >= 0 ? '+' : '')}${(l.r1 - s.r1).toFixed(1)} pts · Δ recall@3 ${(l.r3 - s.r3 >= 0 ? '+' : '')}${(l.r3 - s.r3).toFixed(1)} pts · Δ MRR ${(l.mrr - s.mrr >= 0 ? '+' : '')}${(l.mrr - s.mrr).toFixed(3)} · Δ latency ${(l.embedMs - s.embedMs >= 0 ? '+' : '')}${l.embedMs - s.embedMs}ms`);

  for (const m of MODELS) await pool.query(`DROP TABLE IF EXISTS bench_emb_${m.split('-').pop()}`);
  await close();
})().catch((e) => { console.error('error:', e.message); process.exit(1); });
