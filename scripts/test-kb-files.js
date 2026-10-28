// Knowledge-base uploads: PDFs are read again, Arabic comes out in reading
// order, and every refusal is in Arabic.
//
// Real ingest against a throwaway SQLite DB; the embeddings endpoint is a
// local fake, so no network.
//
//   node --test scripts/test-kb-files.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const DB = path.join(require('node:os').tmpdir(), `sa-kb-${Date.now()}.db`);
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = DB;
process.env.OPENAI_API_KEY = 'sk-test';

// The embeddings endpoint: answers with unit vectors, or fails on demand.
let embeddingsFail = false;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (embeddingsFail) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"boom"}}'); }
    const input = JSON.parse(body).input;
    const vec = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: input.map((_, index) => ({ object: 'embedding', index, embedding: vec })), model: 'x', usage: { prompt_tokens: 1, total_tokens: 1 } }));
  });
});

let sql; let db; let rag; let pdfText;
before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${fake.address().port}/v1`;
  ({ sql, db } = require('../db'));
  rag = require('../lib/rag');
  pdfText = require('../lib/pdf-text');
  db.prepare("INSERT INTO companies (id, name, language, system_prompt) VALUES ('kb-co', 'شركة', 'ar', '')").run();
});
after(() => {
  fake.close();
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
});

// A real, minimal PDF: one page, the standard Helvetica font, one line per entry.
function makePdf(lines) {
  const ops = lines.map((l, i) => `BT /F1 14 Tf 72 ${760 - i * 24} Td (${l}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const LINES = [
  'Al Waha residential project, north Riyadh.',
  'Apartments start from 750,000 SAR and villas from 1,900,000 SAR.',
  'The sales centre opens Sunday to Thursday, nine to nine.',
  'Every unit comes with smart home systems and private parking.',
];

// ─── PDFs are read at all ─────────────────────────────────────────
test('a PDF is read (the pdf-parse upgrade had made every PDF upload fail)', async () => {
  const text = await rag.extractText(makePdf(LINES), 'application/pdf', 'brochure.pdf');
  for (const l of LINES) assert.ok(text.includes(l), `missing: ${l}\n--- got:\n${text}`);
  assert.doesNotMatch(text, /-- \d+ of \d+ --/, 'no page markers in the facts');
});

test('the uploaded bytes are left intact for storage', async () => {
  const buf = makePdf(LINES);
  const copy = Buffer.from(buf);
  await rag.extractText(buf, 'application/pdf', 'brochure.pdf');
  assert.equal(buf.length, copy.length);
  assert.ok(buf.equals(copy));
});

test('a .pdf sent without a proper type is still read by its extension', async () => {
  const text = await rag.extractText(makePdf(LINES), 'application/octet-stream', 'brochure.pdf');
  assert.ok(text.includes(LINES[0]));
});

// ─── Arabic in reading order ──────────────────────────────────────
// Runs as Chrome draws them for «متراً مربعاً، بثلاث»: glyph by glyph, left to
// right, as presentation forms. The tanween is its own zero-width run, once
// drawn just before its alif and once glued to a stray space.
const item = (str, x, w = 5, y = 383) => ({ str, transform: [14, 0, 0, 14, x, y], width: w, hasEOL: false });
const CHROME_LINE = [
  item('ﺛ', 492, 3.4), item('ﻼ', 483.6, 8.4), item('ث', 473.6, 10),
].reverse().concat([
  item('ﺑ', 495.4, 3.4), item(' ', 498.8, 5.2), item('،', 502.7, 4.5), item('ً', 506.3, 0),
  item('ﺎ', 507.2, 3.2), item('ﻌ', 510.4, 5.5), item('ﺑ', 515.9, 3.4), item('ر', 519.3, 6.8), item('ﻣ', 526.2, 5.5),
  item(' ً', 535.1, 0), item(' ', 531.7, 5.2), item('ا', 535.6, 2.9), item('ر', 538.5, 6.8), item('ﺗ', 545.3, 4), item('ﻣ', 549.3, 5.5),
]);

test('an Arabic line drawn in visual order reads right to left again', () => {
  assert.equal(pdfText.foldPresentationForms(pdfText.pageText(CHROME_LINE)), 'متراً مربعاً، بثلاث');
});

test('digits and Latin inside an Arabic line keep their own direction', () => {
  // «من 750,000 ريال» drawn left to right, one glyph per run.
  const runs = [
    item('ل', 300, 5), item('ﺎ', 305, 3), item('ﻳ', 308, 3), item('ر', 311, 5), item(' ', 316, 4),
    ...'750,000'.split('').map((c, i) => item(c, 320 + i * 6, 6)),
    item(' ', 362, 4), item('ﻦ', 366, 6), item('ﻣ', 372, 5),
  ];
  assert.equal(pdfText.foldPresentationForms(pdfText.pageText(runs)), 'من 750,000 ريال');
});

test('lines stay in drawing order, so two columns are not interleaved', () => {
  const col = (x, y, word) => ({ str: word, transform: [14, 0, 0, 14, x, y], width: 40, hasEOL: true });
  // Column A is drawn whole, then column B — at the same heights.
  const text = pdfText.pageText([col(400, 700, 'الشقق'), col(400, 680, 'ثلاث غرف'), col(100, 700, 'الفلل'), col(100, 680, 'حديقة خاصة')]);
  assert.equal(text, 'الشقق\nثلاث غرف\nالفلل\nحديقة خاصة');
});

test('presentation forms and font look-alikes fold back to Arabic letters', () => {
  assert.equal(pdfText.foldPresentationForms('ﺗﺟﯾﺑﻲ ﻼ ﷼'), 'تجيبي لا ريال');
  assert.equal(pdfText.foldPresentationForms('مجھزة الھیكل کتب'), 'مجهزة الهيكل كتب');
  // Ordinary text is left exactly as it was.
  assert.equal(pdfText.foldPresentationForms('ﬁ 1,200 — "x"'), 'ﬁ 1,200 — "x"');
});

// ─── Refusals in Arabic ───────────────────────────────────────────
const ARABIC = /[؀-ۿ]/;

test('an unreadable PDF is refused in Arabic', async () => {
  await assert.rejects(rag.extractText(Buffer.from('%PDF-1.4 not really'), 'application/pdf', 'x.pdf'),
    (e) => ARABIC.test(e.message) && /PDF/.test(e.message));
});

test('an unsupported type is refused in Arabic', async () => {
  await assert.rejects(rag.extractText(Buffer.from('x'), 'application/vnd.ms-excel', 'prices.xls'),
    (e) => ARABIC.test(e.message) && !/Unsupported/i.test(e.message));
});

// ─── Text Postgres can store ──────────────────────────────────────
// Postgres refuses a NUL anywhere in a text value, so one stray 0x00 from a
// PDF's font map failed the whole upload ("invalid byte sequence for
// encoding UTF8: 0x00"). Control characters carry no text and go; tab and
// line breaks stay.
test('NUL and other control characters are taken out of extracted text', async () => {
  const text = await rag.extractText(Buffer.from('مشروع\u0000 الواحة\u0007\tشمال\r\nالرياض\u001F'), 'text/plain', 'a.txt');
  assert.equal(text, 'مشروع الواحة\tشمال\r\nالرياض');
});

test('a text file saved as "Unicode" (UTF-16) is read, not turned into NULs', async () => {
  const s = 'مشروع الواحة، شمال الرياض';
  const le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(s, 'utf16le')]);
  assert.equal(await rag.extractText(le, 'text/plain', 'le.txt'), s);
  const be = Buffer.from(le); be[0] = 0xFE; be[1] = 0xFF;
  for (let i = 2; i + 1 < be.length; i += 2) { const t = be[i]; be[i] = be[i + 1]; be[i + 1] = t; }
  assert.equal(await rag.extractText(be, 'text/plain', 'be.txt'), s);
  assert.equal(await rag.extractText(Buffer.from('﻿' + s, 'utf8'), 'text/plain', 'bom.txt'), s, 'a UTF-8 byte-order mark is dropped');
});

