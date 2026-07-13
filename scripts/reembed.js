// Re-embed every KB chunk with the CURRENT embedding model (EMBED_MODEL env).
// Run once after switching models — stored vectors and query vectors must
// come from the same model or cosine similarity is meaningless.
//
// Usage:
//   EMBED_MODEL=text-embedding-3-large node scripts/reembed.js [--company co-x]
//
// Works on either driver (uses the same ./db selector as the app). Safe to
// re-run; batches of 64; prints per-company progress.
require('dotenv').config();
const { sql } = require('../db');
const { embedBatch, vecToBuffer, EMBED_MODEL } = require('../lib/rag');

const argCo = process.argv.indexOf('--company');
const ONLY_COMPANY = argCo > -1 ? process.argv[argCo + 1] : null;

(async () => {
  console.log(`re-embedding with model: ${EMBED_MODEL}`);
  const companies = ONLY_COMPANY
    ? [{ id: ONLY_COMPANY }]
    : await sql.listCompanies.all();

  let totalChunks = 0;
  for (const c of companies) {
    const chunks = await sql.listCompanyChunkTexts.all(c.id);
    if (!chunks.length) continue;
    console.log(`  ${c.id}: ${chunks.length} chunks`);
    for (let i = 0; i < chunks.length; i += 64) {
      const batch = chunks.slice(i, i + 64);
      const vectors = await embedBatch(batch.map((b) => b.text));
      for (let j = 0; j < batch.length; j++) {
        await sql.updateChunkEmbedding.run({ id: batch[j].id, embedding: vecToBuffer(vectors[j]) });
      }
      process.stdout.write(`    ${Math.min(i + 64, chunks.length)}/${chunks.length}\r`);
    }
    console.log('');
    totalChunks += chunks.length;
  }
  console.log(`DONE — ${totalChunks} chunks re-embedded with ${EMBED_MODEL}`);
  process.exit(0);
})().catch((e) => { console.error('REEMBED ERROR:', e.message); process.exit(1); });
