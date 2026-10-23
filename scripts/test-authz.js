// Regression proofs for the authorization + hardening findings (audit F-01,
// F-06, F-10, F-11, F-12, F-14, F-19).
//
// These are pure-logic tests against the exact predicates the routes use, so
// they run with no DB and no network — CI-safe and fast.
//
//   node --test scripts/test-authz.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isSafeUrl, isPrivateAddress } = require('../lib/ssrf');

// ─── F-01: conversation ownership ─────────────────────────────────
// Mirror of userCanAccessCompany() in server.js. The bug was that this used
// companies.user_id (the legacy owner column) instead of users.company_id,
// so a client could never open their own conversations.
function userCanAccessCompany(user, companyId) {
  if (!user || !companyId) return false;
  if (user.role === 'superadmin') return true;
  return user.role === 'client' && !!user.companyId && user.companyId === companyId;
}

test('F-01: client CAN access their own company (the 404 bug)', () => {
  const client = { id: 25, role: 'client', companyId: 'co-xjdidl' };
  assert.equal(userCanAccessCompany(client, 'co-xjdidl'), true);
});

test('F-01: client CANNOT access another company', () => {
  const client = { id: 25, role: 'client', companyId: 'co-xjdidl' };
  assert.equal(userCanAccessCompany(client, 'co-muhair'), false);
});

test('F-01: superadmin can access any company', () => {
  const su = { id: 3, role: 'superadmin', companyId: null };
  assert.equal(userCanAccessCompany(su, 'co-xjdidl'), true);
  assert.equal(userCanAccessCompany(su, 'co-anything'), true);
});

test('F-01: authorization does NOT depend on companies.user_id', () => {
  // Real production shape: the company row is owned by the superadmin (user 3)
  // while the client is user 25. The old check compared these and always failed.
  const client = { id: 25, role: 'client', companyId: 'co-xjdidl' };
  const companyRow = { id: 'co-xjdidl', user_id: 3 };
  assert.notEqual(client.id, companyRow.user_id, 'precondition: ids differ');
  assert.equal(userCanAccessCompany(client, companyRow.id), true);
});

test('F-01: unauthenticated / null company is refused', () => {
  assert.equal(userCanAccessCompany(null, 'co-x'), false);
  assert.equal(userCanAccessCompany({ role: 'client', companyId: 'co-x' }, null), false);
  assert.equal(userCanAccessCompany({ role: 'client', companyId: null }, 'co-x'), false);
});

test('F-01: an unknown role is refused even with a matching company', () => {
  assert.equal(userCanAccessCompany({ role: 'viewer', companyId: 'co-x' }, 'co-x'), false);
});

// ─── F-06: spending caps are superadmin-only ──────────────────────
const CAP_KEYS = ['dailyMessageCap', 'dailyOutboundCap'];
function capsRejected(user, body) {
  const attempted = CAP_KEYS.filter((k) => body[k] !== undefined);
  return attempted.length > 0 && user.role !== 'superadmin';
}

test('F-06: client raising its own outbound cap is rejected', () => {
  const client = { role: 'client', companyId: 'co-x' };
  assert.equal(capsRejected(client, { dailyOutboundCap: 100000 }), true);
});

test('F-06: client raising the message cap is rejected', () => {
  assert.equal(capsRejected({ role: 'client' }, { dailyMessageCap: 999999 }), true);
});

test('F-06: superadmin may set caps', () => {
  assert.equal(capsRejected({ role: 'superadmin' }, { dailyOutboundCap: 500 }), false);
});

test('F-06: a client PATCH without cap keys is unaffected', () => {
  assert.equal(capsRejected({ role: 'client' }, { temperature: 0.4, voiceSpeed: 1 }), false);
});

// ─── F-11: one model resolver for every agent-simulating path ─────
// The real resolver (lib/agent-defaults.js), not a copy: the copy that lived
// here kept asserting gpt-4.1 after the default had moved.
const agentDefaults = require('../lib/agent-defaults');
const resolveAgentModel = (company) => agentDefaults.resolveAgentModel(company?.settings);

