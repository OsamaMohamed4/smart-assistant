// Regression suite for three production-readiness defects found reviewing the
// ElevenLabs migration. Deliberately DRIVER-AGNOSTIC — it touches the database
// only through the shared statement catalog and the `?`-placeholder helpers, so
// the identical assertions run on SQLite and on PostgreSQL:
//
//   npm run test:unit                       (SQLite — included by default)
//   DB_DRIVER=postgres DATABASE_URL=postgres://user:pass@host/db \
//     npm run test:pg:integrity             (the engine production runs)
//
// That matters because the bugs below are SQL-semantics bugs. Verifying them on
// one engine would prove nothing about the engine production actually runs.
//
//   #3 two companies could claim one phone number, and resolution picked
//      whichever row came back first — silently attributing a call to the
//      wrong tenant.
//   #4 a later, partial provider event overwrote already-known columns with
//      NULL, erasing the customer's number, the start time, and the company.
//   #7 recording_url held a provider-scoped identifier dressed as a URL, which
//      leaked into customer webhooks and CSV exports.
//
// Plus the defects confirmed in the later live-provider verification round:
//
//   post_call_transcription and post_call_audio shared one inbox key, so the
//      second to arrive was silently dropped instead of stored for retry.
//   the in-call knowledge-base tool had no per-tenant cost ceiling, although
//      every invocation costs a paid embedding request.
//   session history was read unbounded on every turn and then truncated in JS.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const IS_PG = (process.env.DB_DRIVER || '').toLowerCase() === 'postgres';
const TMP_DB = path.join(require('node:os').tmpdir(), `sa-integrity-${Date.now()}.db`);
if (!IS_PG) {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DB_PATH = TMP_DB;
}

const { sql, all: dataAll, run: dataRun, initDb, close: dbClose } = require('../db');
const el = require('../services/voice/elevenlabs');
const events = require('../services/call-events');

// Namespaced per run so a shared Postgres database can be reused safely.
const RUN = Date.now().toString(36);
const cid = (name) => `co-${name}-${RUN}`;
const callId = (name) => `call-${name}-${RUN}`;

async function makeCompany(name, { phone = null, phoneId = null, agent = null } = {}) {
  const id = cid(name);
  await dataRun(
    `INSERT INTO companies (id, name, language, system_prompt, voice_provider,
       elevenlabs_agent_id, elevenlabs_phone_number_id, phone_number)
     VALUES (?, ?, 'ar-SA', '', 'elevenlabs', ?, ?, ?)`,
    [id, name, agent, phoneId, phone],
  );
  return id;
}

// Force a duplicate past the UNIQUE index so the CODE-level refusal can be
// tested on its own. The index is the primary defence; this proves the resolver
// does not depend on it — an older database may not have it yet.
//
// Returns a cleanup function. Tests MUST call it: a lingering duplicate keeps
// the index uninstallable and would silently break every later test that
// depends on the constraint being present.
async function forceDuplicate(companyId, column, value) {
  const index = column === 'phone_number' ? 'uq_companies_phone_number' : 'uq_companies_el_phone_id';
  await dataRun(`DROP INDEX IF EXISTS ${index}`);
  await dataRun(`UPDATE companies SET ${column} = ? WHERE id = ?`, [value, companyId]);
  return async () => {
    await dataRun(`UPDATE companies SET ${column} = NULL WHERE id = ?`, [companyId]);
    await reinstallOwnershipIndexes();
  };
}

// Re-run the installer that adds the unique indexes, exactly as a boot would.
async function reinstallOwnershipIndexes() {
  if (IS_PG) {
    const { addUniqueOwnershipIndexes } = require('../lib/migrations-pg');
    const { q } = require('../lib/db-pg');
    return addUniqueOwnershipIndexes(q);
  }
  return require('../db-sqlite').ensureUniquePhoneOwnership();
}

before(async () => { await initDb(); });

after(async () => {
  // Leave a shared Postgres database as we found it.
  try {
    await dataRun('DELETE FROM calls WHERE id LIKE ?', [`%-${RUN}`]);
    await dataRun('DELETE FROM companies WHERE id LIKE ?', [`%-${RUN}`]);
  } catch { /* best effort */ }
  try { await dbClose(); } catch {}
  if (!IS_PG) for (const s of ['', '-wal', '-shm']) fs.rmSync(TMP_DB + s, { force: true });
});

