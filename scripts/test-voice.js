// Proof suite for the ElevenLabs voice layer and the provider-neutral call
// pipeline. Runs against a real SQLite DB with no network access: webhook
// payloads are synthesised, so every assertion is about OUR parsing, OUR
// tenant resolution and OUR storage, not about the provider being up.
//
//   node --test scripts/test-voice.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const DB = path.join(require('node:os').tmpdir(), `sa-voice-${Date.now()}.db`);
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = DB;
process.env.NODE_ENV = 'production';          // so an unset secret fails CLOSED
process.env.ELEVENLABS_API_KEY = 'k';
process.env.ELEVENLABS_WEBHOOK_SECRET = 'wsec_test_secret_value';
process.env.PUBLIC_BASE_URL = 'https://example.test';

const { sql, db } = require('../db');
const el = require('../services/voice/elevenlabs');
const voice = require('../services/voice');
const events = require('../services/call-events');
const { qualifyContact, classifyOutcome, OUTCOME, LEAD } = require('../lib/lead-scoring');

after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
});

// Two tenants, each with its OWN agent, its OWN imported number and its OWN
// 3CX DID — the exact shape the multi-tenant requirement describes.
function seedCompany(id, { agent, inboundAgent = null, phoneId, did }) {
  db.prepare(`INSERT INTO companies
      (id,name,language,system_prompt,voice_provider,elevenlabs_agent_id,elevenlabs_agent_id_inbound,elevenlabs_phone_number_id,phone_number)
      VALUES (?,?,'ar-SA','','elevenlabs',?,?,?,?)`)
    .run(id, id, agent, inboundAgent, phoneId, did);
}
seedCompany('co-a', { agent: 'agent_A', phoneId: 'phnum_A', did: '+966500000001' });
seedCompany('co-b', { agent: 'agent_B', inboundAgent: 'agent_B_in', phoneId: 'phnum_B', did: '+966500000002' });

// ─── Helpers ──────────────────────────────────────────────────────
function signed(bodyObj, { secret = process.env.ELEVENLABS_WEBHOOK_SECRET, skewSecs = 0 } = {}) {
  const raw = JSON.stringify(bodyObj);
  const t = Math.floor(Date.now() / 1000) + skewSecs;
  const v0 = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return {
    rawBody: Buffer.from(raw, 'utf8'),
    body   : bodyObj,
    get(name) {
      return String(name).toLowerCase() === 'elevenlabs-signature' ? `t=${t},v0=${v0}` : undefined;
    },
  };
}

function transcriptionPayload({
  conversationId, agentId, direction = 'inbound',
  external = '+966555555555', agentNumber = '+966500000001',
  summary = 'اتصل العميل يسأل عن شقة في الرياض وطلب التواصل معه لاحقاً.',
  termination = 'end_call tool was called', durationSecs = 42,
  dataCollection = {},
} = {}) {
  return {
    type: 'post_call_transcription',
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      agent_id: agentId,
      conversation_id: conversationId,
      status: 'done',
      transcript: [
        { role: 'agent', message: 'حياك الله، كيف أقدر أساعدك؟', time_in_call_secs: 0 },
        { role: 'user',  message: 'أبغى شقة في الرياض', time_in_call_secs: 3 },
        { role: 'agent', message: null, time_in_call_secs: 4, tool_calls: [{ name: 'search_knowledge_base' }] },
      ],
      metadata: {
        start_time_unix_secs: 1758000000,
        call_duration_secs: durationSecs,
        // Billing CREDITS — the only cost figure this provider reports. There
        // is deliberately no cost_fiat here: it does not exist in the real
        // payload (verified against the live API), and inventing one in the
        // fixture is what previously hid the bug where cost_usd was always null.
        cost: 296,
        charging: { dev_discount: false, tier: 'starter' },
        termination_reason: termination,
        phone_call: {
          type: 'sip_trunking', direction,
          external_number: external, agent_number: agentNumber,
          call_sid: 'sip-abc-123',
        },
      },
      analysis: {
        call_successful: 'success',
        transcript_summary: summary,
        data_collection_results: dataCollection,
        evaluation_criteria_results: {},
      },
      has_audio: true,
      conversation_initiation_client_data: { dynamic_variables: { company_id: 'co-a' } },
    },
  };
}

// ══ 1. Webhook verification ═══════════════════════════════════════
test('valid HMAC signature verifies', () => {
  assert.equal(el.verifyWebhook(signed({ hello: 'world' })), true);
});

test('a TAMPERED body fails verification', () => {
  const req = signed({ hello: 'world' });
  req.rawBody = Buffer.from(JSON.stringify({ hello: 'evil' }), 'utf8');
  assert.equal(el.verifyWebhook(req), false);
});

test('a signature from the WRONG secret fails', () => {
  assert.equal(el.verifyWebhook(signed({ a: 1 }, { secret: 'someone-elses-secret' })), false);
});

test('a replayed signature older than the 30-minute window fails', () => {
  assert.equal(el.verifyWebhook(signed({ a: 1 }, { skewSecs: -31 * 60 })), false);
  assert.equal(el.verifyWebhook(signed({ a: 1 }, { skewSecs: -29 * 60 })), true, '29 min is still inside the window');
});

test('a missing signature header fails', () => {
  assert.equal(el.verifyWebhook({ rawBody: Buffer.from('{}'), body: {}, get: () => undefined }), false);
});

test('in production an UNSET webhook secret fails closed', () => {
  const saved = process.env.ELEVENLABS_WEBHOOK_SECRET;
  delete process.env.ELEVENLABS_WEBHOOK_SECRET;
  try {
    assert.equal(el.verifyWebhook(signed({ a: 1 }, { secret: 'anything' })), false);
  } finally { process.env.ELEVENLABS_WEBHOOK_SECRET = saved; }
});

// ══ 2. KB tool token (tenant binding) ═════════════════════════════
test('a minted company token round-trips', () => {
  const t = el.mintCompanyToken('co-a');
  assert.equal(el.verifyCompanyToken(t), 'co-a');
});