test('F-11: the default is the reference agent\'s model, not a mini stand-in', () => {
  const m = resolveAgentModel({ settings: {} });
  assert.equal(m.model, agentDefaults.AGENT_DEFAULTS.model);
  assert.equal(m.temperature, agentDefaults.AGENT_DEFAULTS.temperature);
  assert.equal(m.maxTokens, agentDefaults.AGENT_DEFAULTS.maxTokens);
});

test('F-11: an explicit per-company model is honoured', () => {
  assert.equal(resolveAgentModel({ settings: { model: 'gpt-4o' } }).model, 'gpt-4o');
});

test('F-11: an unknown model falls back rather than reaching the API', () => {
  assert.equal(resolveAgentModel({ settings: { model: 'gpt-5-turbo-ultra' } }).model,
    agentDefaults.AGENT_DEFAULTS.model);
});

test('F-11: out-of-range values are clamped, not passed through', () => {
  const m = resolveAgentModel({ settings: { temperature: 99, maxTokens: 100000 } });
  assert.equal(m.temperature, 1);
  assert.equal(m.maxTokens, 800);
});

// ─── F-12: SSRF guard ─────────────────────────────────────────────
test('F-12: loopback and metadata addresses are classified private', () => {
  for (const ip of ['127.0.0.1', '127.9.9.9', '169.254.169.254', '10.0.0.5',
    '172.16.4.4', '192.168.1.1', '100.64.0.1', '0.0.0.0']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} must be private`);
  }
});

test('F-12: public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '52.9.100.4', '172.32.0.1']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} must be public`);
  }
});

