// Proof suite for request validation (Task #1).
// Run: node --test scripts/test-validation.js
//
// Covers every category the hardening spec requires:
//   valid regression · missing required · wrong types · SQL-injection ·
//   XSS payloads · large payloads · unknown-key stripping · middleware 400/next ·
//   params (path-traversal) rejection · real parameterized-query SQLi safety.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Temp SQLite DB for the parameterized-query safety test. MUST be set before ./db is required.
const TMP_DB = path.join(os.tmpdir(), `valtest-${Date.now()}.db`);
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = TMP_DB;

const {
  agentChatBody, companyCreateBody, companyPatchBody, settingsBody,
  apiKeyCreateBody, scenarioCreateBody, campaignCreateBody, companyIdParam,
} = require('../lib/schemas');
const { validate } = require('../lib/validate');

const ok = (schema, val) => schema.safeParse(val).success;
const bad = (schema, val) => !schema.safeParse(val).success;

// ─────────────────────────── VALID REGRESSION ───────────────────────────
test('valid: agent/chat body passes', () => {
  assert.ok(ok(agentChatBody, { company_id: 'co-abc', customer_phone: '+966500000000', message: 'مرحبا' }));
});
test('valid: company create passes (id + name)', () => {
  assert.ok(ok(companyCreateBody, { id: 'co-test1', name: 'شركة وكن' }));
});
test('valid: settings partial patch passes', () => {
  assert.ok(ok(settingsBody, { stability: 0.8, model: 'gpt-4.1', voiceSpeed: 0.95 }));
});
test('valid: settings accepts numeric strings (form values)', () => {
  assert.ok(ok(settingsBody, { stability: '0.8', maxTokens: '400' }));
});
test('valid: scenario create passes (name + instructionPrompt)', () => {
  assert.ok(ok(scenarioCreateBody, { name: 'حملة', instructionPrompt: 'أنت ناصر من وكن' }));
});
test('valid: campaign create passes', () => {
  assert.ok(ok(campaignCreateBody, { name: 'حملة يوليو', numbersText: '+966500000000,أحمد' }));
});

// ─────────────────────────── MISSING REQUIRED ───────────────────────────
test('missing: agent/chat without message → rejected', () => {
  assert.ok(bad(agentChatBody, { customer_phone: '+966500000000' }));
});
test('missing: company create without id → rejected', () => {
  assert.ok(bad(companyCreateBody, { name: 'x' }));
});
test('missing: scenario without instructionPrompt → rejected', () => {
  assert.ok(bad(scenarioCreateBody, { name: 'x' }));
});
test('missing: empty/whitespace instructionPrompt → rejected', () => {
  assert.ok(bad(scenarioCreateBody, { name: 'x', instructionPrompt: '   ' }));
});

// ─────────────────────────── WRONG DATA TYPES ───────────────────────────
test('type: customer_phone as number → rejected', () => {
  assert.ok(bad(agentChatBody, { customer_phone: 12345, message: 'hi' }));
});
test('type: stability as non-numeric string → rejected', () => {
  assert.ok(bad(settingsBody, { stability: 'not-a-number' }));
});
test('type: isActive as string → rejected', () => {
  assert.ok(bad(scenarioCreateBody, { name: 'x', instructionPrompt: 'y', isActive: 'yes' }));
});
test('type: settings model outside whitelist → rejected', () => {
  assert.ok(bad(settingsBody, { model: 'gpt-5-ultra' }));
});

// ─────────────────────────── SQL INJECTION ──────────────────────────────
test('sqli: injection-shaped company id → rejected by id regex', () => {
  assert.ok(bad(companyCreateBody, { id: "co'; DROP TABLE companies;--", name: 'x' }));
});
test('sqli: injection string in a free-text NAME → accepted as a bounded string (defense is parameterized queries, verified below)', () => {
  const r = companyCreateBody.safeParse({ id: 'co-ok', name: "Robert'); DROP TABLE companies;--" });
  assert.ok(r.success);
  assert.equal(r.data.name, "Robert'); DROP TABLE companies;--"); // stored literally, not interpreted
});

