// Proof suite for the campaign worker diagnostics (the "why is it stuck
// pending?" investigation). Uses a real SQLite DB and a mocked Vapi call, so
// the whole tick path runs — state transitions, eligibility, skip reasons, and
// the heartbeat — without touching the network.
//
//   node --test scripts/test-campaign-worker.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB = path.join(require('node:os').tmpdir(), `sa-worker-${Date.now()}.db`);
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = DB;
process.env.VAPI_PHONE_NUMBER_ID = 'pn-test';
process.env.VAPI_API_KEY = 'k';

// Mock Vapi so placeCall never hits the network.
const axios = require('axios');
let vapiCalls = 0;
axios.post = async () => { vapiCalls++; return { data: { id: `call-${vapiCalls}` } }; };

const { sql, db } = require('../db');
const camp = require('../services/campaigns');
const { currentContext } = require('../lib/tenant-context');

const nowSaudi = (new Date().getUTCHours() + 3) % 24;
const openStart = (nowSaudi - 1 + 24) % 24;   // window open right now
const openEnd = (nowSaudi + 1) % 24;

async function makeCampaign({ name, sh = openStart, eh = openEnd, published = true, contacts = 1, maxConcurrent = 2 }) {
  const asst = published ? `asst-${name}` : null;
  db.prepare("INSERT INTO companies (id,name,language,system_prompt,assistant_id) VALUES (?,?,'ar-SA','',?)")
    .run(`co-${name}`, name, asst);
  const cid = Number((await sql.insertCampaign.run({
    company_id: `co-${name}`, name, start_hour: sh, start_minute: 0, end_hour: eh, end_minute: 0,
    max_concurrent: maxConcurrent, max_attempts: 2, retry_delay_min: 60, created_by: 'o',
  })).lastInsertRowid);
  db.prepare('UPDATE campaigns SET status=? WHERE id=?').run('running', cid);
  for (let i = 0; i < contacts; i++) {
    await sql.insertCampaignContact.run({ campaign_id: cid, company_id: `co-${name}`, phone: `+96650000000${i}`, name: null, variables: null });
  }
  return cid;
}
const get = (cid) => sql.getCampaign.get(cid);
const statusOf = (cid) => db.prepare('SELECT status,COUNT(*) n FROM campaign_contacts WHERE campaign_id=? GROUP BY status').all(cid);

after(() => { try { db.close(); } catch {} for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true }); });

// ─── State transition: pending → calling ──────────────────────────
test('eligible campaign dials: pending → calling, reason=dialed', async () => {
  const cid = await makeCampaign({ name: 'dial', contacts: 2 });
  assert.equal(statusOf(cid)[0].status, 'pending');
  const r = await camp.tickCampaign(get(cid));
  assert.equal(r.reason, 'dialed');
  assert.equal(r.placed, 2);
  assert.deepEqual(statusOf(cid), [{ status: 'calling', n: 2 }]);
});

// ─── Every skip reason is reported precisely ──────────────────────
test('reason=outside_window carries the Saudi time + window (timezone proof)', async () => {
  const cid = await makeCampaign({ name: 'closed', sh: (nowSaudi + 2) % 24, eh: (nowSaudi + 3) % 24 });
  const r = await camp.tickCampaign(get(cid));
  assert.equal(r.reason, 'outside_window');
  assert.match(r.detail.saudiTime, /^\d{2}:\d{2}$/, 'reports the actual Saudi clock used');
  assert.ok(typeof r.detail.opensInMin === 'number');
  // Contacts stay pending — NOT failed — when outside the window.
  assert.equal(statusOf(cid)[0].status, 'pending');
});

test('reason=not_published, and the campaign is auto-paused', async () => {
  const cid = await makeCampaign({ name: 'nopub', published: false });
  const r = await camp.tickCampaign(get(cid));
  assert.equal(r.reason, 'not_published');
  assert.equal(get(cid).status, 'paused');
});

test('reason=no_number when neither company nor env has an outbound number', async () => {
  const saved = process.env.VAPI_PHONE_NUMBER_ID;
  delete process.env.VAPI_PHONE_NUMBER_ID;
  try {
    const cid = await makeCampaign({ name: 'nonum' });
    const r = await camp.tickCampaign(get(cid));
    assert.equal(r.reason, 'no_number');
  } finally { process.env.VAPI_PHONE_NUMBER_ID = saved; }
});

test('reason=no_slots when max_concurrent is already in flight', async () => {
  const cid = await makeCampaign({ name: 'slots', contacts: 3, maxConcurrent: 1 });
  await camp.tickCampaign(get(cid));                 // dials 1 → 1 calling
  const r = await camp.tickCampaign(get(cid));       // now full
  assert.equal(r.reason, 'no_slots');
  assert.equal(r.detail.calling, 1);
});

test('reason=completed when nothing is left to dial', async () => {
  const cid = await makeCampaign({ name: 'empty', contacts: 0 });
  const r = await camp.tickCampaign(get(cid));
  assert.equal(r.reason, 'completed');
  assert.equal(get(cid).status, 'completed');
});

