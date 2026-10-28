// Migration 50: a knowledge base uploaded before the split into inbound and
// outbound becomes both, so no agent knows less the day it ships.
//
// A database is made with the current schema, then put back the way it was
// before the split (no audience column, migration 50 not recorded, documents
// with chunks), and opened again in a fresh process -- which is what runs
// the migration.
//
//   node --test scripts/test-kb-split.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const DB = path.join(require('node:os').tmpdir(), `sa-kbsplit-${Date.now()}.db`);
const ROOT = path.join(__dirname, '..');
const run = (code) => JSON.parse(execFileSync(process.execPath, ['-e', code], {
  cwd: ROOT, env: { ...process.env, DB_DRIVER: 'sqlite', DB_PATH: DB }, encoding: 'utf8',
}).split('\n').filter((l) => l.startsWith('@@')).pop().slice(2));

after(() => { for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true }); });

test('documents from before the split serve both agents afterwards; a deleted one is not brought back', () => {
  run(`
    const { db } = require('./db');
    db.prepare("INSERT INTO companies (id, name, language, system_prompt) VALUES ('co', 'شركة', 'ar', '')").run();
    db.exec('ALTER TABLE kb_documents DROP COLUMN audience');
    db.prepare('DELETE FROM schema_migrations WHERE id = 50').run();
    const doc = db.prepare("INSERT INTO kb_documents (company_id, filename, raw_text, raw_data, created_at) VALUES ('co', ?, 'نص', ?, '2026-10-01 10:00:00')");
    const live = doc.run('الأسعار.pdf', Buffer.from('pdf')).lastInsertRowid;
    const gone = doc.run('قديم.pdf', null).lastInsertRowid;
    db.prepare("UPDATE kb_documents SET deleted_at = datetime('now') WHERE id = ?").run(gone);
    const chunk = db.prepare("INSERT INTO kb_chunks (company_id, document_id, chunk_index, text, embedding) VALUES ('co', ?, ?, ?, ?)");
    chunk.run(live, 0, 'الفيلا بمليون ريال', Buffer.from([1, 2, 3, 4]));
    chunk.run(live, 1, 'الشقة بخمسمائة ألف', Buffer.from([5, 6, 7, 8]));
    console.log('@@' + JSON.stringify({ ok: true }));
  `);

  const after = run(`
    const { db } = require('./db');
    const docs = db.prepare('SELECT id, filename, audience, deleted_at, created_at, raw_data FROM kb_documents ORDER BY id').all()
      .map((d) => ({ ...d, raw_data: d.raw_data ? d.raw_data.toString() : null }));
    const chunks = db.prepare('SELECT document_id, chunk_index, text, hex(embedding) AS e FROM kb_chunks ORDER BY document_id, chunk_index').all();
    const marked = db.prepare('SELECT name FROM schema_migrations WHERE id = 50').get();
    console.log('@@' + JSON.stringify({ docs, chunks, marked }));
  `);

  const live = after.docs.filter((d) => !d.deleted_at);
  assert.deepEqual(live.map((d) => [d.filename, d.audience]), [['الأسعار.pdf', 'outbound'], ['الأسعار.pdf', 'inbound']]);
  assert.equal(live[1].created_at, '2026-10-01 10:00:00', 'the copy keeps the upload date');
  assert.equal(live[1].raw_data, 'pdf', 'and the original file, for download');
  const of = (id) => after.chunks.filter((c) => c.document_id === id).map((c) => [c.chunk_index, c.text, c.e]);
  assert.deepEqual(of(live[1].id), of(live[0].id), 'the same chunks and embeddings, nothing re-indexed');
  assert.equal(of(live[0].id).length, 2);

  const gone = after.docs.find((d) => d.deleted_at);
  assert.equal(gone.audience, 'outbound');
  assert.equal(after.docs.length, 3, 'a deleted document is not copied');
  assert.equal(after.marked.name, 'split_kb_by_direction');

  // Opening it again changes nothing.
  const again = run(`
    const { db } = require('./db');
    console.log('@@' + JSON.stringify(db.prepare('SELECT COUNT(*) AS n FROM kb_documents').get()));
  `);
  assert.equal(again.n, 3);
});
