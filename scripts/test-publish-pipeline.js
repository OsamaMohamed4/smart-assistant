// Regression suite for the "Publish Company" pipeline (Phase A).
//
// Driver-agnostic — it touches the database only through the shared statement
// catalog, so the identical assertions run on both engines:
//
//   npm run test:unit                       (SQLite — included by default)
//   DB_DRIVER=postgres DATABASE_URL=… npm run test:pg:publish
//
// The defect that motivated this file: publishing persisted provider ids only
// AFTER the whole provider call returned. A failure in the agent PATCH
// therefore discarded a knowledge-base tool that had really been created, and
// the next publish — seeing no stored id — created a SECOND one. Repeating
// that for every retry leaves a workspace full of orphaned tools.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const IS_PG = (process.env.DB_DRIVER || '').toLowerCase() === 'postgres';
const TMP_DB = path.join(require('node:os').tmpdir(), `sa-publish-${Date.now()}.db`);
if (!IS_PG) {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DB_PATH = TMP_DB;
}
process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'k';
process.env.ELEVENLABS_WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET || 'wsec_test_secret_value';
process.env.ELEVENLABS_TOOL_SECRET = process.env.ELEVENLABS_TOOL_SECRET || 'tool_secret_for_publish_tests';

const { sql, all: dataAll, run: dataRun, initDb, close: dbClose } = require('../db');
const { publishCompany, STEP } = require('../services/publish/pipeline');

const RUN = Date.now().toString(36);
const cid = (n) => `co-pub-${n}-${RUN}`;

async function makeCompany(name, extra = {}) {
  const id = cid(name);
  await dataRun(
    `INSERT INTO companies (id, name, language, system_prompt, voice_provider,
       elevenlabs_agent_id, elevenlabs_kb_tool_id, elevenlabs_phone_number_id)
     VALUES (?, ?, 'ar-SA', '', 'elevenlabs', ?, ?, ?)`,
    [id, name, extra.agentId || null, extra.toolId || null, extra.phoneNumberId || null],
  );
  if (extra.scenario !== false) {
    await dataRun(
      `INSERT INTO scenarios (company_id, name, instruction_prompt, first_message, is_active, language)
       VALUES (?, 'sc', ?, 'مرحبا', 1, 'ar')`,
      [id, extra.prompt || 'أنت مساعد عقاري.'],
    );
  }
  return id;
}

function companyObj(id, over = {}) {
  return {
    id, name: 'شركة اختبار', language: 'ar-SA', settings: {},
    agentId: null, agentIdInbound: null, kbToolId: null, phoneNumberId: null,
    ...over,
  };
}

// Minimal deps: the pipeline takes its server.js collaborators by injection
// precisely so it can be exercised without booting the HTTP layer.
const DEPS = {
  composeSystemPrompt: async (_c, p) => `${p}\n[kb]`,
  shapeScenario: (row) => ({
    id: row.id, name: row.name,
    instructionPrompt: row.instruction_prompt,
    instructionPromptInbound: row.instruction_prompt_inbound || '',
    firstMessage: row.first_message || '',
    firstMessageInbound: row.first_message_inbound || '',
  }),
  resolveAgentModel: () => ({ model: 'gpt-4.1', temperature: 0.3, maxTokens: 800 }),
  isAllowedVoiceId: () => true,
  defaultVoiceId: 'voice_test',
  voiceSpeedDefault: 1.0,
  publicBaseUrl: 'https://example.test',
};

