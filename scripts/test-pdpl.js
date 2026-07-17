// Proof suite for the PDPL baseline (Task #5): field encryption, PII redaction,
// data retention. Run: node --test scripts/test-pdpl.js
const path = require('node:path');
const os = require('node:os');
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = path.join(os.tmpdir(), `pdpl-${Date.now()}.db`);

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const enc = require('../lib/crypto');
const retention = require('../lib/retention');

const KEY = { DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };

// ── field encryption (AES-256-GCM) ──────────────────────────────
test('encrypt→decrypt round-trip', () => {
  const pt = '+966500000001';
  const ct = enc.encrypt(pt, KEY);
  assert.ok(enc.isEncrypted(ct) && ct.startsWith('v1:'));
  assert.notEqual(ct, pt, 'ciphertext differs from plaintext');
  assert.equal(enc.decrypt(ct, KEY), pt, 'decrypts back to the original');
});
test('tamper detection: modified ciphertext fails auth', () => {
  const parts = enc.encrypt('secret transcript', KEY).split(':');
  parts[3] = parts[3].slice(0, -1) + (parts[3].slice(-1) === 'A' ? 'B' : 'A');
  assert.throws(() => enc.decrypt(parts.join(':'), KEY));
});
test('wrong key cannot decrypt', () => {
  const ct = enc.encrypt('x', KEY);
  assert.throws(() => enc.decrypt(ct, { DATA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') }));
});
test('no key → passthrough (dev), isEnabled false', () => {
  assert.equal(enc.isEnabled({}), false);
  assert.equal(enc.encrypt('plain', {}), 'plain');
});
test('rejects a wrong-length key', () => {
  assert.throws(() => enc.encrypt('x', { DATA_ENCRYPTION_KEY: 'too-short' }));
});

// ── PII redaction for logs ──────────────────────────────────────
test('redactPhone masks digits', () => {
  const r = enc.redactPhone('call +966500123456 now');
  assert.ok(!r.includes('500123456') && r.includes('***'));
});
test('redactPII masks phone/transcript fields, leaves others', () => {
  const r = enc.redactPII({ caller_number: '+966500123456', note: 'ok', transcript: 'رقمي 0500123456' });
  assert.ok(!r.caller_number.includes('500123456'));
  assert.equal(r.note, 'ok');
});

// ── data retention ──────────────────────────────────────────────
test('config reads per-kind windows from env', () => {
  const cfg = retention.config({ RETENTION_DAYS_CALLS: '90', RETENTION_DAYS_CHATS: '0' });
  assert.equal(cfg.length, 1);
  assert.equal(cfg[0].kind, 'calls');
  assert.equal(cfg[0].days, 90);
});
test('purge deletes ONLY rows older than the window (sqlite)', async () => {
  const db = require('../db');
  await db.initDb();
  await db.sql.insertCompany.run({ id: 'co-r', user_id: null, name: 'R', language: 'ar-SA', voice_id: null, phone_number: null, assistant_id: null, system_prompt: '', kb_text: null });
  const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
  const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();
  await db.run('INSERT INTO chats (company_id, session_id, user_message, created_at) VALUES (?,?,?,?)', ['co-r', 's1', 'old', old]);
  await db.run('INSERT INTO chats (company_id, session_id, user_message, created_at) VALUES (?,?,?,?)', ['co-r', 's2', 'recent', recent]);
  const deleteOlderThan = async (table, col, cutoff) => {
    const r = await db.run(`DELETE FROM ${table} WHERE company_id='co-r' AND ${col} < ?`, [cutoff]);
    return r.changes;
  };
  const results = await retention.purge(deleteOlderThan, { RETENTION_DAYS_CHATS: '30' });
  assert.equal(results.find((x) => x.kind === 'chats').deleted, 1, 'one old row deleted');
  const remaining = await db.all("SELECT user_message FROM chats WHERE company_id='co-r'");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].user_message, 'recent', 'the recent row is kept');
});

after(() => { try { fs.unlinkSync(process.env.DB_PATH); } catch { /* locked on win */ } });
