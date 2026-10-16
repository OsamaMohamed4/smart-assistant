// What a call that never connected is called: «لم يتم الرد» when the customer
// did not pick up, «تعذّر الاتصال» when the line refused it — and the SIP
// status that tells them apart, kept from the provider instead of dropped.
//
// The payloads below are the shapes this account's outbound calls actually
// came back with (read from the provider on 2026-10-16).
//
//   node --test scripts/test-call-status.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB = path.join(require('node:os').tmpdir(), `sa-callstatus-${Date.now()}.db`);
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = DB;

const { db } = require('../db');
const el = require('../services/voice/elevenlabs');
const { callStatus, endedReasonLabel, sipDisposition } = require('../lib/call-status');
const { classifyOutcome, qualifyCall, OUTCOME, LEAD } = require('../lib/lead-scoring');
const { contactStatusForCall } = require('../services/campaigns');

after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
});

// A conversation the way the provider returns one for a call that never rang
// through: status failed, no transcript, no termination reason, an error.
const failedConversation = (code, reason) => ({
  conversation_id: `conv_${code}_${reason.length}`,
  agent_id: 'agent_x',
  status: 'failed',
  transcript: [],
  metadata: {
    start_time_unix_secs: 1760000000,
    call_duration_secs: 0,
    termination_reason: null,
    error: { code, reason, error_type: 'call_initialization_error' },
    phone_call: { direction: 'outbound', external_number: '+966500000001', agent_number: '+966115009384' },
  },
});

// ─── The reason is kept ───────────────────────────────────────────
test('a call that never connected keeps its SIP status instead of nothing', () => {
  const cases = [
    [480, 'INVITE failed: sip status: 480: Temporarily Unavailable (SIP 480)', 'sip-480'],
    [486, 'INVITE failed: sip status: 486: Busy Here (SIP 486)', 'sip-486'],
    [404, 'INVITE failed: sip status: 404: Not Found (SIP 404)', 'sip-404'],
    [403, 'unexpected status from INVITE response: sip status: 403: Forbidden (SIP 403)', 'sip-403'],
    [1011, 'max auth retry attempts reached for SIP invite', 'sip-407'],
    [1011, 'sip server required auth, but no username or password was provided', 'sip-407'],
  ];
  for (const [code, reason, expected] of cases) {
    const ev = el.normalizeConversation(failedConversation(code, reason), { eventType: 'rest' });
    assert.equal(ev.endedReason, expected, `${code} ${reason}`);
    assert.equal(ev.durationSec, 0);
    assert.equal(ev.isFinal, true);
  }
});

test('a failure with no SIP status at all is still a platform-side fault', () => {
  const ev = el.normalizeConversation(failedConversation(1011, 'transaction failed to complete (0 intermediate responses)'), { eventType: 'rest' });
  assert.match(ev.endedReason, /^pipeline-error/);
  assert.equal(callStatus({ ended_reason: ev.endedReason, duration_sec: 0, direction: 'outbound' }), 'failed');
});

test('a connected call is read from its termination reason, not an error', () => {
  const ev = el.normalizeConversation({
    conversation_id: 'conv_ok', status: 'done',
    transcript: [{ role: 'agent', message: 'حياك الله' }, { role: 'user', message: 'هلا' }],
    metadata: { call_duration_secs: 39, termination_reason: 'Client disconnected: 1000', phone_call: { direction: 'outbound' } },
  }, { eventType: 'rest' });
  assert.equal(ev.endedReason, 'customer-ended-call');
});

test('a call_initiation_failure event uses the SIP status it carries', () => {
  const ev = el.normalizeEvent({
    type: 'call_initiation_failure',
    data: { conversation_id: 'conv_busy', agent_id: 'agent_x', failure_reason: 'unknown', metadata: { type: 'sip', body: { sip_status_code: 486 } } },
  });
  assert.equal(ev.endedReason, 'sip-486');
  assert.equal(ev.direction, 'outbound');
});

// ─── What the call list says ──────────────────────────────────────
const OLD = '2026-10-14 13:43:00';
const out = (ended_reason, extra = {}) => ({ ended_reason, duration_sec: 0, direction: 'outbound', created_at: OLD, ...extra });