// ── Provider stub ─────────────────────────────────────────────────
// Replaces the voice facade's methods for the duration of one test. Using the
// real module (rather than a hand-rolled fake passed in) keeps the hook
// contract under test: if syncAgent stops calling the hooks, these fail.
const voice = require('../services/voice');
function stubVoice({ syncAgent, getAgent, getWorkspaceSettings, bindPhoneNumber }) {
  const orig = {
    syncAgent: voice.syncAgent,
    getAgent: voice.getAgent,
    getWorkspaceSettings: voice.getWorkspaceSettings,
    bindPhoneNumber: voice.bindPhoneNumber,
  };
  voice.syncAgent = syncAgent || orig.syncAgent;
  voice.getAgent = getAgent || (async () => healthyAgent());
  voice.getWorkspaceSettings = getWorkspaceSettings
    || (async () => ({
      webhooks: { post_call_webhook_id: 'wh_1' },
      conversation_initiation_client_data_webhook: { url: 'https://example.test/init' },
    }));
  voice.bindPhoneNumber = bindPhoneNumber
    || (async (c) => ({ phoneNumberId: c.phoneNumberId, agentId: c.agentId, phoneNumber: '+966500000000' }));
  return () => Object.assign(voice, orig);
}

const healthyAgent = (toolIds = []) => ({
  platform_settings: {
    overrides: { enable_conversation_initiation_client_data_from_webhook: true },
    data_collection: { interest_level: { type: 'string', description: 'x' } },
  },
  conversation_config: { agent: { language: 'ar', prompt: { tool_ids: toolIds } } },
});

const stepOf = (r, key) => r.steps.find((s) => s.key === key);

before(async () => { await initDb(); });

after(async () => {
  // Leave a shared Postgres database as we found it.
  try {
    await dataRun('DELETE FROM company_publish_runs WHERE company_id LIKE ?', [`%-${RUN}`]);
    await dataRun('DELETE FROM kb_chunks WHERE company_id LIKE ?', [`%-${RUN}`]);
    await dataRun('DELETE FROM kb_documents WHERE company_id LIKE ?', [`%-${RUN}`]);
    await dataRun('DELETE FROM scenarios WHERE company_id LIKE ?', [`%-${RUN}`]);
    await dataRun('DELETE FROM companies WHERE id LIKE ?', [`%-${RUN}`]);
  } catch { /* best effort */ }
  try { await dbClose?.(); } catch {}
  if (!IS_PG) for (const s of ['', '-wal', '-shm']) fs.rmSync(TMP_DB + s, { force: true });
});

// ══════════════════════════════════════════════════════════════════
// A clean publish
// ══════════════════════════════════════════════════════════════════
test('a healthy publish marks the company published and records every step', async () => {
  const id = await makeCompany('ok');
  const restore = stubVoice({
    syncAgent: async (_c, opts) => {
      await opts.hooks.onAgentSynced('agent_ok');
      return { agentId: 'agent_ok', agentIdInbound: null, toolId: null };
    },
  });
  try {
    const r = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(r.status, 'published', r.error || '');
    assert.equal(r.published, true);
    assert.equal(r.httpStatus, 200);
    assert.equal(r.agentId, 'agent_ok');

    for (const k of [STEP.VALIDATE_COMPANY, STEP.VALIDATE_SCENARIO, STEP.PROMPT_COMPOSE,
      STEP.AGENT_UPSERT, STEP.PROVIDER_SYNC, STEP.VERIFY_READBACK]) {
      assert.equal(stepOf(r, k)?.status, 'ok', `${k} should be ok`);
    }
    // Timings are what make a slow publish diagnosable.
    assert.ok(r.steps.every((s) => Number.isFinite(s.ms)), 'every step carries a duration');

    const row = await sql.getCompany.get(id);
    assert.equal(row.publish_status, 'published');
    assert.ok(row.published_at, 'published_at stamped');
    assert.equal(row.elevenlabs_agent_id, 'agent_ok', 'agent id persisted');
  } finally { restore(); }
});

test('the publish run is recorded with its per-step results', async () => {
  const id = await makeCompany('run');
  const restore = stubVoice({
    syncAgent: async (_c, opts) => {
      await opts.hooks.onAgentSynced('agent_run');
      return { agentId: 'agent_run' };
    },
  });
  try {
    const r = await publishCompany({ company: companyObj(id), deps: DEPS, actorEmail: 'a@b.c' });
    const run = await sql.getLastPublishRun.get(id);
    assert.ok(run, 'a run row exists');
    assert.equal(run.status, 'published');
    assert.equal(run.actor_email, 'a@b.c');
    assert.equal(run.agent_id, 'agent_run');
    assert.ok(run.finished_at, 'run was closed');
    const steps = JSON.parse(run.steps);
    assert.equal(steps.length, r.steps.length, 'stored steps match the response');
  } finally { restore(); }
});