// ══════════════════════════════════════════════════════════════════
// #3 — one company per phone number
// ══════════════════════════════════════════════════════════════════

test('#3 the database REFUSES a second company claiming the same DID', async () => {
  const shared = `+96650000${RUN.slice(-4)}`;
  await makeCompany('own-a', { phone: shared });
  await assert.rejects(
    () => makeCompany('own-b', { phone: shared }),
    'a duplicate phone_number must be rejected by the unique index',
  );
});

test('#3 the database REFUSES a second company claiming the same provider number id', async () => {
  const sharedId = `phnum-${RUN}`;
  await makeCompany('pid-a', { phoneId: sharedId });
  await assert.rejects(
    () => makeCompany('pid-b', { phoneId: sharedId }),
    'a duplicate elevenlabs_phone_number_id must be rejected by the unique index',
  );
});

test('#3 NULL numbers are exempt — many unprovisioned companies coexist', async () => {
  await makeCompany('null-a');
  await makeCompany('null-b');
  await makeCompany('null-c');
  const rows = await dataAll(
    'SELECT id FROM companies WHERE phone_number IS NULL AND id LIKE ?', [`%-${RUN}`],
  );
  assert.ok(rows.length >= 3, 'the partial index must not block NULLs');
});

test('#3 ambiguous DID ownership is REFUSED, not resolved to an arbitrary tenant', async () => {
  const shared = `+96651111${RUN.slice(-4)}`;
  const a = await makeCompany('amb-a', { phone: shared, agent: `agent-amb-a-${RUN}` });
  const b = await makeCompany('amb-b', { agent: `agent-amb-b-${RUN}` });
  const cleanup = await forceDuplicate(b, 'phone_number', shared);
  try {
    // Sanity: the database really does hold two claimants now.
    const claimants = await dataAll('SELECT id FROM companies WHERE phone_number = ?', [shared]);
    assert.equal(claimants.length, 2);

    // An event with no usable agent id must fall back to the number — and refuse.
    const ev = {
      provider: 'elevenlabs', providerCallId: callId('amb'),
      agentId: null, destinationNumber: shared, metadata: {},
    };
    const resolved = await el.resolveCompanyForEvent(ev, { error() {}, warn() {} });
    assert.equal(resolved, null, 'must refuse rather than pick the first row');
    assert.notEqual(resolved, a);
    assert.notEqual(resolved, b);
  } finally { await cleanup(); }
});

test('#3 ambiguous AGENT ownership is refused too', async () => {
  const sharedAgent = `agent-dup-${RUN}`;
  await makeCompany('agdup-a', { agent: sharedAgent });
  await makeCompany('agdup-b', { agent: sharedAgent });   // agent id has no unique index
  const resolved = await el.uniqueCompanyId(
    sql.companyByAgentId, sharedAgent, 'elevenlabs_agent_id', { error() {} },
  );
  assert.equal(resolved, null);
});

test('#3 unambiguous ownership still resolves normally', async () => {
  const phone = `+96652222${RUN.slice(-4)}`;
  const id = await makeCompany('clean', { phone, agent: `agent-clean-${RUN}` });
  assert.equal(
    await el.uniqueCompanyId(sql.companyByPhoneNumber, phone, 'phone_number'),
    id, 'exactly one claimant resolves',
  );
  assert.equal(
    await el.uniqueCompanyId(sql.companyByAgentId, `agent-clean-${RUN}`, 'elevenlabs_agent_id'),
    id,
  );
});

test('#3 releasing a number is scoped to THAT number and spares every other row', async () => {
  const moving = `+96653333${RUN.slice(-4)}`;
  const untouched = `+96654444${RUN.slice(-4)}`;
  const from = await makeCompany('rel-from', { phone: moving });
  const to   = await makeCompany('rel-to');
  const other = await makeCompany('rel-other', { phone: untouched });

  await sql.clearPhoneNumberOwner.run({ value: moving, keep: to });

  const fromRow  = (await dataAll('SELECT phone_number FROM companies WHERE id = ?', [from]))[0];
  const otherRow = (await dataAll('SELECT phone_number FROM companies WHERE id = ?', [other]))[0];
  assert.equal(fromRow.phone_number, null, 'previous owner released');
  assert.equal(otherRow.phone_number, untouched, 'an unrelated company keeps its own number');
});

