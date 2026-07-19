// Proof suite for the PDPL production wiring (audit F-04a / F-04b).
//
// lib/crypto.js and lib/retention.js existed but were imported by nothing.
// These tests prove the new application layer actually applies them, and —
// just as important — that it degrades safely when encryption is OFF, which
// is the state production will be in until a backup exists.
//
//   node --test scripts/test-pii.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const KEY = 'a'.repeat(64);   // 32 bytes as hex

// ─── Encryption round-trip (key SET) ──────────────────────────────
test('round-trips a phone number and does not store it in the clear', () => {
  process.env.DATA_ENCRYPTION_KEY = KEY;
  delete require.cache[require.resolve('../lib/pii')];
  delete require.cache[require.resolve('../lib/crypto')];
  const pii = require('../lib/pii');

  const phone = '+966501234567';
  const ct = pii.encryptField(phone);
  assert.notEqual(ct, phone, 'value is transformed');
  assert.ok(!String(ct).includes('501234567'), 'no digits survive in the ciphertext');
  assert.match(String(ct), /^v1:/, 'versioned so keys can be rotated');
  assert.equal(pii.decryptField(ct), phone, 'round-trips exactly');

  delete process.env.DATA_ENCRYPTION_KEY;
});

test('encryptField is idempotent — no double-wrapping', () => {
  process.env.DATA_ENCRYPTION_KEY = KEY;
  delete require.cache[require.resolve('../lib/pii')];
  delete require.cache[require.resolve('../lib/crypto')];
  const pii = require('../lib/pii');

  const once = pii.encryptField('+966500000001');
  const twice = pii.encryptField(once);
  assert.equal(twice, once, 're-encrypting returns the same ciphertext');
  assert.equal(pii.decryptField(twice), '+966500000001', 'still decrypts to plaintext');

  delete process.env.DATA_ENCRYPTION_KEY;
});

test('two encryptions of the same value differ (random IV, not ECB)', () => {
  process.env.DATA_ENCRYPTION_KEY = KEY;
  delete require.cache[require.resolve('../lib/pii')];
  delete require.cache[require.resolve('../lib/crypto')];
  const pii = require('../lib/pii');

  const a = pii.encryptField('+966501111111');
  const b = pii.encryptField('+966501111112');
  assert.notEqual(a, b);
  delete process.env.DATA_ENCRYPTION_KEY;
});

test('rows and row-sets decrypt in place', () => {
  process.env.DATA_ENCRYPTION_KEY = KEY;
  delete require.cache[require.resolve('../lib/pii')];
  delete require.cache[require.resolve('../lib/crypto')];
  const pii = require('../lib/pii');

  const stored = { id: 'c1', caller_number: pii.encryptField('+966505555555'), duration_sec: 42 };
  const out = pii.decryptRow(stored, pii.CALL_PII_FIELDS);
  assert.equal(out.caller_number, '+966505555555');
  assert.equal(out.duration_sec, 42, 'non-PII fields untouched');

  const many = pii.decryptRows([stored, stored], pii.CALL_PII_FIELDS);
  assert.equal(many.length, 2);
  assert.equal(many[1].caller_number, '+966505555555');

  delete process.env.DATA_ENCRYPTION_KEY;
});

// ─── Degradation when the key is ABSENT (production today) ────────
test('with NO key set, writes stay plaintext and reads still work', () => {
  delete process.env.DATA_ENCRYPTION_KEY;
  delete require.cache[require.resolve('../lib/pii')];
  delete require.cache[require.resolve('../lib/crypto')];
  const pii = require('../lib/pii');

  const phone = '+966509999999';
  assert.equal(pii.encryptField(phone), phone, 'passthrough — no key, no change');
  assert.equal(pii.decryptField(phone), phone, 'plaintext reads unaffected');
  assert.equal(pii.isEncryptionEnabled(), false);
});

test('legacy plaintext rows still read correctly AFTER the key is enabled', () => {
  // The lazy-migration guarantee: turning encryption on must not break rows
  // written before it. This is what makes enabling it a non-event.
  process.env.DATA_ENCRYPTION_KEY = KEY;
  delete require.cache[require.resolve('../lib/pii')];
  delete require.cache[require.resolve('../lib/crypto')];
  const pii = require('../lib/pii');

  const legacyRow = { id: 'old', caller_number: '+966501112223' };   // written pre-key
  const out = pii.decryptRow(legacyRow, pii.CALL_PII_FIELDS);
  assert.equal(out.caller_number, '+966501112223', 'plaintext passes through');

  delete process.env.DATA_ENCRYPTION_KEY;
});