// ══════════════════════════════════════════════════════════════════
// The duplicate-tool defect
// ══════════════════════════════════════════════════════════════════
test('a tool created before a later failure is PERSISTED, not lost', async () => {
  // This is the regression. The tool exists at the provider; the agent call
  // then explodes. The id must already be in the database.
  const id = await makeCompany('toolkeep');
  await dataRun(
    `INSERT INTO kb_documents (company_id, filename, raw_text) VALUES (?, 'f.md', 'نص')`, [id],
  );
  await dataRun(
    `INSERT INTO kb_chunks (company_id, document_id, chunk_index, text, embedding, token_count)
     SELECT ?, id, 0, 'نص', ?, 4 FROM kb_documents WHERE company_id = ?`,
    [id, IS_PG ? '[' + new Array(1536).fill(0).join(',') + ']' : Buffer.alloc(1536 * 4), id],
  );

  const restore = stubVoice({
    syncAgent: async (_c, opts) => {
      await opts.hooks.onToolSynced('tool_created');   // tool really exists now
      throw new Error('agent PATCH exploded');          // …and then this fails
    },
  });
  try {
    const r = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(r.published, false);
    assert.equal(r.failedStep, STEP.PROVIDER_SYNC);
    assert.equal(stepOf(r, STEP.TOOLS_SYNC)?.status, 'ok', 'the tool step succeeded on its own');

    const row = await sql.getCompany.get(id);
    assert.equal(row.elevenlabs_kb_tool_id, 'tool_created',
      'the tool id MUST survive the later failure — otherwise the retry duplicates it');
  } finally { restore(); }
});

test('retrying after that failure REUSES the stored tool instead of creating a second', async () => {
  const id = await makeCompany('toolreuse', { toolId: 'tool_existing' });
  let sawExistingToolId = null;
  const restore = stubVoice({
    syncAgent: async (c, opts) => {
      // The driver decides create-vs-update from company.kbToolId. The pipeline
      // must therefore hand it the id that the failed run persisted.
      sawExistingToolId = c.kbToolId;
      await opts.hooks.onAgentSynced('agent_retry');
      return { agentId: 'agent_retry' };
    },
  });
  try {
    await publishCompany({
      company: companyObj(id, { kbToolId: 'tool_existing' }), deps: DEPS,
    });
    assert.equal(sawExistingToolId, 'tool_existing',
      'the retry passes the previously-created tool id to the driver');
  } finally { restore(); }
});

test('an agent created before a later failure is persisted too', async () => {
  const id = await makeCompany('agentkeep');
  const restore = stubVoice({
    syncAgent: async (_c, opts) => {
      await opts.hooks.onAgentSynced('agent_half');
      throw new Error('inbound agent failed');
    },
  });
  try {
    const r = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(r.published, false);
    const row = await sql.getCompany.get(id);
    assert.equal(row.elevenlabs_agent_id, 'agent_half', 'agent id survives the failure');
  } finally { restore(); }
});

// ══════════════════════════════════════════════════════════════════
// Failure reporting & preservation
// ══════════════════════════════════════════════════════════════════
test('a company with no active scenario fails at validate.scenario with 409', async () => {
  const id = await makeCompany('noscenario', { scenario: false });
  const restore = stubVoice({});
  try {
    const r = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(r.published, false);
    assert.equal(r.failedStep, STEP.VALIDATE_SCENARIO);
    assert.equal(r.httpStatus, 409, 'a configuration problem is 409, not 502');
    assert.match(r.error, /سيناريو/);
    const row = await sql.getCompany.get(id);
    assert.equal(row.publish_status, 'failed');
  } finally { restore(); }
});