test('the customer not answering, being busy or declining is «لم يتم الرد», not a failure', () => {
  for (const r of ['sip-480', 'sip-486', 'sip-487', 'sip-408', 'sip-603', 'sip-404', 'customer-did-not-answer', 'busy', 'voicemail', 'switched-off', 'invalid-number']) {
    assert.equal(callStatus(out(r)), 'no_answer', r);
  }
});

test('the line refusing the call is «تعذّر الاتصال» — the operator has to see it', () => {
  for (const r of ['sip-403', 'sip-407', 'sip-401', 'sip-503', 'pipeline-error (x)', 'call.in-progress.error-providerfault-outbound-sip-407-proxy-authentication-required']) {
    assert.equal(callStatus(out(r)), 'failed', r);
  }
});

test('an outbound call never heard back from is «لم يتم الرد» once it is old', () => {
  assert.equal(callStatus(out(null)), 'no_answer');
  // An inbound call that left no trace is a fault, not a customer who did not answer.
  assert.equal(callStatus(out(null, { direction: 'inbound' })), 'failed');
});

test('a fresh call with no outcome yet is in progress', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  assert.equal(callStatus(out(null, { created_at: '2026-10-16 11:30:00' }), now), 'in_progress');
  assert.equal(callStatus(out(null, { created_at: '2026-10-16 10:30:00' }), now), 'no_answer');
});

test('a call that connected is completed however it ended', () => {
  // A transfer and a silence timeout used to show as failed.
  for (const r of ['assistant-forwarded-call', 'silence-timed-out', 'max-duration-exceeded', 'customer-ended-call', 'assistant-ended-call', 'provider:odd']) {
    assert.equal(callStatus({ ended_reason: r, duration_sec: 40, direction: 'inbound', created_at: OLD }), 'completed', r);
  }
  assert.equal(callStatus({ ended_reason: null, duration_sec: 0, has_transcript: 1, direction: 'outbound', created_at: OLD }), 'completed');
});

test('every reason a person sees is Arabic', () => {
  const reasons = ['sip-480', 'sip-486', 'sip-603', 'sip-404', 'sip-403', 'sip-407', 'sip-503', 'sip-418',
    'customer-ended-call', 'assistant-ended-call', 'assistant-forwarded-call', 'silence-timed-out',
    'max-duration-exceeded', 'voicemail', 'customer-did-not-answer', 'busy', 'switched-off', 'invalid-number', 'pipeline-error (x)'];
  for (const r of reasons) {
    const label = endedReasonLabel(r);
    assert.ok(label && /[؀-ۿ]/.test(label) && !/[A-Za-z]/.test(label), `${r} → ${label}`);
  }
  assert.equal(endedReasonLabel(null), null);
  assert.equal(endedReasonLabel('provider:something_new'), null);
});

// ─── The campaign report and the retry agree ─────────────────────
test('the campaign report no longer counts a busy or unanswered line as a connection failure', () => {
  const oc = (reason) => classifyOutcome({ status: 'no_answer' }, { ended_reason: reason, duration_sec: 0 });
  assert.equal(oc('sip-486'), OUTCOME.BUSY);
  assert.equal(oc('sip-603'), OUTCOME.BUSY);
  assert.equal(oc('sip-480'), OUTCOME.NO_ANSWER);
  assert.equal(oc('sip-404'), OUTCOME.INVALID);
  assert.equal(classifyOutcome({ status: 'failed' }, { ended_reason: 'sip-403', duration_sec: 0 }), OUTCOME.FAILED);
  assert.equal(qualifyCall({ ended_reason: 'sip-480', duration_sec: 0 }).lead, LEAD.NO_ANSWER);
  assert.equal(qualifyCall({ ended_reason: 'sip-404', duration_sec: 0 }).lead, LEAD.INVALID);
});

test('a contact whose call was not answered is tried again, not closed as completed', () => {
  // Before the reason was kept these arrived with no reason (→ no_answer).
  // Now they carry sip-480; that must not fall through to "completed".
  assert.equal(contactStatusForCall('sip-480', 0), 'no_answer');
  assert.equal(contactStatusForCall('sip-486', 0), 'no_answer');
  assert.equal(contactStatusForCall('sip-403', 0), 'failed');
  assert.equal(contactStatusForCall('sip-404', 0), 'failed');
  assert.equal(contactStatusForCall(null, 0), 'no_answer');
  assert.equal(contactStatusForCall('assistant-ended-call', 60), 'completed');
  assert.equal(sipDisposition('assistant-ended-call'), null);
});