test('what is stored has no NUL in it', async () => {
  const body = 'مشروع الواحة السكني في شمال الرياض، شقق وفلل جاهزة للسكن.\u0000 '.repeat(4);
  const r = await rag.ingestDocument({ companyId: 'kb-co', filename: 'nul.txt', mime: 'text/plain', buffer: Buffer.from(body), audience: 'inbound' });
  const doc = db.prepare('SELECT raw_text FROM kb_documents WHERE id = ?').get(r.documentId);
  assert.ok(!doc.raw_text.includes('\u0000'));
  for (const c of db.prepare('SELECT text FROM kb_chunks WHERE document_id = ?').all(r.documentId)) {
    assert.ok(!c.text.includes('\u0000'));
  }
});

test('a file with too little text says why, in Arabic', async () => {
  await assert.rejects(rag.ingestDocument({ companyId: 'kb-co', filename: 'scan.pdf', mime: 'application/pdf', buffer: makePdf(['x']), audience: 'inbound' }),
    (e) => ARABIC.test(e.message));
});

// ─── The whole ingest ─────────────────────────────────────────────
test('a PDF ingests into a document and its searchable chunks', async () => {
  const lines = Array.from({ length: 6 }, (_, i) => `${LINES[i % LINES.length]} Section ${i + 1}.`);
  const r = await rag.ingestDocument({ companyId: 'kb-co', filename: 'كتيب.pdf', mime: 'application/pdf', buffer: makePdf(lines), audience: 'outbound' });
  assert.ok(r.documentId > 0);
  assert.ok(r.chunkCount >= 1);
  const doc = await sql.getDocument.get(r.documentId);
  assert.equal(doc.company_id, 'kb-co');
  assert.equal(doc.filename, 'كتيب.pdf');
  assert.ok(doc.raw_data && doc.raw_data.length > 0, 'the original file is kept for download');
  const chunks = db.prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE document_id = ?').get(r.documentId).n;
  assert.equal(chunks, r.chunkCount);
});