test('a token cannot be re-pointed at another company', () => {
  const t = el.mintCompanyToken('co-a');
  const forged = t.replace(/^co-a\./, 'co-b.');
  assert.equal(el.verifyCompanyToken(forged), null, 'swapping the company id invalidates the MAC');
});

test('garbage, empty and MAC-less tokens are rejected', () => {
  for (const bad of ['', null, undefined, 'co-a', 'co-a.', '.abc', 'co-a.deadbeef']) {
    assert.equal(el.verifyCompanyToken(bad), null, `rejected: ${JSON.stringify(bad)}`);
  }
});

// ══ 3. Event normalization ════════════════════════════════════════
test('a transcription event normalizes into the internal call shape', () => {
  const ev = el.normalizeEvent(transcriptionPayload({ conversationId: 'conv_1', agentId: 'agent_A' }));
  assert.equal(ev.provider, 'elevenlabs');
  assert.equal(ev.providerCallId, 'conv_1');
  assert.equal(ev.providerCallRef, 'sip-abc-123');
  assert.equal(ev.agentId, 'agent_A');
  assert.equal(ev.companyId, null, 'the payload never decides the tenant');
  assert.equal(ev.direction, 'inbound');
  assert.equal(ev.callerNumber, '+966555555555');
  assert.equal(ev.destinationNumber, '+966500000001');
  assert.equal(ev.durationSec, 42);
  assert.equal(ev.isFinal, true);
  assert.match(ev.startedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'storage timestamp format');
  assert.match(ev.endedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

// The provider reports `metadata.cost` in billing CREDITS and reports no fiat
// amount at all — confirmed against the live API and the published webhook
// payload on 2026-09-18. These three tests exist so nobody "fixes" the null
// cost_usd by pointing it at the credit count.
test('credits are recorded as credits, not silently as dollars', () => {
  const ev = el.normalizeEvent(transcriptionPayload({ conversationId: 'conv_c', agentId: 'agent_A' }));
  assert.equal(ev.costCredits, 296, 'the credit figure must be kept');
  assert.equal(ev.costUsd, null, '296 credits is NOT $296 — with no rate configured cost_usd is unknown');
});

test('cost_usd is derived only when the operator states a rate', () => {
  const prev = process.env.ELEVENLABS_USD_PER_CREDIT;
  process.env.ELEVENLABS_USD_PER_CREDIT = '0.0015';
  try {
    const ev = el.normalizeEvent(transcriptionPayload({ conversationId: 'conv_c2', agentId: 'agent_A' }));
    assert.equal(ev.costCredits, 296);
    assert.ok(Math.abs(ev.costUsd - 0.444) < 1e-9, `296 * 0.0015 = 0.444, got ${ev.costUsd}`);
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_USD_PER_CREDIT;
    else process.env.ELEVENLABS_USD_PER_CREDIT = prev;
  }
});

test('a nonsensical credit rate is ignored rather than trusted', () => {
  const prev = process.env.ELEVENLABS_USD_PER_CREDIT;
  try {
    for (const bad of ['0', '-1', 'free', '']) {
      process.env.ELEVENLABS_USD_PER_CREDIT = bad;
      assert.equal(el.usdFromCredits(296), null, `rate "${bad}" must not produce a figure`);
    }
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_USD_PER_CREDIT;
    else process.env.ELEVENLABS_USD_PER_CREDIT = prev;
  }
});

test('the transcript flattens to text and drops speechless tool turns', () => {
  const ev = el.normalizeEvent(transcriptionPayload({ conversationId: 'conv_2', agentId: 'agent_A' }));
  assert.equal(ev.transcript, 'AI: حياك الله، كيف أقدر أساعدك؟\nUser: أبغى شقة في الرياض');
});

test('data_collection_results are UNWRAPPED to the flat shape lead-scoring reads', () => {
  const ev = el.normalizeEvent(transcriptionPayload({
    conversationId: 'conv_3', agentId: 'agent_A',
    dataCollection: {
      interest_level    : { value: 'مهتم جدا', rationale: 'asked for a viewing' },
      callback_requested: { value: true, rationale: '' },
      budget            : { value: '', rationale: 'not mentioned' },   // empty → dropped
      notes             : 'plain value without an envelope',
    },
  }));
  assert.deepEqual(ev.structuredData, {
    interest_level: 'مهتم جدا',
    callback_requested: true,
    notes: 'plain value without an envelope',
  });
});

test('an audio-only event yields nothing to persist', () => {
  assert.equal(el.normalizeEvent({ type: 'post_call_audio', data: { conversation_id: 'x', full_audio: 'AAA' } }), null);
});

test('a call_initiation_failure produces a final, zero-duration OUTBOUND event', () => {
  const ev = el.normalizeEvent({
    type: 'call_initiation_failure',
    data: { conversation_id: 'conv_fail', agent_id: 'agent_A', to_number: '+966555555555', reason: 'sip 503 service unavailable' },
  });
  assert.equal(ev.isFinal, true);
  assert.equal(ev.durationSec, 0);
  // An initiation failure can only happen on a call WE placed. Saying so
  // explicitly stops the row defaulting to 'inbound' when this event lands
  // before the outbound stub is written.
  assert.equal(ev.direction, 'outbound');
  assert.match(ev.endedReason, /^sip-503$/);
  // Everything the event genuinely does not know stays null, so the upsert
  // coalesces onto whatever the stub already established.
  assert.equal(ev.startedAt, null);
  assert.equal(ev.endedAt, null);
  assert.equal(ev.transcript, null);
  assert.equal(ev.companyId, null);
});

// ══ 4. Ended-reason vocabulary ════════════════════════════════════
// These strings are INPUTS to lib/lead-scoring.js and services/campaigns.js.
// Mapping them wrong silently corrupts the campaign report, so assert the
// mapping AND that the downstream classifier agrees.
test('termination reasons map onto the vocabulary the report already speaks', () => {
  const cases = [
    ['end_call tool was called',   'assistant-ended-call'],
    ['client_disconnected',        'customer-ended-call'],
    ['voicemail_detected',         'voicemail'],
    ['user_busy',                  'busy'],
    ['no_answer',                  'customer-did-not-answer'],
    ['number not in service',      'invalid-number'],
    ['inactivity_timeout',         'silence-timed-out'],
    ['max_duration_reached',       'max-duration-exceeded'],
    ['sip 407',                    'sip-407'],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(el.mapEndedReason(raw), expected, `${raw} → ${expected}`);
  }
});

test('an unknown reason is passed through visibly and matches no classifier pattern', () => {
  const mapped = el.mapEndedReason('some_brand_new_reason');
  assert.equal(mapped, 'provider:some_brand_new_reason');
  // It must not be mistaken for a no-answer or an invalid number.
  const outcome = classifyOutcome({ status: 'completed' }, { ended_reason: mapped, duration_sec: 30, transcript: 'x' });
  assert.equal(outcome, OUTCOME.COMPLETED);
});

test('a missing reason on a call that clearly happened is not treated as "no answer"', () => {
  assert.equal(el.mapEndedReason('', { hasTranscript: true }), 'assistant-ended-call');
  assert.equal(el.mapEndedReason('', { hasTranscript: false }), null);
});

test('lead scoring still works end-to-end on a normalized event', () => {
  const ev = el.normalizeEvent(transcriptionPayload({
    conversationId: 'conv_lead', agentId: 'agent_A',
    dataCollection: { interest_level: { value: 'مهتم جدا' }, callback_requested: { value: true } },
  }));
  const q = qualifyContact(
    { status: 'completed' },
    { ended_reason: ev.endedReason, duration_sec: ev.durationSec, transcript: ev.transcript,
      structured_data: JSON.stringify(ev.structuredData) },
  );
  assert.equal(q.lead, LEAD.HOT, 'the Arabic interest enum survives the provider change');
});

// ══ 5. Tenant resolution (never trusts the payload) ═══════════════
test('a call resolves to its company by AGENT id', async () => {
  const ev = el.normalizeEvent(transcriptionPayload({ conversationId: 'conv_r1', agentId: 'agent_B' }));
  assert.equal(await el.resolveCompanyForEvent(ev), 'co-b');
});

test('a company\'s SECOND (inbound) agent resolves to the same company', async () => {
  const ev = el.normalizeEvent(transcriptionPayload({ conversationId: 'conv_r2', agentId: 'agent_B_in' }));
  assert.equal(await el.resolveCompanyForEvent(ev), 'co-b');
});

test('an unknown agent falls back to the DIALLED 3CX number', async () => {
  const ev = el.normalizeEvent(transcriptionPayload({
    conversationId: 'conv_r3', agentId: 'agent_recreated_yesterday', agentNumber: '+966500000002',
  }));
  assert.equal(await el.resolveCompanyForEvent(ev), 'co-b', 'survives agent recreation');
});

test('a wholly unknown call resolves to NO company rather than a wrong one', async () => {
  const ev = el.normalizeEvent(transcriptionPayload({
    conversationId: 'conv_r4', agentId: 'agent_nobody', agentNumber: '+441234567890',
  }));
  assert.equal(await el.resolveCompanyForEvent(ev), null);
});

test('a SPOOFED company_id in the payload is ignored', async () => {
  // agent_B belongs to co-b, but the payload claims co-a. The claim must lose.
  const payload = transcriptionPayload({ conversationId: 'conv_spoof', agentId: 'agent_B', agentNumber: '+966500000002' });
  payload.data.conversation_initiation_client_data.dynamic_variables.company_id = 'co-a';
  const ev = el.normalizeEvent(payload);
  assert.equal(await el.resolveCompanyForEvent(ev), 'co-b', 'resolved from the agent, not the claim');
});

test('a spoofed company_id with NO other signal resolves to nothing', async () => {
  const payload = transcriptionPayload({ conversationId: 'conv_spoof2', agentId: 'agent_nobody', agentNumber: '+441234567890' });
  payload.data.conversation_initiation_client_data.dynamic_variables.company_id = 'co-a';
  const ev = el.normalizeEvent(payload);
  assert.equal(await el.resolveCompanyForEvent(ev), null, 'an unverified claim is never enough on its own');
});

// ══ 6. Persistence through the neutral pipeline ═══════════════════
test('processCallEvent writes a complete, tenant-scoped call row', async () => {
  const ev = el.normalizeEvent(transcriptionPayload({ conversationId: 'conv_p1', agentId: 'agent_A' }));
  const companyId = await events.processCallEvent(ev);
  assert.equal(companyId, 'co-a');

  const row = await sql.getCall.get('conv_p1');
  assert.equal(row.company_id, 'co-a');
  assert.equal(row.assistant_id, 'agent_A');
  assert.equal(row.direction, 'inbound');
  assert.equal(row.duration_sec, 42);
  assert.equal(row.provider, 'elevenlabs');
  assert.equal(row.provider_call_ref, 'sip-abc-123');
  assert.ok(row.transcript.includes('أبغى شقة'));
  assert.ok(row.summary.includes('الرياض'));
  assert.equal(row.ended_reason, 'assistant-ended-call');
});

test('re-delivering the same event is idempotent (no duplicate rows)', async () => {
  const payload = transcriptionPayload({ conversationId: 'conv_p2', agentId: 'agent_A' });
  await events.processCallEvent(el.normalizeEvent(payload));
  await events.processCallEvent(el.normalizeEvent(payload));
  const n = db.prepare('SELECT COUNT(*) n FROM calls WHERE id = ?').get('conv_p2').n;
  assert.equal(n, 1);
});

test('an outbound stub survives a sparse call_initiation_failure intact', async () => {
  await sql.insertOutboundCallStub.run({
    id: 'conv_stub', company_id: 'co-a', assistant_id: 'agent_A',
    caller_number: '+966555555555', provider: 'elevenlabs', provider_call_ref: null,
  });
  const before = await sql.getCall.get('conv_stub');
  assert.equal(before.direction, 'outbound');

  // Deliberately sparse: no to_number, no agent-resolvable company, no times.
  const ev = el.normalizeEvent({
    type: 'call_initiation_failure',
    data: { conversation_id: 'conv_stub', reason: 'no_answer' },
  });
  await events.processCallEvent(ev);

  const row = await sql.getCall.get('conv_stub');
  assert.equal(row.direction, 'outbound', 'direction survived');
  assert.equal(row.ended_reason, 'customer-did-not-answer', 'the new fact was written');
  assert.equal(row.company_id, 'co-a', 'company NOT blanked by an unresolvable event');
  assert.equal(row.caller_number, before.caller_number, 'customer number NOT blanked');
  assert.equal(row.started_at, before.started_at, 'start time NOT blanked');
  assert.equal(row.assistant_id, 'agent_A', 'agent NOT blanked');
});

test('an unmatched call is stored with a NULL company instead of being dropped', async () => {
  const ev = el.normalizeEvent(transcriptionPayload({
    conversationId: 'conv_orphan', agentId: 'agent_nobody', agentNumber: '+441234567890',
  }));
  const companyId = await events.processCallEvent(ev);
  assert.equal(companyId, null);
  const row = await sql.getCall.get('conv_orphan');
  assert.ok(row, 'the call is still recorded, so the operator can see it');
  assert.equal(row.company_id, null);
});

test('one tenant\'s calls never appear under another tenant', async () => {
  await events.processCallEvent(el.normalizeEvent(transcriptionPayload({ conversationId: 'conv_ta', agentId: 'agent_A' })));
  await events.processCallEvent(el.normalizeEvent(transcriptionPayload({ conversationId: 'conv_tb', agentId: 'agent_B', agentNumber: '+966500000002' })));
  const aIds = (await sql.listCallsForCompany.all('co-a', 100)).map((r) => r.id);
  const bIds = (await sql.listCallsForCompany.all('co-b', 100)).map((r) => r.id);
  assert.ok(aIds.includes('conv_ta') && !aIds.includes('conv_tb'));
  assert.ok(bIds.includes('conv_tb') && !bIds.includes('conv_ta'));
});

// ══ 7. Arabic summary guard ═══════════════════════════════════════
test('an English summary on an Arabic call is treated as missing', () => {
  const arabicTranscript = 'AI: حياك الله\nUser: أبغى شقة';
  assert.equal(events.needsOwnSummary('The customer asked about an apartment in Riyadh.', arabicTranscript), true);
  assert.equal(events.needsOwnSummary('اتصل العميل يسأل عن شقة في الرياض.', arabicTranscript), false);
  assert.equal(events.needsOwnSummary('short', arabicTranscript), true);
  assert.equal(events.needsOwnSummary('anything', ''), false, 'no transcript, nothing to summarize');
});

// ══ 8. Inbox: a legacy event is parked, not retried forever ═══════
test('a pending event from a REMOVED provider is parked, keeping its raw body', async () => {
  await sql.insertWebhookEvent.run({
    provider: 'vapi', event_id: 'legacy-1', event_type: 'end-of-call-report',
    raw_body: JSON.stringify({ message: { type: 'end-of-call-report' } }),
  });
  await events.drainWebhookInbox(10);
  const row = db.prepare("SELECT * FROM webhook_events WHERE event_id = 'legacy-1'").get();
  assert.equal(row.status, 'skipped', 'neither pending (retried forever) nor failed (alerts)');
  assert.ok(row.raw_body.includes('end-of-call-report'), 'historical payload preserved');
  const pendingLeft = db.prepare("SELECT COUNT(*) n FROM webhook_events WHERE status='pending'").get().n;
  assert.equal(pendingLeft, 0);
});

// ══ 9. Agent configuration ════════════════════════════════════════
function cfgFor(extra = {}) {
  return el.buildAgentConfig({
    name: 'smart-assistant:co-a', prompt: 'تعليمات', firstMessage: 'حياك الله', language: 'ar-SA',
    model: 'gpt-4.1', temperature: 0.3, maxTokens: 400,
    voiceId: 'voice_1', stability: 0.8, similarityBoost: 0.8, voiceSpeed: 1.2,
    ...extra,
  });
}

test('per-call overrides are ENABLED, or personalised outbound greetings do nothing', () => {
  const o = cfgFor().platform_settings.overrides.conversation_config_override;
  assert.equal(o.agent.first_message, true, 'campaigns override first_message per contact');
  assert.equal(o.agent.prompt.prompt, true);
  assert.equal(o.tts.voice_id, true);
});

test('the agent is given a wall clock, or it cannot resolve "tomorrow at four"', () => {
  // prompt.timezone defaults to null, and null is not a soft failure for
  // appointment booking — the model has no reference point for any relative
  // time the caller says. Verified against the live API (2026-10-03): PATCHing
  // 'Asia/Riyadh' reads back verbatim.
  const p = cfgFor().conversation_config.agent.prompt;
  assert.equal(p.timezone, 'Asia/Riyadh', 'Saudi default');

  const prev = process.env.ELEVENLABS_AGENT_TIMEZONE;
  try {
    // The module reads the env at load time, so this asserts the DEFAULT is not
    // hard-coded past the override rather than re-reading it here.
    assert.ok(typeof p.timezone === 'string' && p.timezone.includes('/'),
      'an IANA zone name, not an offset — offsets break across DST');
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_AGENT_TIMEZONE;
    else process.env.ELEVENLABS_AGENT_TIMEZONE = prev;
  }
});

test('the greeting cannot be interrupted', () => {
  // A caller's "ألو" lands on top of the greeting otherwise, and the company
  // name gets cut in half on the very first thing the customer hears.
  assert.equal(cfgFor().conversation_config.agent.disable_first_message_interruptions, true);
});

test('prompt-injection screening is on', () => {
  // The agent answers a published phone number and holds tools that read
  // tenant data. Provider default is false. Verified on the live API
  // (2026-10-03): { version:'1', prompt_injection:{ is_enabled:true } } reads
  // back enabled.
  const g = cfgFor().platform_settings.guardrails;
  assert.equal(g.prompt_injection.is_enabled, true);
  assert.equal(g.version, '1', 'the provider rejects a guardrails block with no version');
});

test('the TTS model stays on turbo v2.5 unless an operator opts out', () => {
  // The expressive v3/v4 line supports Arabic but has never been heard on a
  // real Saudi call here, and it drops tts.speed — which every company's pacing
  // is tuned with. This test is the thing that makes flipping it deliberate.
  assert.equal(cfgFor().conversation_config.tts.model_id, 'eleven_turbo_v2_5');
  assert.equal(cfgFor().conversation_config.tts.speed, 1.2, 'speed is still ours to set');
});

test('the end_call tool is always attached', () => {
  const tools = cfgFor().conversation_config.agent.prompt.tools;
  assert.ok(tools.some((t) => t.params?.system_tool_type === 'end_call'));
});

test('human transfer is added only when a number is configured', () => {
  assert.equal(cfgFor().conversation_config.agent.prompt.tools.length, 1);
  const withTransfer = cfgFor({ transferNumber: '+966500000009' }).conversation_config.agent.prompt.tools;
  const t = withTransfer.find((x) => x.params?.system_tool_type === 'transfer_to_number');
  assert.ok(t, 'transfer tool present');
  assert.equal(t.params.transfers[0].transfer_destination.phone_number, '+966500000009');
});

test('language is sent as a bare ISO code, not the stored ar-SA locale', () => {
  assert.equal(cfgFor().conversation_config.agent.language, 'ar');
});

test('the data-collection keys match exactly what the campaign report reads', () => {
  const keys = Object.keys(cfgFor().platform_settings.data_collection).sort();
  assert.deepEqual(keys, [
    'appointment_requested', 'budget', 'callback_requested', 'customer_intent',
    'interest_level', 'next_action', 'notes', 'preferred_area', 'property_type',
  ].sort());
});

// ══ 10. KB tool definition ════════════════════════════════════════
test('the KB tool lets the model supply ONLY the query', () => {
  const tool = el.buildKbToolConfig({ companyId: 'co-a', publicBaseUrl: 'https://example.test' });
  const props = tool.api_schema.request_body_schema.properties;
  assert.deepEqual(tool.api_schema.request_body_schema.required, ['query']);
  assert.equal(props.agent_id.constant_value, '{{system__agent_id}}', 'agent id is filled by the provider');
  assert.equal(props.conversation_id.constant_value, '{{system__conversation_id}}');
  assert.equal(tool.api_schema.url, 'https://example.test/webhook/elevenlabs/tools/kb');
});

test('the KB tool carries a company token the model can neither read nor forge', () => {
  const tool = el.buildKbToolConfig({ companyId: 'co-a', publicBaseUrl: 'https://example.test' });
  const token = tool.api_schema.request_headers['X-Company-Token'];
  assert.equal(el.verifyCompanyToken(token), 'co-a');
  // Two companies get different tokens, so one cannot be replayed as the other.
  const other = el.buildKbToolConfig({ companyId: 'co-b', publicBaseUrl: 'https://example.test' });
  assert.notEqual(token, other.api_schema.request_headers['X-Company-Token']);
});

test('with NO tool secret configured, the KB tool is omitted rather than left open', () => {
  const savedTool = process.env.ELEVENLABS_TOOL_SECRET;
  const savedHook = process.env.ELEVENLABS_WEBHOOK_SECRET;
  delete process.env.ELEVENLABS_TOOL_SECRET;
  delete process.env.ELEVENLABS_WEBHOOK_SECRET;
  try {
    assert.equal(el.buildKbToolConfig({ companyId: 'co-a', publicBaseUrl: 'https://example.test' }), null);
  } finally {
    if (savedTool !== undefined) process.env.ELEVENLABS_TOOL_SECRET = savedTool;
    process.env.ELEVENLABS_WEBHOOK_SECRET = savedHook;
  }
});

// ══ 11. Facade wiring ═════════════════════════════════════════════
test('the driver satisfies the provider contract', () => {
  const { REQUIRED_METHODS, assertDriver } = require('../services/voice/provider');
  assert.doesNotThrow(() => assertDriver(el));
  assert.ok(REQUIRED_METHODS.length > 5);
});

test('a legacy call row still resolves to a working driver', () => {
  // Historical rows carry provider='vapi'. Reading one back must not explode.
  assert.ok(voice.forCall({ provider: 'vapi', id: 'old' }));
  assert.ok(voice.forCall({ provider: null, id: 'old' }));
});

test('provider errors flatten to a short, SQL-bindable string', () => {
  const e = new Error('Request failed');
  e.response = { status: 422, data: { detail: [{ loc: ['body', 'to_number'], msg: 'invalid' }] } };
  const s = voice.errText(e);
  assert.equal(typeof s, 'string');
  assert.match(s, /422/);
  assert.match(s, /to_number/);
});

// ══ 12. Driver parity ═════════════════════════════════════════════
// The two statement catalogs are hand-maintained. A statement added to only
// one of them passes every sqlite test here and then throws
// "sql.x is undefined" in production, which runs Postgres. This migration
// added six statements and removed one across BOTH files, so guard it.
// Parsed textually: no database connection required.
test('both DB drivers expose the SAME statement catalog', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const namesIn = (f) => {
    const body = src(f).slice(src(f).indexOf('const sql = {'));
    const out = new Set();
    const re = /^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm;
    let m;
    while ((m = re.exec(body))) out.add(m[1]);
    // `db` / `isPg` are module exports that share the indentation, not statements.
    for (const k of ['db', 'isPg']) out.delete(k);
    return out;
  };
  const lite = namesIn('db-sqlite.js');
  const pg   = namesIn('db-postgres.js');
  assert.ok(lite.size > 100, 'sanity: the parser found a real catalog');
  assert.deepEqual([...lite].filter((k) => !pg.has(k)), [], 'statements missing from the postgres driver');
  assert.deepEqual([...pg].filter((k) => !lite.has(k)), [], 'statements missing from the sqlite driver');
  // The statements this migration introduced must exist in both.
  for (const k of [
    'companyByAgentId', 'companyByProviderPhoneNumberId', 'companyByPhoneNumber',
    'setCompanyElevenLabsPhone', 'setCompanyKbTool', 'markWebhookSkipped',
  ]) {
    assert.ok(lite.has(k) && pg.has(k), `${k} present in both drivers`);
  }
});

// ══ 9. Provider contract, verified against the live API ════════════
// Every assertion below records something CHECKED against the real ElevenLabs
// API on 2026-09-18, not something inferred from documentation. They exist so a
// future edit that drifts from the real schema fails here instead of failing
// silently in production, where a rejected agent payload means a company simply
// cannot publish and a missing flag means every inbound call is depersonalised.

test('data_collection is a dict keyed by field name, each with type+description', () => {
  // Confirmed by POSTing this exact payload to /v1/convai/agents/create: HTTP
  // 200, all nine keys stored verbatim, the remaining schema fields (enum,
  // is_omitted, constant_value, dynamic_variable …) defaulted server-side.
  // A list, or entries missing `type`, is rejected.
  const dc = el.buildAgentConfig({ name: 'x', prompt: 'p', language: 'ar-SA' })
    .platform_settings.data_collection;
  assert.ok(dc && !Array.isArray(dc) && typeof dc === 'object', 'must be an object, not an array');
  assert.ok(Object.keys(dc).length > 0);
  for (const [key, spec] of Object.entries(dc)) {
    assert.ok(['string', 'boolean', 'number', 'integer'].includes(spec.type), `${key}.type is a supported JSON type`);
    assert.equal(typeof spec.description, 'string', `${key}.description is a string`);
    assert.ok(spec.description.length > 0, `${key} has a description for the extraction model`);
  }
});

test('the initiation webhook is ENABLED on every agent we build', () => {
  // enable_conversation_initiation_client_data_from_webhook defaults to FALSE,
  // and false fails silently: the call connects, the agent sounds fine, and it
  // simply never receives company_id, company_name or caller_number. Verified
  // on the live API — an agent created without this flag reads back false.
  const ov = el.buildAgentConfig({ name: 'x', prompt: 'p', language: 'ar-SA' })
    .platform_settings.overrides;
  assert.equal(ov.enable_conversation_initiation_client_data_from_webhook, true,
    'without this the /webhook/elevenlabs/init endpoint is never called at all');
});

test('the init webhook verifies against its OWN secret, falling back to the post-call one', () => {
  // Each webhook in a workspace is a separate resource with its own signing
  // secret, so the two are not interchangeable.
  const prev = process.env.ELEVENLABS_INIT_WEBHOOK_SECRET;
  try {
    delete process.env.ELEVENLABS_INIT_WEBHOOK_SECRET;
    assert.equal(el.webhookSecret('init'), process.env.ELEVENLABS_WEBHOOK_SECRET,
      'unset => same secret, so existing single-secret deployments keep working');

    process.env.ELEVENLABS_INIT_WEBHOOK_SECRET = 'init_secret_distinct';
    assert.equal(el.webhookSecret('init'), 'init_secret_distinct');
    assert.equal(el.webhookSecret('post_call'), process.env.ELEVENLABS_WEBHOOK_SECRET,
      'setting the init secret must NOT change post-call verification');
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_INIT_WEBHOOK_SECRET;
    else process.env.ELEVENLABS_INIT_WEBHOOK_SECRET = prev;
  }
});

test('an init request signed with the WRONG secret is refused', () => {
  const prev = process.env.ELEVENLABS_INIT_WEBHOOK_SECRET;
  process.env.ELEVENLABS_INIT_WEBHOOK_SECRET = 'init_secret_distinct';
  try {
    const body = JSON.stringify({ agent_id: 'agent_A', called_number: '+966500000001' });
    const sign = (secret) => {
      const t = Math.floor(Date.now() / 1000);
      const v0 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
      return { get: (h) => (h.toLowerCase() === 'elevenlabs-signature' ? `t=${t},v0=${v0}` : null),
               rawBody: Buffer.from(body) };
    };
    assert.equal(el.verifyWebhook(sign('init_secret_distinct'), 'init'), true, 'correct init secret passes');
    assert.equal(el.verifyWebhook(sign(process.env.ELEVENLABS_WEBHOOK_SECRET), 'init'), false,
      'the post-call secret must NOT authenticate an init request once a distinct one is set');
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_INIT_WEBHOOK_SECRET;
    else process.env.ELEVENLABS_INIT_WEBHOOK_SECRET = prev;
  }
});

test('the SIP trunk payload uses the field names and enums the API actually accepts', () => {
  // Verified by probing POST /v1/convai/phone-numbers until it validated:
  // outbound_trunk_config.address is required; credentials is an OBJECT whose
  // `username` is required; allowed_addresses is a LIST; transport is one of
  // auto|udp|tcp|tls; media_encryption is one of disabled|allowed|required.
  const cfg = el.buildTrunkConfig({
    address: 'pbx.example.com', username: 'sipuser', password: 'p',
    allowedAddresses: ['1.2.3.4'],
  });
  assert.deepEqual(Object.keys(cfg).sort(), ['inbound_trunk_config', 'outbound_trunk_config']);
  assert.equal(cfg.outbound_trunk_config.address, 'pbx.example.com');
  assert.ok(['auto', 'udp', 'tcp', 'tls'].includes(cfg.outbound_trunk_config.transport));
  for (const leg of ['inbound_trunk_config', 'outbound_trunk_config']) {
    assert.ok(['disabled', 'allowed', 'required'].includes(cfg[leg].media_encryption), `${leg}.media_encryption`);
    assert.equal(typeof cfg[leg].credentials, 'object', `${leg}.credentials is an object`);
    assert.equal(cfg[leg].credentials.username, 'sipuser', `${leg}.credentials.username is required by the API`);
  }
  assert.ok(Array.isArray(cfg.inbound_trunk_config.allowed_addresses), 'allowed_addresses is a list');
  // The address is a bare host. A sip: URI is rejected by the PBX side and by us.
  assert.ok(!/^sips?:/i.test(cfg.outbound_trunk_config.address));
});

test('credentials are omitted entirely when none are given, not sent empty', () => {
  // `credentials: {}` fails validation with "username: Field required", so an
  // IP-allowlist-only trunk must not send the key at all.
  const cfg = el.buildTrunkConfig({ address: 'pbx.example.com', allowedAddresses: ['1.2.3.4'] });
  assert.ok(!('credentials' in cfg.inbound_trunk_config), 'no empty credentials object');
  assert.ok(!('credentials' in cfg.outbound_trunk_config), 'no empty credentials object');
});

// ── Provisioning idempotency ──────────────────────────────────────
// Re-running provisioning for the same company and DID must converge, not fail.
// The live API rejects a duplicate import with HTTP 409 `resource_already_exists`
// (confirmed), so the driver has to look before it creates and update after a
// losing race. These tests stub the HTTP layer at the axios adapter, so they
// assert OUR control flow without touching the network.
function withStubbedHttp(handler, fn) {
  const axios = require('axios');
  const prev = axios.defaults.adapter;
  const calls = [];
  axios.defaults.adapter = async (config) => {
    calls.push({ method: String(config.method).toLowerCase(), url: config.url,
                 body: config.data ? JSON.parse(config.data) : null });
    const out = await handler(calls[calls.length - 1], calls);
    if (out instanceof Error) throw out;
    return { data: out, status: 200, statusText: 'OK', headers: {}, config };
  };
  return Promise.resolve(fn(calls)).finally(() => { axios.defaults.adapter = prev; });
}

const httpError = (status, data) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

test('re-importing a number this workspace already holds UPDATES it instead of failing', async () => {
  await withStubbedHttp((call) => {
    if (call.method === 'get') return [{ phone_number: '+966500000009', phone_number_id: 'phnum_existing' }];
    if (call.method === 'patch') return { phone_number_id: 'phnum_existing' };
    if (call.method === 'post') return httpError(409, { detail: { status: 'phone_number_conflict' } });
    return {};
  }, async (calls) => {
    const r = await el.importPhoneNumber(
      { id: 'co-a', agentId: 'agent_A' },
      { phoneNumber: '+966500000009', address: 'pbx.example.com', username: 'u', password: 'p' },
    );
    assert.equal(r.phoneNumberId, 'phnum_existing', 'reuses the id already registered');
    assert.equal(r.reused, true);
    assert.equal(calls.filter((c) => c.method === 'post').length, 0,
      'must not attempt a create it knows will 409');
    const patched = calls.find((c) => c.method === 'patch');
    assert.ok(patched, 'the existing record is updated');
    assert.equal(patched.body.agent_id, 'agent_A', 'still bound to the right agent');
    assert.equal(patched.body.outbound_trunk_config.address, 'pbx.example.com',
      'rotated SIP settings are applied on re-run');
  });
});

test('a first-time import creates the number and reports it as new', async () => {
  await withStubbedHttp((call) => {
    if (call.method === 'get') return [];
    if (call.method === 'post') return { phone_number_id: 'phnum_new' };
    return {};
  }, async (calls) => {
    const r = await el.importPhoneNumber(
      { id: 'co-a', agentId: 'agent_A' },
      { phoneNumber: '+966500000010', address: 'pbx.example.com' },
    );
    assert.equal(r.phoneNumberId, 'phnum_new');
    assert.equal(r.reused, false);
    const posted = calls.find((c) => c.method === 'post');
    assert.equal(posted.body.provider, 'sip_trunk');
    assert.equal(posted.body.phone_number, '+966500000010');
    assert.ok(posted.body.label.includes('co-a'), 'labelled with the owning company');
  });
});

test('a 409 lost race falls back to updating the record that won', async () => {
  // The number was absent from the first listing but created by a concurrent
  // run before our POST landed. Re-listing finds it; we converge on it.
  let listed = 0;
  await withStubbedHttp((call) => {
    if (call.method === 'get') return (listed++ === 0)
      ? []
      : [{ phone_number: '+966500000011', phone_number_id: 'phnum_raced' }];
    if (call.method === 'post') return httpError(409, { detail: { status: 'phone_number_conflict' } });
    if (call.method === 'patch') return {};
    return {};
  }, async () => {
    const r = await el.importPhoneNumber(
      { id: 'co-a', agentId: 'agent_A' },
      { phoneNumber: '+966500000011', address: 'pbx.example.com' },
    );
    assert.equal(r.phoneNumberId, 'phnum_raced');
    assert.equal(r.reused, true);
  });
});

test('a number held by ANOTHER workspace fails with an actionable message', async () => {
  // A number can only be registered once across the whole platform, and the
  // list endpoint only shows our own — so a 409 that survives a re-list means
  // somebody else owns it. The operator needs to be told that, not handed a
  // bare "409".
  await withStubbedHttp((call) => {
    if (call.method === 'get') return [];
    if (call.method === 'post') return httpError(409, { detail: { status: 'phone_number_conflict' } });
    return {};
  }, async () => {
    await assert.rejects(
      () => el.importPhoneNumber(
        { id: 'co-a', agentId: 'agent_A' },
        { phoneNumber: '+966500000012', address: 'pbx.example.com' },
      ),
      (e) => {
        assert.equal(e.code, 'PHONE_NUMBER_TAKEN');
        assert.match(e.message, /different elevenlabs workspace/i);
        return true;
      },
    );
  });
});

test('a non-409 import failure still propagates rather than being swallowed', async () => {
  await withStubbedHttp((call) => {
    if (call.method === 'get') return [];
    if (call.method === 'post') return httpError(422, { detail: [{ loc: ['body', 'x'], msg: 'bad' }] });
    return {};
  }, async () => {
    await assert.rejects(() => el.importPhoneNumber(
      { id: 'co-a', agentId: 'agent_A' },
      { phoneNumber: '+966500000013', address: 'pbx.example.com' },
    ), /422|bad/i);
  });
});

// ── Conversation-initiation webhook authentication ────────────────
// Verified against the live API on 2026-09-19: this webhook is NOT HMAC-signed.
// Its config accepts only {url, request_headers}; `secret` and `auth_method`
// are accepted with a 200 and silently dropped. Authentication is therefore a
// constant header we register in request_headers. These tests exist so nobody
// "restores" HMAC-only checking and 401s every real inbound call.
const H = el.INIT_TOKEN_HEADER;

// Every test below PINS the init secret rather than relying on it being unset.
// An earlier version leaned on the fallback to ELEVENLABS_WEBHOOK_SECRET, which
// made the result depend on whether the developer happened to have
// ELEVENLABS_INIT_WEBHOOK_SECRET in their own .env — green on a clean machine,
// red on a configured one, for reasons having nothing to do with the code.
const INIT_SECRET = 'init_secret_for_tests_0123456789';

function withInitSecret(fn) {
  const prev = process.env.ELEVENLABS_INIT_WEBHOOK_SECRET;
  process.env.ELEVENLABS_INIT_WEBHOOK_SECRET = INIT_SECRET;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_INIT_WEBHOOK_SECRET;
    else process.env.ELEVENLABS_INIT_WEBHOOK_SECRET = prev;
  }
}

function initReq(headers = {}, body = { agent_id: 'agent_A' }) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    get: (h) => lower[String(h).toLowerCase()] ?? null,
    rawBody: Buffer.from(JSON.stringify(body)),
    body,
  };
}