test('#3 releasing never strips the number from the company being granted it', async () => {
  const num = `+96655555${RUN.slice(-4)}`;
  const keeper = await makeCompany('rel-keep', { phone: num });
  await sql.clearPhoneNumberOwner.run({ value: num, keep: keeper });
  const row = (await dataAll('SELECT phone_number FROM companies WHERE id = ?', [keeper]))[0];
  assert.equal(row.phone_number, num, 'the new owner is excluded from the clear');
});

test('#3 releasing a provider number id behaves the same way', async () => {
  const pid = `phnum-move-${RUN}`;
  const from = await makeCompany('pidrel-from', { phoneId: pid });
  const to   = await makeCompany('pidrel-to');
  await sql.clearElevenLabsPhoneOwner.run({ value: pid, keep: to });
  const row = (await dataAll('SELECT elevenlabs_phone_number_id FROM companies WHERE id = ?', [from]))[0];
  assert.equal(row.elevenlabs_phone_number_id, null);
});

// The dangerous branch. An existing production database may ALREADY contain a
// duplicate, and CREATE UNIQUE INDEX fails hard on one. If that runs anywhere
// the boot cannot tolerate a failure, adding this safety constraint would take
// the whole service down — turning a data problem into an outage. It must
// report the conflict, leave the constraint off, and carry on.
test('#3 a pre-existing duplicate does NOT take the process down', async () => {
  const shared = `+96657777${RUN.slice(-4)}`;
  const a = await makeCompany('boot-a', { phone: shared });
  const b = await makeCompany('boot-b');
  await forceDuplicate(b, 'phone_number', shared);   // resolved by hand below

  // `async () =>` on purpose: the db helpers are synchronous under SQLite and
  // Promise-returning under Postgres, so the wrapper normalizes both.
  await assert.doesNotReject(
    async () => { await reinstallOwnershipIndexes(); },
    'a duplicate must be reported, never thrown',
  );

  // Constraint correctly withheld — the data is still ambiguous.
  await assert.doesNotReject(
    async () => { await dataRun('UPDATE companies SET phone_number = ? WHERE id = ?', [shared, a]); },
    'the index is not installed while the conflict stands',
  );

  // Now resolve the conflict the way the log tells an operator to, and the
  // constraint installs itself on the next boot with no migration to re-run.
  await dataRun('UPDATE companies SET phone_number = NULL WHERE id = ?', [b]);
  await reinstallOwnershipIndexes();
  await assert.rejects(
    () => makeCompany('boot-c', { phone: shared }),
    'once the data is clean the constraint is enforced again',
  );
});

// ══════════════════════════════════════════════════════════════════
// #4 — a partial event must never blank a known field
// ══════════════════════════════════════════════════════════════════

const FULL_CALL = (id, companyId) => ({
  id,
  company_id : companyId,
  assistant_id: `agent-full-${RUN}`,
  caller_number: '+966555000111',
  duration_sec : 42,
  started_at   : '2026-09-01 10:00:00',
  ended_at     : '2026-09-01 10:00:42',
  ended_reason : 'assistant-ended-call',
  transcript   : 'AI: أهلاً\nUser: شكراً',
  summary      : 'مكالمة مكتملة.',
  cost_usd     : 0.42,
  cost_credits : 296,
  direction    : 'outbound',
  recording_url: null,
  structured_data: JSON.stringify({ interest_level: 'مهتم' }),
  provider     : 'elevenlabs',
  provider_call_ref: 'sip-full',
  has_recording: 1,
});

// Every nullable column empty — the shape a call_initiation_failure produces.
const SPARSE_EVENT = (id) => ({
  id,
  company_id : null,
  assistant_id: null,
  caller_number: null,
  duration_sec : null,
  started_at   : null,
  ended_at     : null,
  ended_reason : 'customer-did-not-answer',
  transcript   : null,
  summary      : null,
  cost_usd     : null,
  cost_credits : null,
  direction    : null,
  recording_url: null,
  structured_data: null,
  provider     : null,
  provider_call_ref: null,
  has_recording: 0,
});