test('when indexing fails, nothing half-done is left in the knowledge base', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM kb_documents').get().n;
  embeddingsFail = true;
  try {
    const lines = Array.from({ length: 6 }, (_, i) => `${LINES[i % LINES.length]} Part ${i + 1}.`);
    await assert.rejects(rag.ingestDocument({ companyId: 'kb-co', filename: 'b.pdf', mime: 'application/pdf', buffer: makePdf(lines), audience: 'outbound' }),
      (e) => ARABIC.test(e.message));
  } finally {
    embeddingsFail = false;
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kb_documents').get().n, before);
});

// ─── Two knowledge bases: inbound (and WhatsApp), outbound ───────
const txt = (s) => Buffer.from(s.repeat(3));
const OASIS = 'مشروع الواحة السكني في حي النرجس، فلل بأسعار تبدأ من تسعمائة ألف ريال. ';
const CAMPAIGN = 'عرض حملة الخريف على شقق حي الملقا، خصم عشرة بالمئة لأول عشرين عميل. ';
const SHARED = 'ساعات العمل من الأحد إلى الخميس، من التاسعة صباحاً حتى الخامسة مساءً. ';

test('a document goes into one of the two knowledge bases; an upload naming neither is refused in Arabic', async () => {
  db.prepare("INSERT INTO companies (id, name, language, system_prompt) VALUES ('kb-split', 'شركة', 'ar', '')").run();
  await assert.rejects(rag.ingestDocument({ companyId: 'kb-split', filename: 'x.txt', mime: 'text/plain', buffer: txt(OASIS) }),
    (e) => ARABIC.test(e.message));
  const a = await rag.ingestDocument({ companyId: 'kb-split', filename: 'الواحة.txt', mime: 'text/plain', buffer: txt(OASIS), audience: 'inbound' });
  const b = await rag.ingestDocument({ companyId: 'kb-split', filename: 'الحملة.txt', mime: 'text/plain', buffer: txt(CAMPAIGN), audience: 'outbound' });
  assert.equal((await sql.getDocument.get(a.documentId)).audience, 'inbound');
  assert.equal((await sql.getDocument.get(b.documentId)).audience, 'outbound');
  const listed = await sql.listDocuments.all('kb-split');
  assert.deepEqual(listed.map((d) => d.audience).sort(), ['inbound', 'outbound']);
});

