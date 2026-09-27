// Proof suite for the campaign worker diagnostics (the "why is it stuck
// pending?" investigation). Uses a real SQLite DB and a mocked voice provider,
// so the whole tick path runs — state transitions, eligibility, skip reasons,
// and the heartbeat — without touching the network.
//
//   node --test scripts/test-campaign-worker.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB = path.join(require('node:os').tmpdir(), `sa-worker-${Date.now()}.db`);
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = DB;
process.env.ELEVENLABS_API_KEY = 'k';

// Mock the voice provider at the FACADE, not at axios. The worker's only
// contract with a provider is voice.startOutboundCall(), so stubbing there
// keeps this suite honest when the provider changes again.
const voice = require('../services/voice');
let placedCalls = 0;
const realStartOutboundCall = voice.startOutboundCall;
voice.startOutboundCall = async () => {
  placedCalls++;
  return { callId: `conv-${placedCalls}`, callRef: `sip-${placedCalls}`, status: 'queued' };
};

const { sql, db } = require('../db');
const camp = require('../services/campaigns');

const nowSaudi = (new Date().getUTCHours() + 3) % 24;
const openStart = (nowSaudi - 1 + 24) % 24;   // window open right now
const openEnd = (nowSaudi + 1) % 24;

async function makeCampaign({
  name, sh = openStart, eh = openEnd, published = true, contacts = 1,
  maxConcurrent = 2, withNumber = true,
}) {
  db.prepare(`INSERT INTO companies (id,name,language,system_prompt,elevenlabs_agent_id,elevenlabs_phone_number_id,voice_provider)
              VALUES (?,?,'ar-SA','',?,?, 'elevenlabs')`)
    .run(`co-${name}`, name, published ? `agent-${name}` : null, withNumber ? `phnum-${name}` : null);
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

after(() => {
  voice.startOutboundCall = realStartOutboundCall;
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
});

// ─── State transition: pending → calling ──────────────────────────
test('eligible campaign dials: pending → calling, reason=dialed', async () => {
  const cid = await makeCampaign({ name: 'dial', contacts: 2 });
  assert.equal(statusOf(cid)[0].status, 'pending');
  const r = await camp.tickCampaign(get(cid));
  assert.equal(r.reason, 'dialed');
  assert.equal(r.placed, 2);
  assert.deepEqual(statusOf(cid), [{ status: 'calling', n: 2 }]);
});

// The provider's conversation id must land on BOTH the contact and the call
// stub, or the end-of-call webhook can never resolve the contact's outcome.
test('the provider call id is recorded on the contact and the call stub', async () => {
  const cid = await makeCampaign({ name: 'ids', contacts: 1 });
  await camp.tickCampaign(get(cid));
  const contact = db.prepare('SELECT call_id FROM campaign_contacts WHERE campaign_id=?').get(cid);
  assert.match(contact.call_id, /^conv-\d+$/);
  const call = await sql.getCall.get(contact.call_id);
  assert.ok(call, 'a call stub row exists for the provider call id');
  assert.equal(call.direction, 'outbound');
  assert.equal(call.provider, 'elevenlabs');
  assert.match(call.provider_call_ref, /^sip-\d+$/, 'SIP call id stored for PBX correlation');
  assert.equal(call.company_id, 'co-ids', 'stub is tenant-scoped');
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

// Multi-tenant safety: a company with no imported number of its own must NOT
// dial. There is deliberately no platform-wide fallback number, because with
// several tenants that fallback would place this company's calls on another
// company's phone line.
test('reason=no_number when the company has no imported number of its own', async () => {
  const cid = await makeCampaign({ name: 'nonum', withNumber: false });
  const before = placedCalls;
  const r = await camp.tickCampaign(get(cid));
  assert.equal(r.reason, 'no_number');
  assert.equal(get(cid).status, 'paused');
  assert.equal(placedCalls, before, 'placed NO calls without its own number');
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
  const before = placedCalls;
  const d = await camp.diagnoseCampaign(get(cid));
  assert.equal(d.reason, 'dialing');
  assert.equal(d.pending, 1);
  assert.equal(placedCalls, before, 'diagnose placed NO calls');
  assert.match(d.saudiTime, /^\d{2}:\d{2}$/);
});

test('diagnoseCampaign reports outside_window read-only', async () => {
  const cid = await makeCampaign({ name: 'diagclosed', sh: (nowSaudi + 2) % 24, eh: (nowSaudi + 3) % 24 });
  const d = await camp.diagnoseCampaign(get(cid));
  assert.equal(d.reason, 'outside_window');
  assert.equal(d.window.open, false);
});

// ─── The real bug: provider errors with an ARRAY message ──────────
test('a provider error with an array message does NOT crash the tick', async () => {
  // Validation errors come back as { message: ['...','...'] }. The old code did
  // message.slice() → an array → SQL bind error → thrown out of the whole tick
  // → swallowed → contact stuck. Reproduce that exact shape.
  const cid = await makeCampaign({ name: 'arrerr', contacts: 1 });
  const saved = voice.startOutboundCall;
  voice.startOutboundCall = async () => {
    const e = new Error('Request failed');
    e.response = { status: 422, data: { message: ['to_number is not valid', 'invalid number'] } };
    throw e;
  };
  try {
    let result;
    await assert.doesNotReject(async () => { result = await camp.tickCampaign(get(cid)); },
      'tick must not throw on an array error message');
    assert.equal(result.reason, 'no_pending', 'ran to completion');
  } finally { voice.startOutboundCall = saved; }

  // The contact must be cleanly marked failed with a STRING error, not stuck.
  const rows = statusOf(cid);
  assert.equal(rows[0].status, 'failed', 'contact marked failed, not left calling/pending');
  const err = db.prepare('SELECT last_error FROM campaign_contacts WHERE campaign_id=?').get(cid).last_error;
  assert.equal(typeof err, 'string');
  assert.match(err, /to_number|invalid number/, 'array joined into a readable string');
});
