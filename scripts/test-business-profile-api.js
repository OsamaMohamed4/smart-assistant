// HTTP-level suite for the two business-profile endpoints.
//
//   node --test scripts/test-business-profile-api.js
//   DB_DRIVER=postgres DATABASE_URL=… npm run test:pg:profile-api
//
// These are the first tests in the repo that drive real express routes. That is
// deliberate rather than gratuitous: what is under test here is not a pure
// function — it is the authentication middleware, the tenant check inside
// requireCompanyAccess, the zod rejection path and the HTTP status codes. All
// four live in the request pipeline, and a unit test of the renderer proves
// nothing about any of them. So the suite boots the REAL server against a
// throwaway database, exactly as scripts/smoke-test.js does, and talks to it
// over HTTP.
//
// lib/business-profile.js is covered separately and at unit level by
// scripts/test-business-profile.js; this file does not re-test the renderer.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const IS_PG = (process.env.DB_DRIVER || '').toLowerCase() === 'postgres';
const DB = path.join(os.tmpdir(), `sa-profile-api-${Date.now()}.db`);
// A port of its own so this can run alongside the dev server (3000) and the
// smoke test (3955) without either stealing the other's socket.
const PORT = process.env.PROFILE_API_PORT || '3957';
const B = `http://127.0.0.1:${PORT}`;
const XHR = { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' };

const env = {
  ...process.env,
  DB_PATH: DB,
  PORT,
  NODE_ENV: 'development',
  // Deliberately fake — nothing in this suite reaches a provider.
  OPENAI_API_KEY: 'sk-profile-api-test',
  ELEVENLABS_API_KEY: 'profile-api-test',
  ELEVENLABS_WEBHOOK_SECRET: 'profile-api-webhook-secret',
};

let srv = null;
let serverOutput = '';
let suCookie = null;       // superadmin
let clientCookie = null;   // client pinned to companyA
let companyA = null;
let companyB = null;

async function req(path, { method = 'GET', cookie, body } = {}) {
  const res = await fetch(B + path, {
    method,
    headers: { ...XHR, ...(cookie ? { cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function resetPg() {
  if (!IS_PG) return;
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
}

async function waitForBoot() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(B + '/health'); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not boot on ${PORT}\n${serverOutput.slice(-2000)}`);
}

before(async () => {
  await resetPg();
  srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env });
  srv.stdout.on('data', (d) => { serverOutput += d; });
  srv.stderr.on('data', (d) => { serverOutput += d; });
  await waitForBoot();

  // First user becomes the platform superadmin.
  const su = await fetch(B + '/api/auth/signup', {
    method: 'POST',
    headers: XHR,
    body: JSON.stringify({ email: `su-${Date.now()}@test.local`, password: 'Sup3r!Secret#1' }),
  });
  suCookie = (su.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(suCookie, `bootstrap signup failed: ${su.status}`);

  // Ids are caller-supplied and must be [a-z0-9-]{1,40}. Namespaced per run so
  // a shared Postgres database can be reused without collisions.
  const RUN = Date.now().toString(36);
  companyA = `co-pa-${RUN}`;
  companyB = `co-pb-${RUN}`;
  const a = await req('/api/companies', {
    method: 'POST', cookie: suCookie, body: { id: companyA, name: 'شركة أ' },
  });
  const b = await req('/api/companies', {
    method: 'POST', cookie: suCookie, body: { id: companyB, name: 'شركة ب' },
  });
  assert.ok(a.status < 300 && b.status < 300,
    `company creation failed: ${a.status}/${b.status} ${a.text}${b.text}`);

  // An ACTIVE scenario on company A — publish-preview needs one, and the
  // byte-identical assertion is about the prompt it composes.
  const sc = await req(`/api/companies/${companyA}/scenarios`, {
    method: 'POST', cookie: suCookie,
    body: {
      name: 'سيناريو الاختبار',
      instructionPrompt: 'تعليمات المشغّل الأصلية. لا تُعدَّل من هذه الشاشة.',
      firstMessage: 'مرحبا',
      isActive: true,
    },
  });
  assert.ok(sc.status === 200 || sc.status === 201, `scenario creation failed: ${sc.status} ${sc.text}`);

  // A client user pinned to company A. The endpoint returns the generated
  // password once, which is how this suite gets a non-superadmin session.
  const cl = await req(`/api/companies/${companyA}/clients`, {
    method: 'POST', cookie: suCookie,
    body: { email: `client-${Date.now()}@test.local` },
  });
  assert.ok(cl.json?.password, `client creation failed: ${cl.status} ${cl.text}`);
  const login = await fetch(B + '/api/auth/login', {
    method: 'POST',
    headers: XHR,
    body: JSON.stringify({ email: cl.json.email, password: cl.json.password }),
  });
  clientCookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(clientCookie, `client login failed: ${login.status}`);
});

after(async () => {
  try { srv?.kill(); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 300));
  if (!IS_PG) for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
});

const FULL = {
  description: 'شركة عقارية سعودية.',
  workingHours: [
    { days: 'الأحد', from: '09:00', to: '17:00' },
    { days: 'الجمعة', closed: true },
  ],
  services: ['بيع العقارات', 'التسويق العقاري'],
  rules: ['جميع الأسعار بالريال السعودي'],
  extraFacts: [{ label: 'المقر', value: 'الرياض' }],
};

// ══ 1. Valid save ═════════════════════════════════════════════════
test('a valid profile saves and returns the rendered facts block', async () => {
  const r = await req(`/api/companies/${companyA}/business-profile`, {
    method: 'PATCH', cookie: suCookie, body: { businessProfile: FULL },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.businessProfile.description, FULL.description);
  assert.ok(r.json.factsBlock.includes('## معلومات الشركة'), 'block rendered');
  assert.ok(r.json.factsBlock.includes('- الأحد: 09:00 - 17:00'), 'hours rendered');
  assert.ok(r.json.factsBlock.includes('- الجمعة: مغلق'), 'closed day rendered');
  // Saving facts does NOT change the live agent — publishing does.
  assert.equal(r.json.needsPublish, true, 'the response says a publish is still required');
});

// ══ 2. Invalid rejection ══════════════════════════════════════════
test('an invalid profile is rejected with 400 and field-level issues', async () => {
  const r = await req(`/api/companies/${companyA}/business-profile`, {
    method: 'PATCH', cookie: suCookie, body: { businessProfile: { services: 'not-an-array' } },
  });
  assert.equal(r.status, 400);
  assert.ok(Array.isArray(r.json.issues) && r.json.issues.length, 'issues are returned');
  assert.equal(r.json.issues[0].path, 'services', 'the offending FIELD is named');
  assert.ok(r.json.issues[0].message, 'with a message');
});

test('a nested invalid field names its full path', async () => {
  const r = await req(`/api/companies/${companyA}/business-profile`, {
    method: 'PATCH', cookie: suCookie,
    body: { businessProfile: { workingHours: [{ from: '09:00' }] } },   // missing `days`
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.issues[0].path, 'workingHours.0.days');
});

test('a rejected save does NOT overwrite the stored profile', async () => {
  // The previous two tests sent garbage; the valid profile from test 1 must
  // still be intact, or a typo would wipe a company's data.
  const r = await req(`/api/companies/${companyA}/business-profile`, { cookie: suCookie });
  assert.equal(r.json.businessProfile.description, FULL.description);
});

test('oversized input is rejected rather than truncated', async () => {
  const r = await req(`/api/companies/${companyA}/business-profile`, {
    method: 'PATCH', cookie: suCookie,
    body: { businessProfile: { description: 'x'.repeat(4001) } },
  });
  assert.equal(r.status, 400);
});

// ══ 3. Empty save ═════════════════════════════════════════════════
test('an empty profile saves and clears the facts block', async () => {
  const r = await req(`/api/companies/${companyA}/business-profile`, {
    method: 'PATCH', cookie: suCookie, body: { businessProfile: {} },
  });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.businessProfile, {});
  assert.equal(r.json.factsBlock, '', 'an empty profile emits NO block');
});

// ══ 4–6. Authorization ════════════════════════════════════════════
test('a client may read and write its OWN company', async () => {
  const get = await req(`/api/companies/${companyA}/business-profile`, { cookie: clientCookie });
  assert.equal(get.status, 200, get.text);

  const patch = await req(`/api/companies/${companyA}/business-profile`, {
    method: 'PATCH', cookie: clientCookie,
    body: { businessProfile: { description: 'حرره العميل' } },
  });
  assert.equal(patch.status, 200, patch.text);
  assert.ok(patch.json.factsBlock.includes('حرره العميل'));
});

test('a client is DENIED another company, on every verb', async () => {
  const get = await req(`/api/companies/${companyB}/business-profile`, { cookie: clientCookie });
  assert.equal(get.status, 404, 'GET is refused');

  const patch = await req(`/api/companies/${companyB}/business-profile`, {
    method: 'PATCH', cookie: clientCookie, body: { businessProfile: { description: 'اختراق' } },
  });
  assert.equal(patch.status, 404, 'PATCH is refused');

  const preview = await req(`/api/companies/${companyB}/business-profile/preview`, {
    method: 'POST', cookie: clientCookie, body: { businessProfile: { description: 'اختراق' } },
  });
  assert.equal(preview.status, 404, 'the preview endpoint is refused too');
});

test('the denied write did not reach company B', async () => {
  // 404 must mean "refused", not "refused the response but performed the write".
  const r = await req(`/api/companies/${companyB}/business-profile`, { cookie: suCookie });
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.json.businessProfile).includes('اختراق'),
    'company B is untouched by the cross-tenant attempt');
});

test('an unauthenticated caller reaches neither endpoint', async () => {
  const get = await req(`/api/companies/${companyA}/business-profile`);
  assert.equal(get.status, 401);
  const preview = await req(`/api/companies/${companyA}/business-profile/preview`, {
    method: 'POST', body: { businessProfile: {} },
  });
  assert.equal(preview.status, 401);
});

test('a superadmin may read and write ANY company', async () => {
  for (const id of [companyA, companyB]) {
    const get = await req(`/api/companies/${id}/business-profile`, { cookie: suCookie });
    assert.equal(get.status, 200, `GET ${id}`);
  }
  const patch = await req(`/api/companies/${companyB}/business-profile`, {
    method: 'PATCH', cookie: suCookie, body: { businessProfile: { description: 'وصف شركة ب' } },
  });
  assert.equal(patch.status, 200);
});

// ══ 7. Tenant switching ═══════════════════════════════════════════
test('switching companies never returns the other tenant data', async () => {
  await req(`/api/companies/${companyA}/business-profile`, {
    method: 'PATCH', cookie: suCookie,
    body: { businessProfile: { description: 'وصف شركة أ', services: ['خدمة أ'] } },
  });
  await req(`/api/companies/${companyB}/business-profile`, {
    method: 'PATCH', cookie: suCookie,
    body: { businessProfile: { description: 'وصف شركة ب', services: ['خدمة ب'] } },
  });

  const a = await req(`/api/companies/${companyA}/business-profile`, { cookie: suCookie });
  const b = await req(`/api/companies/${companyB}/business-profile`, { cookie: suCookie });

  assert.equal(a.json.businessProfile.description, 'وصف شركة أ');
  assert.equal(b.json.businessProfile.description, 'وصف شركة ب');
  assert.ok(!JSON.stringify(a.json).includes('شركة ب'), 'A carries nothing of B');
  assert.ok(!JSON.stringify(b.json).includes('شركة أ'), 'B carries nothing of A');
});

test('a DRAFT preview is scoped to the company in the URL, not the draft body', async () => {
  // The preview renders the company NAME from the server-side record. Posting
  // company A's draft to company B's URL must render B's name — the body can
  // never choose the tenant.
  const draft = { businessProfile: { description: 'مسودة مشتركة' } };
  const onA = await req(`/api/companies/${companyA}/business-profile/preview`, {
    method: 'POST', cookie: suCookie, body: draft,
  });
  const onB = await req(`/api/companies/${companyB}/business-profile/preview`, {
    method: 'POST', cookie: suCookie, body: draft,
  });
  assert.equal(onA.status, 200);
  assert.equal(onB.status, 200);
  assert.ok(onA.json.factsBlock.includes('شركة أ'), 'A preview names A');
  assert.ok(onB.json.factsBlock.includes('شركة ب'), 'B preview names B');
  assert.ok(!onA.json.factsBlock.includes('شركة ب'));
});

test('a draft preview does NOT persist anything', async () => {
  const before = await req(`/api/companies/${companyA}/business-profile`, { cookie: suCookie });
  await req(`/api/companies/${companyA}/business-profile/preview`, {
    method: 'POST', cookie: suCookie,
    body: { businessProfile: { description: 'مسودة لم تُحفظ' } },
  });
  const after = await req(`/api/companies/${companyA}/business-profile`, { cookie: suCookie });
  assert.deepEqual(after.json.businessProfile, before.json.businessProfile,
    'previewing is read-only');
});

test('an invalid DRAFT reports issues without failing the request', async () => {
  // Mid-edit drafts are allowed to be invalid; the editor needs the issues, not
  // an error page.
  const r = await req(`/api/companies/${companyA}/business-profile/preview`, {
    method: 'POST', cookie: suCookie,
    body: { businessProfile: { workingHours: [{ from: '09:00' }] } },
  });
  assert.equal(r.status, 200, 'a bad draft is still a 200');
  assert.equal(r.json.valid, false);
  assert.equal(r.json.factsBlock, '', 'and renders nothing rather than half a block');
  assert.equal(r.json.issues[0].path, 'workingHours.0.days');
});

// ══ 8. Round-trip ═════════════════════════════════════════════════
test('GET -> PATCH -> GET round-trips every field exactly', async () => {
  const save = await req(`/api/companies/${companyA}/business-profile`, {
    method: 'PATCH', cookie: suCookie, body: { businessProfile: FULL },
  });
  assert.equal(save.status, 200);

  const read = await req(`/api/companies/${companyA}/business-profile`, { cookie: suCookie });
  assert.deepEqual(read.json.businessProfile, FULL, 'stored shape survives the round trip');

  // And re-saving what GET returned is a no-op, so an editor that loads and
  // saves without edits cannot corrupt the record.
  const resave = await req(`/api/companies/${companyA}/business-profile`, {
    method: 'PATCH', cookie: suCookie, body: { businessProfile: read.json.businessProfile },
  });
  const reread = await req(`/api/companies/${companyA}/business-profile`, { cookie: suCookie });
  assert.equal(resave.status, 200);
  assert.deepEqual(reread.json.businessProfile, FULL, 'load-then-save is idempotent');
});

test('unknown keys are stripped rather than stored', async () => {
  await req(`/api/companies/${companyA}/business-profile`, {
    method: 'PATCH', cookie: suCookie,
    body: { businessProfile: { ...FULL, injected: 'nope' } },
  });
  const r = await req(`/api/companies/${companyA}/business-profile`, { cookie: suCookie });
  assert.ok(!('injected' in r.json.businessProfile));
  assert.deepEqual(r.json.businessProfile, FULL);
});

// ══ 9–10. Effect on the published prompt ══════════════════════════
test('an empty profile produces an empty facts block in publish-preview', async () => {
  await req(`/api/companies/${companyA}/business-profile`, {
    method: 'PATCH', cookie: suCookie, body: { businessProfile: {} },
  });
  const p = await req(`/api/companies/${companyA}/publish-preview`, { cookie: suCookie });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.factsBlock, '');
  assert.equal(p.json.hasFacts, false);
});

test('the composed prompt is BYTE-IDENTICAL with an empty profile', async () => {
  // The guarantee that makes this feature safe to ship: a company that fills
  // nothing in gets exactly the prompt it had before the feature existed.
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

  const empty = await req(`/api/companies/${companyA}/publish-preview`, { cookie: suCookie });
  const baseline = sha(empty.json.prompt);

  await req(`/api/companies/${companyA}/business-profile`, {
    method: 'PATCH', cookie: suCookie, body: { businessProfile: FULL },
  });
  const filled = await req(`/api/companies/${companyA}/publish-preview`, { cookie: suCookie });
  assert.notEqual(sha(filled.json.prompt), baseline, 'facts DO change the prompt when present');
  assert.ok(filled.json.prompt.length > empty.json.prompt.length);
  assert.ok(filled.json.hasFacts);

  // …and clearing them restores the original byte for byte.
  await req(`/api/companies/${companyA}/business-profile`, {
    method: 'PATCH', cookie: suCookie, body: { businessProfile: {} },
  });
  const cleared = await req(`/api/companies/${companyA}/publish-preview`, { cookie: suCookie });
  assert.equal(sha(cleared.json.prompt), baseline,
    'clearing the profile restores the exact original prompt');
});

test('the facts block appears verbatim inside the composed prompt', async () => {
  await req(`/api/companies/${companyA}/business-profile`, {
    method: 'PATCH', cookie: suCookie, body: { businessProfile: FULL },
  });
  const p = await req(`/api/companies/${companyA}/publish-preview`, { cookie: suCookie });
  assert.ok(p.json.factsBlock.length > 0);
  assert.ok(p.json.prompt.includes(p.json.factsBlock),
    'what the preview shows is literally what the prompt contains');
  // And the operator's own text is still in there, untouched.
  assert.ok(p.json.prompt.includes('تعليمات المشغّل الأصلية'),
    'the operator instructions are preserved, not replaced');
});

test('the agent payload carries the facts-bearing prompt', async () => {
  const p = await req(`/api/companies/${companyA}/publish-preview`, { cookie: suCookie });
  const sent = p.json.agentPayload?.conversation_config?.agent?.prompt?.prompt;
  assert.ok(sent, 'the payload carries a prompt');
  assert.equal(sent, p.json.prompt, 'the previewed prompt IS the one in the payload');
  assert.ok(sent.includes('## معلومات الشركة'), 'facts reach the provider payload');
});

test('a company with no active scenario cannot be previewed, and says why', async () => {
  const r = await req(`/api/companies/${companyB}/publish-preview`, { cookie: suCookie });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'NO_ACTIVE_SCENARIO');
});

// ══ Capability API (authorization + tenant isolation over HTTP) ═══
// The registry itself is covered by scripts/test-capabilities.js; what is
// tested here is the HTTP surface — who may read and change a company's
// capabilities.
test('a client may list and toggle its OWN company capabilities', async () => {
  const list = await req(`/api/companies/${companyA}/features`, { cookie: clientCookie });
  assert.equal(list.status, 200, list.text);
  assert.ok(Array.isArray(list.json.features) && list.json.features.length >= 10,
    'every capability is listed, including the planned ones');

  const off = await req(`/api/companies/${companyA}/features/knowledge_base`, {
    method: 'PATCH', cookie: clientCookie, body: { enabled: false },
  });
  assert.equal(off.status, 200, off.text);
  // Disabling bites immediately; enabling needs a publish for the agent to gain
  // the tool. The response says which of the two just happened.
  assert.equal(off.json.effectiveImmediately, true);
  assert.equal(off.json.needsPublish, false);

  const on = await req(`/api/companies/${companyA}/features/knowledge_base`, {
    method: 'PATCH', cookie: clientCookie, body: { enabled: true },
  });
  assert.equal(on.json.needsPublish, true);
  assert.equal(on.json.effectiveImmediately, false);
});

test('a client is DENIED another company capabilities', async () => {
  const list = await req(`/api/companies/${companyB}/features`, { cookie: clientCookie });
  assert.equal(list.status, 404);
  const patch = await req(`/api/companies/${companyB}/features/knowledge_base`, {
    method: 'PATCH', cookie: clientCookie, body: { enabled: false },
  });
  assert.equal(patch.status, 404);
});

test('the denied capability change did not reach company B', async () => {
  const b = await req(`/api/companies/${companyB}/features`, { cookie: suCookie });
  const kb = b.json.features.find((f) => f.key === 'knowledge_base');
  assert.equal(kb.configured, null, 'B has no explicit row — nothing was written');
});

test('a superadmin may toggle capabilities on any company', async () => {
  const r = await req(`/api/companies/${companyB}/features/call_transfer`, {
    method: 'PATCH', cookie: suCookie, body: { enabled: false },
  });
  assert.equal(r.status, 200, r.text);
});

test('an unauthenticated caller cannot read or change capabilities', async () => {
  assert.equal((await req(`/api/companies/${companyA}/features`)).status, 401);
  assert.equal((await req(`/api/companies/${companyA}/features/knowledge_base`, {
    method: 'PATCH', body: { enabled: false },
  })).status, 401);
});

test('a PLANNED capability is refused over HTTP with 400', async () => {
  const r = await req(`/api/companies/${companyA}/features/appointment_booking`, {
    method: 'PATCH', cookie: suCookie, body: { enabled: true },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'NOT_IMPLEMENTED');
});

test('an unknown capability is a 404, not a silent no-op', async () => {
  const r = await req(`/api/companies/${companyA}/features/not_a_feature`, {
    method: 'PATCH', cookie: suCookie, body: { enabled: true },
  });
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'UNKNOWN_FEATURE');
});

test('capability changes on A do not alter B, over HTTP', async () => {
  await req(`/api/companies/${companyA}/features/knowledge_base`, {
    method: 'PATCH', cookie: suCookie, body: { enabled: false },
  });
  const a = await req(`/api/companies/${companyA}/features`, { cookie: suCookie });
  const b = await req(`/api/companies/${companyB}/features`, { cookie: suCookie });
  const kbA = a.json.features.find((f) => f.key === 'knowledge_base');
  const kbB = b.json.features.find((f) => f.key === 'knowledge_base');
  assert.equal(kbA.enabled, false);
  assert.equal(kbB.enabled, true, 'B still on its registry default');
});