test('each agent searches only its own half; across both, a text in both halves comes back once', async () => {
  // The fake embeddings carry no meaning, so what is found is found by its words.
  const docsOf = (aud) => new Set(db.prepare('SELECT id FROM kb_documents WHERE company_id = ? AND audience = ?').all('kb-split', aud).map((d) => d.id));
  const inbound = await rag.retrieve('kb-split', 'مشروع الواحة', { topK: 10, audience: 'inbound' });
  assert.ok(inbound.length && inbound.every((c) => docsOf('inbound').has(c.documentId)));
  assert.deepEqual(await rag.retrieve('kb-split', 'مشروع الواحة', { topK: 10, audience: 'outbound' }), [],
    'the outbound agent never sees an inbound document');
  const outbound = await rag.retrieve('kb-split', 'حملة الخريف', { topK: 10, audience: 'outbound' });
  assert.ok(outbound.length && outbound.every((c) => docsOf('outbound').has(c.documentId)));
  assert.deepEqual(await rag.retrieve('kb-split', 'حملة الخريف', { topK: 10, audience: 'inbound' }), [],
    'nor the inbound agent an outbound one');
  // Both halves together -- a single agent answering both directions.
  assert.equal((await rag.retrieve('kb-split', 'حملة الخريف', { topK: 10 })).length, outbound.length);

  await rag.ingestDocument({ companyId: 'kb-split', filename: 'الدوام.txt', mime: 'text/plain', buffer: txt(SHARED), audience: 'inbound' });
  await rag.ingestDocument({ companyId: 'kb-split', filename: 'الدوام.txt', mime: 'text/plain', buffer: txt(SHARED), audience: 'outbound' });
  const both = await rag.retrieve('kb-split', 'ساعات العمل', { topK: 10 });
  const texts = both.map((c) => c.text);
  assert.equal(texts.length, new Set(texts).size, 'no text twice');
  assert.ok(texts.some((t) => t.includes('ساعات العمل')));
});

test('whose half an agent reads: its own when the scenario has an inbound part, all of it when one agent does both', () => {
  const { agentAudience, scenarioAudience } = require('../lib/kb-audience');
  const company = { agentId: 'agent_out', agentIdInbound: 'agent_in' };
  assert.equal(agentAudience(company, 'agent_in'), 'inbound');
  assert.equal(agentAudience(company, 'agent_out'), 'outbound');
  assert.equal(agentAudience(company, '{{system__agent_id}}'), null, 'an unfilled id searches everything rather than nothing');
  assert.equal(agentAudience({ agentId: 'agent_out', agentIdInbound: null }, 'agent_out'), null, 'one agent answers both directions');
  const withInbound = { instruction_prompt: 'صادر', instruction_prompt_inbound: 'وارد' };
  assert.equal(scenarioAudience(withInbound, true), 'inbound');     // WhatsApp, inbound calls
  assert.equal(scenarioAudience(withInbound, false), 'outbound');
  assert.equal(scenarioAudience({ instruction_prompt: 'كل شيء', instruction_prompt_inbound: '  ' }, true), null);
  assert.equal(scenarioAudience({ instructionPrompt: 'x', instructionPromptInbound: 'y' }, false), 'outbound', 'a shaped scenario too');
});