test('a provider failure reports 502 and names the step', async () => {
  const id = await makeCompany('providerfail');
  const restore = stubVoice({
    syncAgent: async () => { throw new Error('[502] upstream is down'); },
  });
  try {
    const r = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(r.httpStatus, 502, 'an upstream problem is 502, not 409');
    assert.equal(r.failedStep, STEP.PROVIDER_SYNC);
    assert.match(r.error, /upstream is down/);
  } finally { restore(); }
});

test('a failed publish PRESERVES the previously working agent id', async () => {
  // No rollback: undoing a correct agent because a later step failed would take
  // a working phone line down to tidy up bookkeeping.
  const id = await makeCompany('preserve', { agentId: 'agent_previous' });
  const restore = stubVoice({
    syncAgent: async () => { throw new Error('nope'); },
  });
  try {
    const r = await publishCompany({
      company: companyObj(id, { agentId: 'agent_previous' }), deps: DEPS,
    });
    assert.equal(r.published, false);
    const row = await sql.getCompany.get(id);
    assert.equal(row.elevenlabs_agent_id, 'agent_previous',
      'the previously published agent is left alone');
    assert.equal(r.agentId, 'agent_previous', 'and is reported back unchanged');
  } finally { restore(); }
});

test('an unknown voice is caught BEFORE any provider call', async () => {
  const id = await makeCompany('badvoice');
  let called = false;
  const restore = stubVoice({ syncAgent: async () => { called = true; return {}; } });
  try {
    const r = await publishCompany({
      company: companyObj(id, { settings: { voiceId: 'nope' } }),
      deps: { ...DEPS, isAllowedVoiceId: (v) => v === 'voice_test' },
    });
    assert.equal(r.failedStep, STEP.VALIDATE_COMPANY);
    assert.equal(called, false, 'we never reached the provider');
  } finally { restore(); }
});

// ══════════════════════════════════════════════════════════════════
// Read-back verification
// ══════════════════════════════════════════════════════════════════
test('readback catches an agent whose initiation-webhook flag is false', async () => {
  // The live failure mode: the provider accepts the payload and stores `false`,
  // so the publish "succeeds" while every inbound call loses company context.
  const id = await makeCompany('flagfalse');
  const bad = healthyAgent();
  bad.platform_settings.overrides.enable_conversation_initiation_client_data_from_webhook = false;
  const restore = stubVoice({
    syncAgent: async (_c, opts) => { await opts.hooks.onAgentSynced('agent_flag'); return {}; },
    getAgent: async () => bad,
  });
  try {
    const r = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(r.published, false, 'a silently mis-stored flag must fail the publish');
    assert.equal(r.failedStep, STEP.VERIFY_READBACK);
    assert.match(r.error, /initiation webhook flag/i);
    const row = await sql.getCompany.get(id);
    assert.equal(row.publish_status, 'failed');
  } finally { restore(); }
});

test('readback catches a wrong language and an empty data_collection', async () => {
  const id = await makeCompany('wronglang');
  const bad = healthyAgent();
  bad.conversation_config.agent.language = 'en';
  bad.platform_settings.data_collection = {};
  const restore = stubVoice({
    syncAgent: async (_c, opts) => { await opts.hooks.onAgentSynced('agent_l'); return {}; },
    getAgent: async () => bad,
  });
  try {
    const r = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(r.failedStep, STEP.VERIFY_READBACK);
    assert.match(r.error, /language is "en"/);
    assert.match(r.error, /data_collection is empty/);
  } finally { restore(); }
});

test('readback catches an agent that vanished from the provider', async () => {
  const id = await makeCompany('gone');
  const restore = stubVoice({
    syncAgent: async (_c, opts) => { await opts.hooks.onAgentSynced('agent_gone'); return {}; },
    getAgent: async () => null,
  });
  try {
    const r = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(r.failedStep, STEP.VERIFY_READBACK);
    assert.match(r.error, /غير موجود/);
  } finally { restore(); }
});