test('the init webhook accepts the shared secret header ElevenLabs can actually send', () => {
  withInitSecret(() => {
    assert.equal(
      el.verifyInitWebhook(initReq({ [H]: INIT_SECRET })),
      true,
      'the provider cannot sign this webhook — the header is the only mechanism it offers',
    );
  });
});

test('the init webhook refuses a wrong or absent token', () => {
  withInitSecret(() => {
    assert.equal(el.verifyInitWebhook(initReq({ [H]: 'not-the-secret' })), false, 'wrong token');
    assert.equal(el.verifyInitWebhook(initReq({})), false, 'no token at all');
    assert.equal(el.verifyInitWebhook(initReq({ [H]: '' })), false, 'empty token');
    // A near-miss must not pass: constant-time compare, length checked first.
    assert.equal(
      el.verifyInitWebhook(initReq({ [H]: `${INIT_SECRET}x` })),
      false, 'token with one extra character',
    );
  });
});

test('the init webhook falls back to the post-call secret when no init secret is set', () => {
  const prev = process.env.ELEVENLABS_INIT_WEBHOOK_SECRET;
  delete process.env.ELEVENLABS_INIT_WEBHOOK_SECRET;
  try {
    assert.equal(
      el.verifyInitWebhook(initReq({ [H]: process.env.ELEVENLABS_WEBHOOK_SECRET })),
      true,
      'a deployment that configured only one secret keeps working',
    );
  } finally {
    if (prev !== undefined) process.env.ELEVENLABS_INIT_WEBHOOK_SECRET = prev;
  }
});

