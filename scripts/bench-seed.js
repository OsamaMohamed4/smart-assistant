// Seeds a realistic Saudi real-estate KB into a Postgres+pgvector instance so
// retrieval changes can be benchmarked against real embeddings and real
// pgvector behaviour — not mocks.
//
//   DATABASE_URL=postgres://postgres:test@localhost:5445/satest \
//   node --use-system-ca scripts/bench-seed.js
require('dotenv').config({ quiet: true });
process.env.DB_DRIVER = 'postgres';

const { sql, initDb } = require('../db');
const { getPool, close } = require('../lib/db-pg');
const { embedBatch, vecToBuffer } = require('../lib/rag');

// Corpus sizes to seed, each as its own company, so the same query can be
// replayed against a small / medium / large knowledge base.
const SIZES = { 'bench-150': 150, 'bench-500': 500, 'bench-1000': 1000 };

const DISTRICTS = ['الياسمين', 'النرجس', 'الملقا', 'حطين', 'العارض', 'القيروان', 'الصحافة', 'الربيع', 'النخيل', 'الورود'];
const PROJECTS  = ['درة الرياض', 'واحة النخيل', 'مسار الشمال', 'أبراج القيروان', 'منتجع الصحافة', 'حدائق الملقا', 'برج حطين', 'مجمع العارض'];
const TYPES     = ['شقة', 'فيلا', 'دوبلكس', 'تاون هاوس', 'أرض سكنية', 'مكتب تجاري'];
const BANKS     = ['البنك الأهلي السعودي', 'مصرف الراجحي', 'بنك الرياض', 'البنك السعودي الفرنسي'];

// Deterministic pseudo-random so reruns produce the identical corpus and
// benchmark numbers stay comparable across runs.
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo));

function makeChunk(i) {
  const d = pick(DISTRICTS), p = pick(PROJECTS), t = pick(TYPES);
  const area = between(90, 450);
  const price = between(45, 320) * 10000;
  const rooms = between(2, 7);
  const down = between(10, 30);
  const months = between(6, 36);
  return `### ${p} — ${t} في حي ${d}
رقم الوحدة ${1000 + i}. النوع: ${t}. المساحة ${area} متر مربع.
عدد الغرف ${rooms} غرف نوم مع صالة ومطبخ و${between(2, 4)} دورات مياه.
السعر ${price.toLocaleString('en-US')} ريال سعودي شامل الضريبة.
الدفعة الأولى ${down} بالمئة من قيمة العقار.
الموقع: حي ${d} في مدينة الرياض، قريب من الخدمات والمدارس والمراكز التجارية.
التسليم خلال ${months} شهر من تاريخ التعاقد.
يتوفر تمويل عقاري بالتعاون مع ${pick(BANKS)} بنسبة تمويل تصل إلى ${between(70, 90)} بالمئة.
للاستفسار والمعاينة يرجى التواصل مع فريق المبيعات لتحديد موعد زيارة الموقع.`;
}

(async () => {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL required'); process.exit(1); }
  await initDb();
  const pool = getPool();

  for (const [companyId, n] of Object.entries(SIZES)) {
    await pool.query('DELETE FROM kb_chunks WHERE company_id = $1', [companyId]);
    await pool.query('DELETE FROM kb_documents WHERE company_id = $1', [companyId]);
    await pool.query('DELETE FROM companies WHERE id = $1', [companyId]);

    await sql.insertCompany.run({
      id: companyId, user_id: null, name: `Bench ${n}`, language: 'ar-SA',
      voice_id: null, phone_number: null, assistant_id: null,
      system_prompt: '', kb_text: null,
    });
    const doc = await sql.insertDocument.run({
      company_id: companyId, filename: 'bench-kb.md', mime_type: 'text/markdown',
      size_bytes: 0, raw_text: '', raw_data: Buffer.from(''),
    });
    const documentId = Number(doc.lastInsertRowid);

    seed = 42; // reset so every corpus starts from the same sequence
    const chunks = Array.from({ length: n }, (_, i) => makeChunk(i));
    const BATCH = 64;
    let idx = 0;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const vecs = await embedBatch(batch);
      for (let j = 0; j < batch.length; j++) {
        await sql.insertChunk.run({
          company_id: companyId, document_id: documentId, chunk_index: idx++,
          text: batch[j], embedding: vecToBuffer(vecs[j]),
          token_count: Math.ceil(batch[j].length / 2),
        });
      }
      process.stdout.write(`\r  ${companyId}: ${Math.min(i + BATCH, n)}/${n}   `);
    }
    console.log(`\r  ${companyId}: ${n} chunks seeded          `);
  }

  await pool.query('ANALYZE kb_chunks');
  const r = await pool.query('SELECT company_id, count(*)::int n FROM kb_chunks GROUP BY 1 ORDER BY 1');
  console.log('\nseeded:', r.rows.map((x) => `${x.company_id}=${x.n}`).join(' '));
  await close();
})().catch((e) => { console.error('seed error:', e.message); process.exit(1); });
