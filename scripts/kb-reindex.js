// Rebuild the vector index for documents that were uploaded but never chunked.
//
//   node --use-system-ca scripts/kb-reindex.js --list
//   node --use-system-ca scripts/kb-reindex.js --company co-xxxx
//   node --use-system-ca scripts/kb-reindex.js --company co-xxxx --force
//
// Works from the raw_text already stored on each document, so the original
// uploaded files are NOT needed. Without chunks the in-call knowledge-base tool
// authenticates, routes and scopes correctly and then answers "لا توجد معلومات
// مطابقة" to everything — a failure that looks like a broken agent rather than
// an empty index.
//
// Embedding costs money per document, so by default a document that already
// has chunks is skipped; --force purges and rebuilds it.
require('dotenv').config({ quiet: true });
const { sql, all: dataAll } = require('../db');
const { chunkText, embedBatch, vecToBuffer, invalidateChunkCache } = require('../lib/rag');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2); const n = argv[i + 1];
    if (!n || n.startsWith('--')) out[k] = true; else { out[k] = n; i++; }
  }
  return out;
}
const args = parseArgs(process.argv);

const BATCH = 64;

async function listAll() {
  const companies = await sql.listCompanies.all();
  console.log('\n  company                 live  chunks  deleted  status');
  console.log('  ' + '─'.repeat(76));
  for (const c of companies) {
    // Deleted documents are counted separately and deliberately. An empty index
    // caused by DELETED documents looks identical to one caused by a failed
    // ingest, and the fix is completely different: re-upload versus re-index.
    const docs = await dataAll(
      `SELECT d.id, d.deleted_at,
              (SELECT COUNT(*) FROM kb_chunks WHERE document_id = d.id) AS n
         FROM kb_documents d WHERE d.company_id = ?`,
      [c.id],
    );
    const live = docs.filter((d) => !d.deleted_at);
    const gone = docs.length - live.length;
    const chunks = live.reduce((s, d) => s + Number(d.n), 0);
    const unindexed = live.filter((d) => Number(d.n) === 0).length;
    const status = !docs.length ? 'no documents at all'
      : !live.length ? `ALL ${gone} document(s) deleted — upload one to use RAG`
        : unindexed ? `${unindexed} live document(s) NOT indexed — run with --company ${c.id}`
          : 'indexed';
    console.log(`  ${String(c.id).padEnd(22)} ${String(live.length).padStart(4)} ${String(chunks).padStart(7)} ${String(gone).padStart(8)}  ${status}`);
  }
  console.log('');
}

async function reindex(companyId) {
  const company = (await sql.listCompanies.all()).find((c) => c.id === companyId);
  if (!company) { console.error(`company "${companyId}" not found`); process.exit(1); }

  const docs = await dataAll(
    `SELECT d.id, d.filename, d.raw_text,
            (SELECT COUNT(*) FROM kb_chunks WHERE document_id = d.id) AS n
       FROM kb_documents d
      WHERE d.company_id = ? AND d.deleted_at IS NULL
      ORDER BY d.id`,
    [companyId],
  );
  if (!docs.length) { console.log(`\n  ${companyId} has no documents.\n`); return; }

  console.log(`\n  company ${companyId} (${company.name})\n`);
  let built = 0; let skipped = 0;

  for (const d of docs) {
    const have = Number(d.n);
    const label = `doc ${d.id}`;
    if (have > 0 && !args.force) {
      console.log(`  ${label}  skip — already has ${have} chunk(s); use --force to rebuild`);
      skipped++;
      continue;
    }
    const text = String(d.raw_text || '');
    if (text.trim().length < 50) {
      console.log(`  ${label}  skip — no usable raw_text (${text.length} chars)`);
      skipped++;
      continue;
    }
    if (have > 0) await sql.purgeDocumentChunks.run(d.id);

    const chunks = chunkText(text);
    if (!chunks.length) { console.log(`  ${label}  skip — produced no chunks`); skipped++; continue; }

    let idx = 0;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const vectors = await embedBatch(batch);
      for (let j = 0; j < batch.length; j++) {
        await sql.insertChunk.run({
          company_id : companyId,
          document_id: d.id,
          chunk_index: idx++,
          text       : batch[j],
          // Arabic ≈ 2 chars/token — the same rough estimate ingestDocument uses.
          token_count: Math.ceil(batch[j].length / 2),
          embedding  : vecToBuffer(vectors[j]),
        });
      }
    }
    console.log(`  ${label}  indexed ${chunks.length} chunk(s)  (${text.length} chars)`);
    built++;
  }

  invalidateChunkCache(companyId);
  const total = (await sql.countCompanyChunks.get(companyId))?.n ?? 0;
  console.log(`\n  ${built} document(s) indexed, ${skipped} skipped — ${total} chunk(s) total for ${companyId}\n`);
}

(async () => {
  if (args.list || !args.company) {
    await listAll();
    if (!args.company) console.log('  Usage: node --use-system-ca scripts/kb-reindex.js --company <id> [--force]\n');
    return;
  }
  await reindex(String(args.company));
})().then(() => process.exit(0))
  .catch((e) => { console.error('\nreindex failed:', e.message); process.exit(1); });