test('#4 a sparse later event cannot blank ANY already-known column', async () => {
  const companyId = await makeCompany('keep', { agent: `agent-keep-${RUN}` });
  const id = callId('keep');
  await sql.upsertCall.run(FULL_CALL(id, companyId));
  await sql.upsertCall.run(SPARSE_EVENT(id));

  const row = await sql.getCall.get(id);
  assert.equal(row.company_id, companyId, 'company_id preserved');
  assert.equal(row.assistant_id, `agent-full-${RUN}`, 'assistant_id preserved');
  assert.equal(row.caller_number, '+966555000111', 'caller_number preserved');
  assert.equal(Number(row.duration_sec), 42, 'duration preserved');
  assert.equal(row.started_at, '2026-09-01 10:00:00', 'started_at preserved');
  assert.equal(row.ended_at, '2026-09-01 10:00:42', 'ended_at preserved');
  assert.equal(row.transcript, 'AI: أهلاً\nUser: شكراً', 'transcript preserved');
  assert.equal(row.summary, 'مكالمة مكتملة.', 'summary preserved');
  assert.equal(Number(row.cost_usd), 0.42, 'cost preserved');
  assert.equal(Number(row.cost_credits), 296, 'credit cost preserved');
  assert.equal(row.direction, 'outbound', 'direction preserved');
  assert.equal(row.provider, 'elevenlabs', 'provider preserved');
  assert.equal(row.provider_call_ref, 'sip-full', 'sip ref preserved');
  assert.ok(row.structured_data.includes('مهتم'), 'lead data preserved');
  assert.equal(Number(row.has_recording), 1, 'recording flag latched on');
  // The one field the sparse event DID carry must still be written.
  assert.equal(row.ended_reason, 'customer-did-not-answer', 'new facts are still applied');
});

test('#4 a later event may still CORRECT a field to a new non-null value', async () => {
  const companyId = await makeCompany('correct', { agent: `agent-correct-${RUN}` });
  const id = callId('correct');
  await sql.upsertCall.run(FULL_CALL(id, companyId));
  await sql.upsertCall.run({
    ...SPARSE_EVENT(id), duration_sec: 99, summary: 'ملخص محدَّث.', direction: 'inbound',
  });
  const row = await sql.getCall.get(id);
  assert.equal(Number(row.duration_sec), 99, 'preserve-on-null must not mean ignore-always');
  assert.equal(row.summary, 'ملخص محدَّث.');
  assert.equal(row.direction, 'inbound');
});

test('#4 stub → partial call_initiation_failure keeps the stub intact end to end', async () => {
  const companyId = await makeCompany('e2e', { agent: `agent-e2e-${RUN}`, phone: `+96656666${RUN.slice(-4)}` });
  const id = callId('e2e');
  await sql.insertOutboundCallStub.run({
    id, company_id: companyId, assistant_id: `agent-e2e-${RUN}`,
    caller_number: '+966555777888', provider: 'elevenlabs', provider_call_ref: null,
  });
  const stub = await sql.getCall.get(id);

  // Runs the REAL pipeline: normalize → resolve → persist.
  const ev = el.normalizeEvent({
    type: 'call_initiation_failure',
    data: { conversation_id: id, reason: 'sip 480 temporarily unavailable' },
  });
  await events.processCallEvent(ev);

  const row = await sql.getCall.get(id);
  assert.equal(row.company_id, companyId, 'the tenant keeps the call');
  assert.equal(row.caller_number, stub.caller_number, 'the number we dialled survives');
  assert.equal(row.started_at, stub.started_at, 'the attempt time survives');
  assert.equal(row.direction, 'outbound', 'still an outbound call');
  assert.equal(row.ended_reason, 'sip-480', 'the failure reason was recorded');
});