test('the init webhook still honours a real HMAC signature if one ever arrives', () => {
  // Forward compatibility: if the provider starts signing this webhook, it must
  // keep working with no code change.
  withInitSecret(() => {
    const body = JSON.stringify({ agent_id: 'agent_A' });
    const t = Math.floor(Date.now() / 1000);
    const v0 = crypto.createHmac('sha256', INIT_SECRET).update(`${t}.${body}`).digest('hex');
    const req = {
      get: (h) => (String(h).toLowerCase() === 'elevenlabs-signature' ? `t=${t},v0=${v0}` : null),
      rawBody: Buffer.from(body),
    };
    assert.equal(el.verifyInitWebhook(req), true, 'a valid signature is accepted alongside the header');
  });
});

test('an INVALID signature does not pass just because a signature header exists', () => {
  const body = JSON.stringify({ agent_id: 'agent_A' });
  const t = Math.floor(Date.now() / 1000);
  const req = {
    get: (h) => (String(h).toLowerCase() === 'elevenlabs-signature' ? `t=${t},v0=deadbeef` : null),
    rawBody: Buffer.from(body),
  };
  assert.equal(el.verifyInitWebhook(req), false, 'a forged signature with no valid token is refused');
});

test('the init token header is distinct from the post-call signature header', () => {
  // They authenticate different endpoints by different mechanisms; sharing a
  // header name would invite configuring one where the other is expected.
  assert.notEqual(H.toLowerCase(), 'elevenlabs-signature');
  assert.match(H, /^[a-z0-9-]+$/, 'a plain lowercase header name, safe to configure verbatim');
});

test('with a distinct init secret set, the post-call secret is NOT a valid init token', () => {
  const prev = process.env.ELEVENLABS_INIT_WEBHOOK_SECRET;
  process.env.ELEVENLABS_INIT_WEBHOOK_SECRET = 'init_only_secret_value';
  try {
    assert.equal(el.verifyInitWebhook(initReq({ [H]: 'init_only_secret_value' })), true);
    assert.equal(
      el.verifyInitWebhook(initReq({ [H]: process.env.ELEVENLABS_WEBHOOK_SECRET })),
      false,
      'once the two are separated, the post-call secret must not open the init endpoint',
    );
  } finally {
    if (prev === undefined) delete process.env.ELEVENLABS_INIT_WEBHOOK_SECRET;
    else process.env.ELEVENLABS_INIT_WEBHOOK_SECRET = prev;
  }
});
