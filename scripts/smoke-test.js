// Smoke test: boots the real server against a throwaway SQLite file and
// asserts the critical paths respond correctly. No external API keys needed —
// everything that would call OpenAI/Vapi/ElevenLabs is either skipped or
// expected to fail *cleanly*. Exit code 0 = safe to deploy.
//
// Run: node scripts/smoke-test.js
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB = path.join(os.tmpdir(), `smart-assistant-smoke-${Date.now()}.db`);
const PORT = process.env.SMOKE_PORT || '3955';
const B = `http://localhost:${PORT}`;
const XHR = { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' };

const env = {
  ...process.env,
  DB_PATH: DB,
  PORT,
  NODE_ENV: 'development',
  // Deliberately fake: proves the server boots + degrades cleanly without
  // real provider credentials.
  OPENAI_API_KEY: 'sk-smoke-test',
  VAPI_API_KEY: 'smoke-test',
  VAPI_WEBHOOK_SECRET: 'smoke-webhook-secret',
};

const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env });
let out = '';
srv.stdout.on('data', (d) => { out += d; });
srv.stderr.on('data', (d) => { out += d; });

const results = [];
function check(name, cond, extra = '') {
  results.push(cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
}

async function waitForBoot() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(B + '/health'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not boot within 15s:\n' + out.slice(-3000));
}

(async () => {
  await waitForBoot();

  // 1. Health: db must answer.
  const h = await fetch(B + '/health');
  const hb = await h.json();
  check('health: 200 + db ok', h.status === 200 && hb.db === 'ok', `status=${h.status}`);

  // 2. Auth gate: /api requires a session.
  const g = await fetch(B + '/api/companies');
  check('auth gate: /api/* → 401 unauthenticated', g.status === 401, `status=${g.status}`);

  // 3. CSRF gate: POST without X-Requested-With → 403.
  const c = await fetch(B + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  check('csrf gate: POST without XHR header → 403', c.status === 403, `status=${c.status}`);

  // 4. Bootstrap signup (first user becomes superadmin).
  const su = await fetch(B + '/api/auth/signup', {
    method: 'POST', headers: XHR,
    body: JSON.stringify({ email: 'smoke@test.local', password: 'smokepass1', name: 'smoke' }),
  });
  const cookie = (su.headers.get('set-cookie') || '').split(';')[0];
  check('bootstrap signup → 201 + session cookie', su.status === 201 && !!cookie, `status=${su.status}`);

  // 5. Create a company through the real API.
  const cc = await fetch(B + '/api/companies', {
    method: 'POST', headers: { ...XHR, cookie },
    body: JSON.stringify({ id: 'co-smoke', name: 'شركة الدخان', language: 'ar-SA' }),
  });
  const ccB = await cc.json().catch(() => ({}));
  const companyId = ccB.id || ccB.company?.id;
  check('create company → 200/201 with id', (cc.status === 200 || cc.status === 201) && !!companyId, `status=${cc.status}`);

  // 6. Company list scoped + readable.
  const ls = await fetch(B + '/api/companies', { headers: { cookie } });
  const lsB = await ls.json().catch(() => []);
  check('list companies includes the new one', ls.status === 200 && lsB.some((x) => x.id === companyId));

  // 7. Per-company API key lifecycle.
  const mk = await fetch(B + `/api/companies/${companyId}/api-keys`, {
    method: 'POST', headers: { ...XHR, cookie }, body: JSON.stringify({ name: 'smoke' }),
  });
  const mkB = await mk.json().catch(() => ({}));
  check('create api key → sa_ prefix', mk.status === 201 && /^sa_/.test(mkB.key || ''), `status=${mk.status}`);

  // 8. Agent API: bad key → 401, good key → passes auth (fails later at Vapi = 502/404/409).
  const bad = await fetch(B + '/api/v1/agent/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
    body: JSON.stringify({ customer_phone: '+966500000000', message: 'hi' }),
  });
  check('agent api: bad key → 401', bad.status === 401, `status=${bad.status}`);
  const good = await fetch(B + '/api/v1/agent/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mkB.key}` },
    body: JSON.stringify({ customer_phone: '+966500000000', message: 'hi' }),
  });
  check('agent api: scoped key passes auth (409 unpublished)', good.status === 409, `status=${good.status}`);

  // 9. Webhook: wrong secret → 401; right secret → 200 + call logged.
  const w1 = await fetch(B + '/webhook/vapi', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-vapi-secret': 'wrong' }, body: '{}',
  });
  check('webhook: wrong secret → 401', w1.status === 401, `status=${w1.status}`);
  const w2 = await fetch(B + '/webhook/vapi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-vapi-secret': 'smoke-webhook-secret' },
    body: JSON.stringify({
      message: {
        type: 'end-of-call-report',
        call: { id: 'smoke-call-1', type: 'inboundPhoneCall', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:30Z' },
        summary: 'مكالمة اختبار دخان ناجحة تماماً.',
        artifact: { transcript: 'ok', recordingUrl: 'https://storage.vapi.ai/smoke.wav' },
      },
    }),
  });
  check('webhook: valid secret → 200', w2.status === 200, `status=${w2.status}`);

  srv.kill();
  const pass = results.every(Boolean);
  console.log(pass ? `\nSMOKE OK — ${results.length}/${results.length} checks passed` : '\nSMOKE FAILED');
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error('SMOKE CRASH:', e.message);
  console.error(out.slice(-3000));
  srv.kill();
  process.exit(1);
});