test('#4 an initiation failure arriving BEFORE the stub is still outbound', async () => {
  const companyId = await makeCompany('race', { agent: `agent-race-${RUN}` });
  const id = callId('race');
  // No stub yet — the webhook won the race.
  const ev = el.normalizeEvent({
    type: 'call_initiation_failure',
    data: { conversation_id: id, agent_id: `agent-race-${RUN}`, to_number: '+966555999000', reason: 'busy' },
  });
  await events.processCallEvent(ev);
  const row = await sql.getCall.get(id);
  assert.equal(row.direction, 'outbound', 'must not default to inbound');
  assert.equal(row.company_id, companyId);
  assert.equal(row.ended_reason, 'busy');
});

// ══════════════════════════════════════════════════════════════════
// #7 — no internal identifier may masquerade as a recording URL
// ══════════════════════════════════════════════════════════════════

test('#7 a call WITH audio yields a null recording_url and a true flag', () => {
  const ev = el.normalizeConversation({
    conversation_id: 'conv_rec', agent_id: 'agent_x', status: 'done',
    transcript: [{ role: 'agent', message: 'مرحباً', time_in_call_secs: 0 }],
    metadata: { start_time_unix_secs: 1767225600, call_duration_secs: 10 },
    analysis: {}, has_audio: true,
  });
  assert.equal(ev.recordingUrl, null, 'no public URL exists, so none is claimed');
  assert.equal(ev.hasRecording, true, 'but the UI still learns audio exists');
});

test('#7 no normalized event ever emits a provider-scoped sentinel URL', () => {
  const samples = [
    el.normalizeConversation({
      conversation_id: 'c1', metadata: {}, analysis: {}, has_audio: true, transcript: [],
    }),
    el.normalizeEvent({
      type: 'call_initiation_failure',
      data: { conversation_id: 'c2', reason: 'busy' },
    }),
  ];
  for (const ev of samples) {
    assert.ok(!ev.recordingUrl || /^https?:\/\//.test(ev.recordingUrl),
      `recording_url must be null or a real URL, got ${ev.recordingUrl}`);
    assert.ok(!/^elevenlabs:/.test(String(ev.recordingUrl)), 'no internal sentinel');
  }
});

test('#7 the stored row carries the flag, never a fake URL', async () => {
  const companyId = await makeCompany('rec', { agent: `agent-rec-${RUN}` });
  const id = callId('rec');
  const ev = el.normalizeConversation({
    conversation_id: id, agent_id: `agent-rec-${RUN}`, status: 'done',
    transcript: [{ role: 'agent', message: 'مرحباً', time_in_call_secs: 0 }],
    metadata: { start_time_unix_secs: 1767225600, call_duration_secs: 10 },
    analysis: {}, has_audio: true,
  });
  await events.processCallEvent(ev);
  const row = await sql.getCall.get(id);
  assert.equal(row.recording_url, null, 'no sentinel reached the database');
  assert.equal(Number(row.has_recording), 1);
  assert.equal(row.company_id, companyId);
});

test('#7 recordingLinkFor gives operators a real link and outsiders nothing fake', () => {
  const withAudio = { id: 'conv_1', has_recording: 1, recording_url: null };
  assert.equal(
    events.recordingLinkFor(withAudio, 'https://app.example.com'),
    'https://app.example.com/api/calls/conv_1/recording',
  );
  // No base URL configured → null, never a half-formed or internal string.
  assert.equal(events.recordingLinkFor(withAudio, ''), null);
  assert.equal(events.recordingLinkFor({ id: 'x', has_recording: 0 }, 'https://a.b'), null);
  // A historical row that really does hold a provider URL keeps it verbatim.
  assert.equal(
    events.recordingLinkFor({ id: 'old', recording_url: 'https://storage.example/old.wav' }, 'https://a.b'),
    'https://storage.example/old.wav',
  );
});

test('#7 the customer webhook payload never ships an unfetchable link', () => {
  const { buildPayload } = require('../services/outbound-webhook');
  const payload = JSON.parse(buildPayload('co-x', {
    id: 'conv_9', direction: 'inbound', caller_number: '+966500000000',
    duration_sec: 30, started_at: null, ended_at: null, ended_reason: 'assistant-ended-call',
    summary: 's', transcript: 't', recording_url: null, has_recording: 1,
  }));
  assert.equal(payload.call.recording_url, null, 'null is honest; a sentinel is not');
  assert.equal(payload.call.has_recording, true, 'the receiver still learns audio exists');
});