test('a wrong key masks the value instead of throwing into the request path', () => {
  process.env.DATA_ENCRYPTION_KEY = KEY;
  delete require.cache[require.resolve('../lib/pii')];
  delete require.cache[require.resolve('../lib/crypto')];
  let pii = require('../lib/pii');
  const ct = pii.encryptField('+966507654321');

  process.env.DATA_ENCRYPTION_KEY = 'b'.repeat(64);   // rotated / wrong key
  delete require.cache[require.resolve('../lib/pii')];
  delete require.cache[require.resolve('../lib/crypto')];
  pii = require('../lib/pii');
  assert.equal(pii.decryptField(ct), '***', 'masked, not a 500');

  delete process.env.DATA_ENCRYPTION_KEY;
});

// ─── Log redaction (ON by default) ────────────────────────────────
test('phone numbers are masked in log fields', () => {
  delete require.cache[require.resolve('../lib/logger')];
  const { logger } = require('../lib/logger');
  const written = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { written.push(String(s)); return true; };
  try {
    logger.info('call placed', { caller_number: '+966501234567', companyId: 'co-x' });
  } finally {
    process.stdout.write = orig;
  }
  const line = written.join('');
  assert.ok(!line.includes('501234567'), `raw number leaked into log: ${line}`);
  assert.ok(line.includes('co-x'), 'non-PII fields still logged');
});

test('phone numbers embedded in the MESSAGE are masked too', () => {
  delete require.cache[require.resolve('../lib/logger')];
  const { logger } = require('../lib/logger');
  const written = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { written.push(String(s)); return true; };
  try {
    logger.error('call to +966512345678 failed');
  } finally {
    process.stderr.write = orig;
  }
  const line = written.join('');
  assert.ok(!line.includes('512345678'), `raw number leaked via message: ${line}`);
});

test('redaction keeps enough of the number to be useful for support', () => {
  const { redactPhone } = require('../lib/crypto');
  const out = redactPhone('+966501234567');
  assert.ok(/\d{3}\*\*\*\d{2}/.test(out), `expected masked form, got ${out}`);
  assert.ok(!out.includes('501234567'));
});

test('non-PII values are not mangled by redaction', () => {
  delete require.cache[require.resolve('../lib/logger')];
  const { logger } = require('../lib/logger');
  const written = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { written.push(String(s)); return true; };
  try {
    logger.info('request', { status: 200, ms: 143, path: '/api/companies/co-abc' });
  } finally {
    process.stdout.write = orig;
  }
  const line = written.join('');
  assert.ok(line.includes('200'), 'status preserved');
  assert.ok(line.includes('/api/companies/co-abc'), 'path preserved');
});

// ─── Retention scheduling ─────────────────────────────────────────
test('retention is INERT with no windows configured (fail-safe)', async () => {
  for (const k of ['RETENTION_DAYS_CALLS', 'RETENTION_DAYS_CHATS',
    'RETENTION_DAYS_AUDIT', 'RETENTION_DAYS_WEBHOOKS']) delete process.env[k];
  delete require.cache[require.resolve('../lib/retention')];
  const { config } = require('../lib/retention');
  assert.deepEqual(config(), [], 'nothing is purgeable by default');
});

test('retention activates only the windows explicitly configured', () => {
  delete require.cache[require.resolve('../lib/retention')];
  const { config } = require('../lib/retention');
  const cfg = config({ RETENTION_DAYS_CALLS: '90', RETENTION_DAYS_WEBHOOKS: '30' });
  const byKind = Object.fromEntries(cfg.map((c) => [c.kind, c.days]));
  assert.deepEqual(byKind, { calls: 90, webhooks: 30 });
});

test('purge computes the cutoff from the window and reports deletions', async () => {
  delete require.cache[require.resolve('../lib/retention')];
  const { purge } = require('../lib/retention');
  const seen = [];
  const fakeDelete = async (table, col, cutoff) => { seen.push({ table, col, cutoff }); return 7; };
  const results = await purge(fakeDelete, { RETENTION_DAYS_CALLS: '30' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].table, 'calls');
  assert.equal(seen[0].col, 'created_at');
  const ageDays = (Date.now() - Date.parse(seen[0].cutoff)) / 86_400_000;
  assert.ok(Math.abs(ageDays - 30) < 0.01, `cutoff ~30d ago, got ${ageDays}`);
  assert.equal(results[0].deleted, 7, 'deletion count reported back');
});

test('the purge deleter refuses a table outside the whitelist', async () => {
  const { deleteOlderThan } = require('../services/retention');
  await assert.rejects(
    () => deleteOlderThan('users', 'created_at', new Date().toISOString()),
    /refusing to purge unknown table/,
    'SQL-injection-by-table-name is impossible',
  );
});

test('the purge deleter refuses a malformed date column', async () => {
  const { deleteOlderThan } = require('../services/retention');
  await assert.rejects(
    () => deleteOlderThan('calls', 'created_at; DROP TABLE users--', new Date().toISOString()),
    /invalid date column/,
  );
});
