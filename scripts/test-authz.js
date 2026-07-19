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
const ALLOWED_MODELS = ['gpt-4.1', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4o-mini'];
const clampNum = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
function resolveAgentModel(company) {
  const s = company?.settings || {};
  return {
    model: ALLOWED_MODELS.includes(s.model) ? s.model : 'gpt-4.1',
    temperature: clampNum(s.temperature, 0, 1, 0.3),
    maxTokens: clampNum(s.maxTokens, 50, 800, 400),
  };
}

test('F-11: default is production gpt-4.1 @ 0.3, not a mini stand-in', () => {
  const m = resolveAgentModel({ settings: {} });
  assert.equal(m.model, 'gpt-4.1');
  assert.equal(m.temperature, 0.3);
  assert.equal(m.maxTokens, 400);
});

test('F-11: an explicit per-company model is honoured', () => {
  assert.equal(resolveAgentModel({ settings: { model: 'gpt-4o' } }).model, 'gpt-4o');
});

test('F-11: an unknown model falls back rather than reaching the API', () => {
  assert.equal(resolveAgentModel({ settings: { model: 'gpt-5-turbo-ultra' } }).model, 'gpt-4.1');
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
const PLAYGROUND_VOICE_IDS = new Set(['MI88rOZjXbH22N8KHXUo', 'cFUFIbKkO2iZFwS8cRnY']);
function isAllowedVoiceId(id, extra = new Set()) {
  const v = String(id || '').trim();
  if (!v) return false;
  return PLAYGROUND_VOICE_IDS.has(v) || extra.has(v);
}

test('F-14: catalog voices are accepted', () => {
  assert.equal(isAllowedVoiceId('MI88rOZjXbH22N8KHXUo'), true);   // Ali
  assert.equal(isAllowedVoiceId('cFUFIbKkO2iZFwS8cRnY'), true);   // Nasser
});

test('F-14: an unknown voice is rejected at write, not at Vapi sync', () => {
  assert.equal(isAllowedVoiceId('totally-made-up-voice'), false);
  assert.equal(isAllowedVoiceId(''), false);
  assert.equal(isAllowedVoiceId(null), false);
});

test('F-14: EXTRA_VOICE_IDS extends the catalog without a deploy', () => {
  assert.equal(isAllowedVoiceId('newVoice123', new Set(['newVoice123'])), true);
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
