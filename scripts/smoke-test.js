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

// Under postgres, wipe the schema first — unlike the throwaway SQLite file,
// the pg database persists between runs and a leftover user closes bootstrap.
async function resetPg() {
  if ((process.env.DB_DRIVER || 'sqlite') !== 'postgres') return;
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  console.log('(postgres schema reset)');
}

let srv = null;
let out = '';
function startServer() {
  srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env });
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
}

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
  await resetPg();
  startServer();
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

  // 9. Scenario lifecycle: create → read → update → activate → versions.
  const sc = await fetch(B + `/api/companies/${companyId}/scenarios`, {
    method: 'POST', headers: { ...XHR, cookie },
    body: JSON.stringify({
      name: 'سيناريو الدخان',
      instructionPrompt: 'أنت موظف خدمة عملاء تجيب باختصار وود.',
      firstMessage: 'حياك الله، كيف أقدر أساعدك؟',
    }),
  });
  const scB = await sc.json().catch(() => ({}));
  const scenarioId = scB.id || scB.scenario?.id;
  check('scenario create → id', (sc.status === 200 || sc.status === 201) && !!scenarioId, `status=${sc.status}`);

  const scList = await fetch(B + `/api/companies/${companyId}/scenarios`, { headers: { cookie } });
  const scListB = await scList.json().catch(() => []);
  check('scenario list includes it', scList.status === 200 && scListB.some((x) => x.id === scenarioId));

  const scUpd = await fetch(B + `/api/scenarios/${scenarioId}`, {
    method: 'PATCH', headers: { ...XHR, cookie },
    body: JSON.stringify({ instructionPrompt: 'أنت موظف مبيعات عقاري تجيب بدقة من قاعدة المعرفة.' }),
  });
  check('scenario update → 200', scUpd.status === 200, `status=${scUpd.status}`);

  const scAct = await fetch(B + `/api/scenarios/${scenarioId}/activate`, {
    method: 'POST', headers: { ...XHR, cookie }, body: '{}',
  });
  check('scenario activate → 200', scAct.status === 200, `status=${scAct.status}`);

  const scVer = await fetch(B + `/api/scenarios/${scenarioId}/versions`, { headers: { cookie } });
  const scVerB = await scVer.json().catch(() => []);
  check('scenario versions listed', scVer.status === 200 && Array.isArray(scVerB) && scVerB.length >= 1, `n=${scVerB.length}`);

  // 10. Settings PATCH merge (numbers + caps + transfer number validation).
  const st1 = await fetch(B + `/api/companies/${companyId}/settings`, {
    method: 'PATCH', headers: { ...XHR, cookie },
    body: JSON.stringify({ temperature: 0.3, dailyMessageCap: 500 }),
  });
  const st2 = await fetch(B + `/api/companies/${companyId}/settings`, {
    method: 'PATCH', headers: { ...XHR, cookie },
    body: JSON.stringify({ transferPhoneNumber: '+966501234567', inboundPhoneNumberId: 'smoke-pn-1' }),
  });
  const st2B = await st2.json().catch(() => ({}));
  check('settings merge keeps earlier keys',
    st1.status === 200 && st2.status === 200 && st2B.settings?.temperature === 0.3 && st2B.settings?.transferPhoneNumber === '+966501234567');
  const stBad = await fetch(B + `/api/companies/${companyId}/settings`, {
    method: 'PATCH', headers: { ...XHR, cookie }, body: JSON.stringify({ transferPhoneNumber: 'abc' }),
  });
  check('settings rejects bad transfer number', stBad.status === 400, `status=${stBad.status}`);

  // 11. Clients: create + list + delete.
  const cl = await fetch(B + `/api/companies/${companyId}/clients`, {
    method: 'POST', headers: { ...XHR, cookie },
    body: JSON.stringify({ email: 'client@smoke.local', name: 'عميل' }),
  });
  const clB = await cl.json().catch(() => ({}));
  check('client create → password shown once', cl.status === 201 && !!clB.password, `status=${cl.status}`);
  const clDel = await fetch(B + `/api/companies/${companyId}/clients/${clB.id}`, {
    method: 'DELETE', headers: { ...XHR, cookie },
  });
  check('client delete → 200', clDel.status === 200, `status=${clDel.status}`);

  // 12. Webhook: wrong secret → 401; right secret → 200 + call logged.
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
        // phoneNumberId (not assistantId) so the phone-fallback company
        // matching path gets exercised too.
        call: { id: 'smoke-call-1', type: 'inboundPhoneCall', phoneNumberId: 'smoke-pn-1', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:30Z' },
        summary: 'مكالمة اختبار دخان ناجحة تماماً.',
        artifact: { transcript: 'ok', recordingUrl: 'https://storage.vapi.ai/smoke.wav' },
      },
    }),
  });
  check('webhook: valid secret → 200', w2.status === 200, `status=${w2.status}`);
  await new Promise((r) => setTimeout(r, 600));

  // 13. Calls list + detail + CSV export carry the webhook data.
  const calls = await fetch(B + `/api/companies/${companyId}/calls`, { headers: { cookie } });
  const callsB = await calls.json().catch(() => []);
  check('calls list has the webhook call', calls.status === 200 && callsB.some((c2) => c2.id === 'smoke-call-1'));
  const csv = await fetch(B + `/api/companies/${companyId}/calls.csv`, { headers: { cookie } });
  const csvBuf = Buffer.from(await csv.arrayBuffer());
  check('calls.csv → 200 with BOM', csv.status === 200 && csvBuf.subarray(0, 3).toString('hex') === 'efbbbf');

  // 14. Dashboard + conversations aggregate endpoints.
  const dash = await fetch(B + '/api/dashboard?period=today', { headers: { cookie } });
  const dashB = await dash.json().catch(() => ({}));
  check('dashboard → 200 with chart', dash.status === 200 && Array.isArray(dashB.chart) && dashB.chart.length === 24, `status=${dash.status}`);
  const conv = await fetch(B + '/api/conversations?limit=10', { headers: { cookie } });
  const convB = await conv.json().catch(() => ({}));
  check('conversations → 200 + finds the call', conv.status === 200 && convB.items?.some((i) => i.callId === 'smoke-call-1'), `total=${convB.total}`);
  const convSearch = await fetch(B + '/api/conversations?search=' + encodeURIComponent('دخان'), { headers: { cookie } });
  const convSearchB = await convSearch.json().catch(() => ({}));
  check('conversations company-name search works', convSearch.status === 200 && convSearchB.items?.length >= 1);

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