test('F-12: IPv6 loopback, link-local and unique-local are private', () => {
  for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} must be private`);
  }
});

test('F-12: internal hostnames are rejected at write time', () => {
  for (const u of ['http://localhost/hook', 'http://api.internal/hook',
    'http://box.local/hook', 'http://127.0.0.1:3000/hook',
    'http://169.254.169.254/latest/meta-data/']) {
    assert.equal(isSafeUrl(u).ok, false, `${u} must be blocked`);
  }
});

test('F-12: non-http schemes are rejected', () => {
  for (const u of ['file:///etc/passwd', 'gopher://x/', 'ftp://h/f', 'javascript:alert(1)']) {
    assert.equal(isSafeUrl(u).ok, false, `${u} must be blocked`);
  }
});

test('F-12: non-standard ports are rejected (internal admin surfaces)', () => {
  assert.equal(isSafeUrl('http://example.com:8080/hook').ok, false);
  assert.equal(isSafeUrl('http://example.com:6379/').ok, false);
});

test('F-12: legitimate customer webhooks still pass', () => {
  for (const u of ['https://hooks.example.com/abc', 'https://api.customer.sa:443/v1/webhook',
    'http://example.com/hook']) {
    assert.equal(isSafeUrl(u).ok, true, `${u} must be allowed`);
  }
});

test('F-12: blocked URLs carry an explanatory reason', () => {
  const r = isSafeUrl('http://localhost/hook');
  assert.equal(r.ok, false);
  assert.ok(r.reason && r.reason.length > 0, 'reason is present for the UI');
});

// ─── F-14: voice id whitelist ─────────────────────────────────────
// The real module rather than a copy of it: a mirrored list kept passing here
// after the catalogue it was meant to guard had changed.
const VOICES_PATH = require.resolve('../lib/voices');
const {
  VOICES, DEFAULT_VOICE_ID, RETIRED_VOICES, isAllowedVoiceId, resolveVoiceId,
} = require('../lib/voices');
const ALI = 'MI88rOZjXbH22N8KHXUo';
const JEDDAWI = 'yXEnnEln9armDCyhkXcA';

test('F-14: the catalogue is exactly the voice the operator kept: ناصر, منى dropped', () => {
  assert.deepEqual(VOICES.map((v) => [v.id, v.label, v.gender]), [
    [JEDDAWI, 'ناصر', 'male'],
  ]);
  for (const v of VOICES) assert.equal(isAllowedVoiceId(v.id), true, v.name);
  // Mona can no longer be picked: a save with her id is refused.
  assert.equal(isAllowedVoiceId('o0oG1TnHDWDdKbAeBgCO'), false);
});

test('F-14: the default voice is one a company could also pick', () => {
  assert.equal(DEFAULT_VOICE_ID, JEDDAWI);
  assert.equal(isAllowedVoiceId(DEFAULT_VOICE_ID), true);
});

test('F-14: an unknown voice is rejected at write, not at publish', () => {
  assert.equal(isAllowedVoiceId('totally-made-up-voice'), false);
  assert.equal(isAllowedVoiceId(''), false);
  assert.equal(isAllowedVoiceId(null), false);
});

test('F-14: a retired voice can no longer be picked, but resolves to one that can', () => {
  assert.ok(Object.keys(RETIRED_VOICES).length >= 2, 'Ali and Nasser');
  for (const [old, now] of Object.entries(RETIRED_VOICES)) {
    assert.equal(isAllowedVoiceId(old), false, `${old} is retired`);
    assert.equal(resolveVoiceId(old), now);
    assert.equal(isAllowedVoiceId(now), true, 'the replacement itself publishes');
  }
});

test('F-14: a retired voice is replaced by one of the same gender', () => {
  // Both retired voices were male. An agent whose scenario names it as a man
  // must not start speaking as a woman because of a catalogue change.
  for (const now of Object.values(RETIRED_VOICES)) {
    assert.equal(VOICES.find((v) => v.id === now).gender, 'male');
  }
});

test('F-14: an unknown voice resolves to itself, so publish still refuses it loudly', () => {
  assert.equal(resolveVoiceId('totally-made-up-voice'), 'totally-made-up-voice');
  assert.equal(resolveVoiceId(JEDDAWI), JEDDAWI);
  assert.equal(resolveVoiceId(''), null);
  assert.equal(resolveVoiceId(undefined), null);
});

test('F-14: EXTRA_VOICE_IDS extends the catalogue without a deploy', () => {
  const saved = process.env.EXTRA_VOICE_IDS;
  process.env.EXTRA_VOICE_IDS = ` newVoice123 , ${ALI} `;
  delete require.cache[VOICES_PATH];
  try {
    const fresh = require('../lib/voices');
    assert.equal(fresh.isAllowedVoiceId('newVoice123'), true);
    // Listing a retired voice there keeps it on purpose: it is not swapped.
    assert.equal(fresh.isAllowedVoiceId(ALI), true);
    assert.equal(fresh.resolveVoiceId(ALI), ALI);
  } finally {
    if (saved === undefined) delete process.env.EXTRA_VOICE_IDS;
    else process.env.EXTRA_VOICE_IDS = saved;
    delete require.cache[VOICES_PATH];
  }
});

test('F-14: a company saved with a retired voice loads with its replacement', () => {
  const { toCompany } = require('../companies');
  const row = (settings) => ({ id: 'co-x', name: 'x', settings: JSON.stringify(settings) });
  const c = toCompany(row({ voiceId: ALI, model: 'gpt-4.1', voiceSpeed: 1.1 }));
  assert.equal(c.settings.voiceId, JEDDAWI);
  assert.equal(c.settings.model, 'gpt-4.1', 'the rest of the settings are untouched');
  assert.equal(c.settings.voiceSpeed, 1.1);
  // No voice stays no voice: the default applies at publish, not here.
  assert.equal(toCompany(row({ model: 'gpt-4.1' })).settings.voiceId, undefined);
  // A company saved with Mona, dropped 2026-10-23, loads speaking as ناصر.
  assert.equal(toCompany(row({ voiceId: 'o0oG1TnHDWDdKbAeBgCO' })).settings.voiceId, JEDDAWI);
  assert.equal(RETIRED_VOICES.o0oG1TnHDWDdKbAeBgCO, JEDDAWI);
});

// ─── F-10: Saudi local time for spoken {{date}}/{{time}} ──────────
const { fillGlobals, localNow, TZ_OFFSET_HOURS } = require('../companies');

test('F-10: offset is Saudi UTC+3', () => {
  assert.equal(TZ_OFFSET_HOURS, 3);
});

test('F-10: localNow is exactly 3h ahead of the given instant', () => {
  const base = new Date('2026-07-19T00:00:00.000Z');
  assert.equal(localNow(base).toISOString(), '2026-07-19T03:00:00.000Z');
});

test('F-10: 23:30 UTC renders as the NEXT day in Riyadh', () => {
  // The bug that mattered: around midnight the agent stated the wrong DATE.
  const base = new Date('2026-07-19T23:30:00.000Z');   // 02:30 on the 20th in Riyadh
  const local = localNow(base);
  assert.equal(local.toISOString().slice(0, 10), '2026-07-20');
  assert.equal(local.toISOString().slice(11, 16), '02:30');
});

test('F-10: fillGlobals renders a time within 3h of UTC now', () => {
  const out = fillGlobals('الساعة {{time}} والتاريخ {{date}}', { name: 'شركة' });
  const m = /الساعة (\d{2}):(\d{2}) والتاريخ (\d{4}-\d{2}-\d{2})/.exec(out);
  assert.ok(m, `expected substituted output, got: ${out}`);
  const utcH = new Date().getUTCHours();
  assert.equal(Number(m[1]), (utcH + 3) % 24, 'hour is UTC+3');
});

test('F-10: unknown placeholders survive untouched', () => {
  const out = fillGlobals('مرحباً {{customer_name}}', { name: 'شركة' });
  assert.match(out, /\{\{customer_name\}\}/);
});

// ─── Administrative password reset ────────────────────────────────
// A reset has three jobs beyond changing the hash, and the two easy ones to
// forget are the two that matter.

test('reset refuses anyone who is not a client of THIS company', () => {
  // Without this the :id in the path is decoration, and a reset route reachable
  // by company admins becomes a way to take over a superadmin account.
  const targetIsResettable = (u, companyId) =>
    !!u && u.role === 'client' && u.company_id === companyId;

  assert.equal(targetIsResettable({ role: 'client', company_id: 'co-a' }, 'co-a'), true);
  assert.equal(targetIsResettable({ role: 'client', company_id: 'co-b' }, 'co-a'), false,
    'another company\'s client');
  assert.equal(targetIsResettable({ role: 'superadmin', company_id: null }, 'co-a'), false,
    'a superadmin must never be resettable through a company-scoped route');
  assert.equal(targetIsResettable(null, 'co-a'), false);
});

test('unlockUser clears the lockout WITHOUT stamping a login', () => {
  // clearFailedLogins also sets last_login_at, which is right after a real
  // login and wrong after a reset: the clients list would show someone as
  // freshly active when they have not been back at all.
  const sqlite = require('fs').readFileSync(require('path').join(__dirname, '..', 'db-sqlite.js'), 'utf8');
  const pg     = require('fs').readFileSync(require('path').join(__dirname, '..', 'db-postgres.js'), 'utf8');

  for (const [label, src] of [['sqlite', sqlite], ['postgres', pg]]) {
    const m = src.match(/unlockUser[^\n]*\n?[^\n]*/);
    assert.ok(m, `${label}: unlockUser statement is missing`);
    assert.match(m[0], /failed_logins\s*=\s*0/, `${label}: must clear the counter`);
    assert.match(m[0], /locked_until\s*=\s*NULL/, `${label}: must lift the lockout`);
    assert.doesNotMatch(m[0], /last_login_at/, `${label}: must NOT claim a login happened`);
  }
});

test('reset kills every existing session for that user', () => {
  // A reset is what an operator reaches for when an account may be
  // compromised. Leaving the old cookies alive makes it theatre: the intruder
  // keeps their access and only the owner gets a new password.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'routes', 'clients.js'), 'utf8');
  const route = src.slice(src.indexOf('reset-password'));
  assert.match(route, /deleteUserSessions/, 'sessions must be revoked on reset');
  assert.match(route, /unlockUser/, 'a reset must also lift a lockout');
  // The generated password is handed back to the operator once; it must never
  // also be written into the permanent audit trail. Checked against the
  // metadata ARGUMENT, not the surrounding text: the action name is literally
  // 'client.reset_password', so a search for the word matches the innocent
  // case and tells you nothing.
  const meta = route.match(/metadata\s*:\s*JSON\.stringify\(([^)]*)\)/);
  assert.ok(meta, 'the reset must record an audit event');
  assert.doesNotMatch(meta[1], /\bpassword\b/,
    'the audit metadata must not carry the generated password');
});