// ─────────────────────────── XSS PAYLOADS ───────────────────────────────
test('xss: <script> in a text field → accepted as a bounded string (defense is output-encoding on render)', () => {
  const r = scenarioCreateBody.safeParse({ name: '<script>alert(1)</script>', instructionPrompt: 'x' });
  assert.ok(r.success);
  assert.equal(r.data.name, '<script>alert(1)</script>'); // preserved literally; never eval'd server-side
});
test('xss: oversized XSS blast in name → rejected by length cap', () => {
  assert.ok(bad(companyCreateBody, { id: 'co-ok', name: '<img src=x onerror=alert(1)>'.repeat(20) + 'A'.repeat(400) }));
});

// ─────────────────────────── LARGE PAYLOADS ─────────────────────────────
test('large: 5,000-char company name → rejected (max 200)', () => {
  assert.ok(bad(companyCreateBody, { id: 'co-ok', name: 'A'.repeat(5000) }));
});
test('large: 40,000-char instructionPrompt → rejected (max 30,000)', () => {
  assert.ok(bad(scenarioCreateBody, { name: 'x', instructionPrompt: 'A'.repeat(40000) }));
});

// ─────────────────────────── UNKNOWN-KEY STRIP ──────────────────────────
test('strip: unknown keys are removed before reaching the DB', () => {
  const r = companyCreateBody.parse({ id: 'co-ok', name: 'x', is_admin: true, evilSql: 'DROP' });
  assert.equal(r.is_admin, undefined);
  assert.equal(r.evilSql, undefined);
});

// ─────────────────────────── MIDDLEWARE BEHAVIOUR ───────────────────────
function mockRes() {
  return { statusCode: 200, payload: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.payload = b; return this; } };
}
function invoke(mw, req) {
  const res = mockRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  return { res, nexted };
}

test('middleware: invalid body → 400 with structured details, next NOT called', () => {
  const mw = validate({ body: agentChatBody });
  const { res, nexted } = invoke(mw, { body: { message: '' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'validation failed');
  assert.ok(Array.isArray(res.payload.details) && res.payload.details.length > 0);
  assert.equal(nexted, false);
});
test('middleware: valid body → next called and req.body stripped/typed', () => {
  const mw = validate({ body: companyCreateBody });
  const req = { body: { id: 'co-ok', name: 'x', hacker: 'yes' } };
  const { nexted } = invoke(mw, req);
  assert.equal(nexted, true);
  assert.equal(req.body.hacker, undefined);
});
test('middleware: params path-traversal id → 400', () => {
  const mw = validate({ params: companyIdParam });
  const { res, nexted } = invoke(mw, { params: { id: '../../etc/passwd' } });
  assert.equal(res.statusCode, 400);
  assert.equal(nexted, false);
});

// ─────────── REAL PARAMETERIZED-QUERY SQLi SAFETY (integration) ──────────
test('integration: malicious name stored literally, table intact (parameterized queries)', async () => {
  const db = require('../db');
  await db.initDb();
  const { sql } = db;
  const malName = "Robert'); DROP TABLE companies;--";
  const id = 'co-sqli-' + Date.now().toString(36);
  await sql.insertCompany.run({
    id, user_id: null, name: malName, language: 'ar-SA', voice_id: null,
    phone_number: null, assistant_id: null, system_prompt: '', kb_text: null,
  });
  const row = await sql.getCompany.get(id);
  assert.ok(row, 'row inserted');
  assert.equal(row.name, malName, 'name stored exactly — injection never executed');
  const again = await sql.getCompany.get(id);
  assert.ok(again, 'companies table still exists after malicious insert');
});

after(() => { try { fs.unlinkSync(TMP_DB); } catch { /* file may be locked on win */ } });