// ══════════════════════════════════════════════════════════════════
// Live-provider verification round. Each block below records a defect
// confirmed against the real ElevenLabs API on 2026-09-18.
// ══════════════════════════════════════════════════════════════════

// ── The webhook inbox key ─────────────────────────────────────────
// post_call_transcription and post_call_audio carry the SAME conversation_id.
// The inbox is UNIQUE(provider, event_id) ... ON CONFLICT DO NOTHING, so keying
// on the conversation alone meant the second of the two was never stored — and
// therefore never retryable. If processing then failed, it was lost for good.
const { webhookEventId, kbSearchAllowed } = require('../routes/webhook');

test('the two post-call event types do NOT collide on one inbox key', () => {
  const conv = 'conv_shared_id';
  const t = webhookEventId({ type: 'post_call_transcription', data: { conversation_id: conv } });
  const a = webhookEventId({ type: 'post_call_audio', data: { conversation_id: conv } });
  assert.notEqual(t, a, 'one conversation produces two DISTINCT inbox keys');
  assert.ok(t.includes(conv) && a.includes(conv), 'the conversation is still identifiable');
  assert.ok(t.startsWith('post_call_transcription'), 'the type leads the key');
});

test('redelivery of the SAME event type is still deduplicated', () => {
  const p = { type: 'post_call_transcription', data: { conversation_id: 'conv_x' } };
  assert.equal(webhookEventId(p), webhookEventId({ ...p }), 'idempotency per type is preserved');
});

test('an event with no conversation id is stored rather than deduplicated away', () => {
  // NULL is distinct from every other NULL in SQL, so these always insert. A
  // duplicate row is recoverable; a dropped event is not.
  assert.equal(webhookEventId({ type: 'call_initiation_failure', data: {} }), null);
  assert.equal(webhookEventId(null), null);
});

test('both event types for one call survive in the inbox together', async () => {
  const conv = `conv-inbox-${RUN}`;
  for (const type of ['post_call_transcription', 'post_call_audio']) {
    await sql.insertWebhookEvent.run({
      provider: 'elevenlabs',
      event_id: webhookEventId({ type, data: { conversation_id: conv } }),
      event_type: type,
      raw_body: JSON.stringify({ type }),
    });
  }
  const rows = await dataAll(
    `SELECT event_type FROM webhook_events WHERE event_id LIKE ? ORDER BY event_type`,
    [`%${conv}`],
  );
  assert.equal(rows.length, 2, 'the audio event no longer displaces the transcription event');
  assert.deepEqual(rows.map((r) => r.event_type), ['post_call_audio', 'post_call_transcription']);

  // …while a genuine redelivery of one of them still does not duplicate.
  await sql.insertWebhookEvent.run({
    provider: 'elevenlabs',
    event_id: webhookEventId({ type: 'post_call_audio', data: { conversation_id: conv } }),
    event_type: 'post_call_audio',
    raw_body: '{}',
  });
  const again = await dataAll(`SELECT id FROM webhook_events WHERE event_id LIKE ?`, [`%${conv}`]);
  assert.equal(again.length, 2, 'redelivery is still idempotent');
});

// ── Knowledge-base tool cost ceiling ──────────────────────────────
// The in-call KB tool runs a paid embedding request per invocation and the
// AGENT decides how often to call it, so it needs a tenant-scoped ceiling like
// every other billable path in the system.
test('the in-call KB tool stops searching once the company hits its daily cap', async () => {
  const companyId = await makeCompany('kbcap');
  const prev = process.env.DAILY_KB_TOOL_CAP;
  process.env.DAILY_KB_TOOL_CAP = '3';
  try {
    for (let i = 1; i <= 3; i++) {
      assert.equal(await kbSearchAllowed(companyId, null), true, `search ${i} of 3 allowed`);
    }
    assert.equal(await kbSearchAllowed(companyId, null), false, 'the 4th is refused');
    assert.equal(await kbSearchAllowed(companyId, null), false, 'and stays refused');
  } finally {
    if (prev === undefined) delete process.env.DAILY_KB_TOOL_CAP;
    else process.env.DAILY_KB_TOOL_CAP = prev;
  }
});