// ══════════════════════════════════════════════════════════════════
// Optional steps must not fail the publish
// ══════════════════════════════════════════════════════════════════
test('unregistered workspace webhooks are reported but do NOT fail the publish', async () => {
  const id = await makeCompany('nowebhooks');
  const restore = stubVoice({
    syncAgent: async (_c, opts) => { await opts.hooks.onAgentSynced('agent_w'); return {}; },
    getWorkspaceSettings: async () => ({ webhooks: {}, conversation_initiation_client_data_webhook: null }),
  });
  try {
    const r = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(r.published, true, 'an optional step failing must not block publishing');
    const s = stepOf(r, STEP.WEBHOOKS_VERIFY);
    assert.equal(s.status, 'failed');
    assert.match(s.detail, /post-call webhook/);
  } finally { restore(); }
});

test('a company with no phone number skips phone.attach rather than failing', async () => {
  const id = await makeCompany('nophone');
  const restore = stubVoice({
    syncAgent: async (_c, opts) => { await opts.hooks.onAgentSynced('agent_np'); return {}; },
  });
  try {
    const r = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(r.published, true);
    assert.equal(stepOf(r, STEP.PHONE_ATTACH)?.status, 'skipped');
  } finally { restore(); }
});

test('a company WITH a number has it bound to the freshly published agent', async () => {
  const id = await makeCompany('withphone', { phoneNumberId: 'phnum_1' });
  let boundAgent = null;
  const restore = stubVoice({
    syncAgent: async (_c, opts) => { await opts.hooks.onAgentSynced('agent_new'); return {}; },
    bindPhoneNumber: async (c) => { boundAgent = c.agentId; return { phoneNumber: '+966500000000', agentId: c.agentId }; },
  });
  try {
    const r = await publishCompany({
      company: companyObj(id, { phoneNumberId: 'phnum_1' }), deps: DEPS,
    });
    assert.equal(r.published, true);
    assert.equal(boundAgent, 'agent_new', 'binds the NEW agent id, not a stale one');
  } finally { restore(); }
});

test('KB chunks with no PUBLIC_BASE_URL is surfaced, not silently swallowed', async () => {
  const id = await makeCompany('nobaseurl');
  await dataRun(`INSERT INTO kb_documents (company_id, filename, raw_text) VALUES (?, 'f.md', 'ن')`, [id]);
  await dataRun(
    `INSERT INTO kb_chunks (company_id, document_id, chunk_index, text, embedding, token_count)
     SELECT ?, id, 0, 'ن', ?, 2 FROM kb_documents WHERE company_id = ?`,
    [id, IS_PG ? '[' + new Array(1536).fill(0).join(',') + ']' : Buffer.alloc(1536 * 4), id],
  );
  const restore = stubVoice({
    syncAgent: async (_c, opts) => { await opts.hooks.onAgentSynced('agent_nb'); return {}; },
  });
  try {
    const r = await publishCompany({
      company: companyObj(id), deps: { ...DEPS, publicBaseUrl: '' },
    });
    assert.equal(r.published, true, 'the agent still works from its prompt');
    const s = stepOf(r, STEP.KB_STATUS);
    assert.equal(s.status, 'failed');
    assert.match(s.detail, /PUBLIC_BASE_URL/);
  } finally { restore(); }
});

test('every retry writes a NEW run so the attempt history is readable', async () => {
  const id = await makeCompany('history');
  const restore = stubVoice({
    syncAgent: async (_c, opts) => { await opts.hooks.onAgentSynced('agent_h'); return {}; },
  });
  try {
    await publishCompany({ company: companyObj(id), deps: DEPS });
    await publishCompany({ company: companyObj(id), deps: DEPS });
    const runs = await dataAll(
      `SELECT id FROM company_publish_runs WHERE company_id = ?`, [id],
    );
    assert.equal(runs.length, 2, 'two attempts, two rows');
  } finally { restore(); }
});