// ─── Read-only diagnosis mirrors the real tick, without side effects ──
test('diagnoseCampaign explains an eligible campaign as "dialing" without dialing', async () => {
  const cid = await makeCampaign({ name: 'diag', contacts: 1 });
  const before = vapiCalls;
  const d = await camp.diagnoseCampaign(get(cid));
  assert.equal(d.reason, 'dialing');
  assert.equal(d.pending, 1);
  assert.equal(vapiCalls, before, 'diagnose placed NO calls');
  assert.match(d.saudiTime, /^\d{2}:\d{2}$/);
});

test('diagnoseCampaign reports outside_window read-only', async () => {
  const cid = await makeCampaign({ name: 'diagclosed', sh: (nowSaudi + 2) % 24, eh: (nowSaudi + 3) % 24 });
  const d = await camp.diagnoseCampaign(get(cid));
  assert.equal(d.reason, 'outside_window');
  assert.equal(d.window.open, false);
});

// ─── The real bug: Vapi errors with an ARRAY message ──────────────
test('a Vapi error with an array message does NOT crash the tick', async () => {
  // Vapi returns validation errors as { message: ['...','...'] }. The old code
  // did message.slice() → an array → SQL bind error → thrown out of the whole
  // tick → swallowed → contact stuck. Reproduce that exact shape.
  const cid = await makeCampaign({ name: 'arrerr', contacts: 1 });
  const saved = axios.post;
  axios.post = async () => {
    const e = new Error('Request failed');
    e.response = { data: { message: ['property assistantId should not exist', 'invalid number'] } };
    throw e;
  };
  try {
    let result;
    await assert.doesNotReject(async () => { result = await camp.tickCampaign(get(cid)); },
      'tick must not throw on an array error message');
    assert.equal(result.reason, 'no_pending', 'ran to completion');
  } finally { axios.post = saved; }

  // The contact must be cleanly marked failed with a STRING error, not stuck.
  const rows = statusOf(cid);
  assert.equal(rows[0].status, 'failed', 'contact marked failed, not left calling/pending');
  const err = db.prepare('SELECT last_error FROM campaign_contacts WHERE campaign_id=?').get(cid).last_error;
  assert.equal(typeof err, 'string');
  assert.match(err, /assistantId|invalid number/, 'array joined into a readable string');
});

// ─── RLS context: the real "stops after one call / must press Run" bug ──
// The worker runs outside any HTTP request, so it has no RLS tenant context.
// Under RLS every campaign table is fail-closed, so a context-less query returns
// ZERO rows and the worker never dials — only the HTTP run-now path (which
// carries a context) does, which is exactly why a Run press was needed per call.
// Prove the worker now establishes a tenant context around each campaign's tick.
test('tick() runs each campaign inside its tenant RLS context (companyId set, not context-less)', async () => {
  db.prepare("UPDATE campaigns SET status='paused' WHERE status='running'").run();
  const cid = await makeCampaign({ name: 'ctx', contacts: 1 });
  const company = get(cid).company_id;
  let seen = 'unset';
  const saved = axios.post;
  axios.post = async () => { seen = currentContext(); return { data: { id: 'call-ctx' } }; };
  try {
    await camp.tick();                       // the WORKER path, not tickCampaign directly
  } finally { axios.post = saved; }
  assert.notEqual(seen, 'unset', 'a dial happened');
  assert.ok(seen, 'a tenant context was active during the worker dial (would be null pre-fix)');
  assert.equal(seen.companyId, company, 'context is pinned to the campaign company');
  assert.equal(seen.bypass, false);
});

// The headline symptom: after one call the campaign stopped and needed a manual
// Run. Prove the worker now advances to the NEXT contact on its own once a call
// completes and frees the concurrency slot.
test('campaign auto-continues: worker dials the next contact after one completes (no manual run-now)', async () => {
  db.prepare("UPDATE campaigns SET status='paused' WHERE status='running'").run();
  const cid = await makeCampaign({ name: 'seq', contacts: 3, maxConcurrent: 1 });
  const placed = [];
  for (let i = 0; i < 3; i++) {
    await camp.tick();                       // worker places ONE (maxConcurrent=1)
    const row = db.prepare("SELECT id, call_id FROM campaign_contacts WHERE campaign_id=? AND status='calling'").get(cid);
    assert.ok(row, `tick ${i + 1} placed the next call automatically`);
    placed.push(row.call_id);
    await camp.handleCallEnded(row.call_id, 'customer-ended', 30);   // Vapi end-of-call frees the slot
  }
  assert.equal(new Set(placed).size, 3, 'three distinct contacts dialled in sequence, unattended');
  const done = db.prepare("SELECT COUNT(*) n FROM campaign_contacts WHERE campaign_id=? AND status='completed'").get(cid).n;
  assert.equal(done, 3, 'all three completed without pressing Run');
});

// ─── Heartbeat ────────────────────────────────────────────────────
test('the worker heartbeat records ticks and stays healthy', async () => {
  await camp.tick();
  const h1 = camp.getWorkerHealth();
  assert.ok(h1.lastTickAt, 'lastTickAt is set after a tick');
  assert.ok(h1.ticks >= 1);
  await camp.tick();
  const h2 = camp.getWorkerHealth();
  assert.ok(h2.ticks > h1.ticks, 'tick count advances');
  assert.equal(h2.healthy, true, 'fresh tick → healthy');
});