test('one company exhausting its KB budget does not affect another', async () => {
  const a = await makeCompany('kbcap-a');
  const b = await makeCompany('kbcap-b');
  const prev = process.env.DAILY_KB_TOOL_CAP;
  process.env.DAILY_KB_TOOL_CAP = '1';
  try {
    assert.equal(await kbSearchAllowed(a, null), true);
    assert.equal(await kbSearchAllowed(a, null), false, 'company A is spent');
    assert.equal(await kbSearchAllowed(b, null), true, 'company B is unaffected — the cap is per tenant');
  } finally {
    if (prev === undefined) delete process.env.DAILY_KB_TOOL_CAP;
    else process.env.DAILY_KB_TOOL_CAP = prev;
  }
});

test('an unauthenticated KB call cannot consume any tenant budget', async () => {
  assert.equal(await kbSearchAllowed(null, null), false, 'no company id => refused outright');
});

test('KB tool usage is metered separately from chat messages', async () => {
  const companyId = await makeCompany('kbkind');
  const prev = process.env.DAILY_KB_TOOL_CAP;
  process.env.DAILY_KB_TOOL_CAP = '1';
  try {
    await kbSearchAllowed(companyId, null);
    const rows = await dataAll(
      `SELECT kind FROM usage_counters WHERE company_id = ? ORDER BY kind`, [companyId],
    );
    assert.deepEqual(rows.map((r) => r.kind), ['kb_tool'],
      'a KB search must not eat into the chat allowance');
  } finally {
    if (prev === undefined) delete process.env.DAILY_KB_TOOL_CAP;
    else process.env.DAILY_KB_TOOL_CAP = prev;
  }
});

// ── Bounded session history ───────────────────────────────────────
// A months-old WhatsApp thread was read in full on every single turn, only for
// all but the last few messages to be discarded in JS.
test('session history reads a BOUNDED window, newest first', async () => {
  const companyId = await makeCompany('history');
  const session = `sess-${RUN}`;
  for (let i = 1; i <= 60; i++) {
    await dataRun(
      `INSERT INTO chats (company_id, session_id, user_message, assistant_reply, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [companyId, session, `msg ${i}`, `reply ${i}`, `2026-09-01 10:${String(i).padStart(2, '0')}:00`],
    );
  }
  const rows = await sql.getSessionRecent.all(session, companyId, 20);
  assert.equal(rows.length, 20, 'exactly the requested window, not all 60 rows');
  assert.equal(rows[0].user_message, 'msg 60', 'newest first');
  assert.equal(rows[19].user_message, 'msg 41', 'and the window is contiguous');

  // The reversal the caller applies must restore chronological order.
  const chronological = rows.slice().reverse();
  assert.equal(chronological[0].user_message, 'msg 41');
  assert.equal(chronological[19].user_message, 'msg 60', 'the newest turn is last, as the LLM expects');
});

test('the bounded read is still scoped to ONE tenant', async () => {
  const a = await makeCompany('hist-a');
  const b = await makeCompany('hist-b');
  const session = `shared-sess-${RUN}`;   // same session id, two tenants
  await dataRun(
    `INSERT INTO chats (company_id, session_id, user_message, assistant_reply) VALUES (?, ?, ?, ?)`,
    [a, session, 'tenant A secret', 'ok'],
  );
  await dataRun(
    `INSERT INTO chats (company_id, session_id, user_message, assistant_reply) VALUES (?, ?, ?, ?)`,
    [b, session, 'tenant B secret', 'ok'],
  );
  const rows = await sql.getSessionRecent.all(session, a, 20);
  assert.equal(rows.length, 1, 'a guessable session id still yields only the calling tenant rows');
  assert.equal(rows[0].user_message, 'tenant A secret');
});

test('a short session returns everything it has, unpadded', async () => {
  const companyId = await makeCompany('hist-short');
  const session = `short-${RUN}`;
  await dataRun(
    `INSERT INTO chats (company_id, session_id, user_message, assistant_reply) VALUES (?, ?, ?, ?)`,
    [companyId, session, 'only turn', 'only reply'],
  );
  const rows = await sql.getSessionRecent.all(session, companyId, 20);
  assert.equal(rows.length, 1);
});
