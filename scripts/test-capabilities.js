// Regression suite for the capability layer.
//
// Driver-agnostic — it reaches the database only through the shared statement
// catalog, so the identical assertions run on SQLite and PostgreSQL:
//
//   npm run test:unit                  (SQLite — included by default)
//   npm run test:pg:capabilities       (DB_DRIVER=postgres DATABASE_URL=…)
//
// The property this file exists to defend: removing a tool from the agent at
// publish time is HOUSEKEEPING, not enforcement. A conversation already in
// flight, a cached agent version, or a tool an operator re-added by hand can
// all still call us. So "disabled" has to mean "refused by the backend on every
// invocation", and several tests below assert exactly that.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const IS_PG = (process.env.DB_DRIVER || '').toLowerCase() === 'postgres';
const TMP_DB = path.join(require('node:os').tmpdir(), `sa-caps-${Date.now()}.db`);
if (!IS_PG) {
  process.env.DB_DRIVER = 'sqlite';
  process.env.DB_PATH = TMP_DB;
}
process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'k';
process.env.ELEVENLABS_WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET || 'wsec_caps_test';
process.env.ELEVENLABS_TOOL_SECRET = process.env.ELEVENLABS_TOOL_SECRET || 'tool_secret_for_caps_tests';

const { sql, all: dataAll, run: dataRun, initDb, close: dbClose } = require('../db');
const registry = require('../services/features/registry');
const store = require('../services/features/store');
const { publishCompany, STEP } = require('../services/publish/pipeline');
const el = require('../services/voice/elevenlabs');
const voice = require('../services/voice');

const RUN = Date.now().toString(36);
const cid = (n) => `co-cap-${n}-${RUN}`;

async function makeCompany(name, { chunks = 0, transfer = null, toolId = null, agentId = null } = {}) {
  const id = cid(name);
  await dataRun(
    `INSERT INTO companies (id, name, language, system_prompt, voice_provider,
       elevenlabs_agent_id, elevenlabs_kb_tool_id, settings)
     VALUES (?, ?, 'ar-SA', '', 'elevenlabs', ?, ?, ?)`,
    [id, name, agentId, toolId, transfer ? JSON.stringify({ transferPhoneNumber: transfer }) : null],
  );
  await dataRun(
    `INSERT INTO scenarios (company_id, name, instruction_prompt, first_message, is_active, language)
     VALUES (?, 'sc', 'تعليمات', 'مرحبا', 1, 'ar')`, [id],
  );
  if (chunks > 0) {
    await dataRun(`INSERT INTO kb_documents (company_id, filename, raw_text) VALUES (?, 'f.md', 'ن')`, [id]);
    const emb = IS_PG ? '[' + new Array(1536).fill(0).join(',') + ']' : Buffer.alloc(1536 * 4);
    for (let i = 0; i < chunks; i++) {
      await dataRun(
        `INSERT INTO kb_chunks (company_id, document_id, chunk_index, text, embedding, token_count)
         SELECT ?, id, ?, 'ن', ?, 2 FROM kb_documents WHERE company_id = ? LIMIT 1`,
        [id, i, emb, id],
      );
    }
  }
  if (toolId) {
    await sql.upsertCompanyTool.run({
      company_id: id, feature_key: 'knowledge_base', elevenlabs_tool_id: toolId, config_hash: null,
    });
  }
  return id;
}

const companyObj = (id, over = {}) => ({
  id, name: 'شركة', language: 'ar-SA', settings: {},
  agentId: null, agentIdInbound: null, kbToolId: null, phoneNumberId: null, ...over,
});

const DEPS = {
  composeSystemPrompt: async (_c, p) => p,
  shapeScenario: (r) => ({
    id: r.id, name: r.name, instructionPrompt: r.instruction_prompt,
    instructionPromptInbound: '', firstMessage: r.first_message || '', firstMessageInbound: '',
  }),
  resolveAgentModel: () => ({ model: 'gpt-4.1', temperature: 0.3, maxTokens: 800 }),
  isAllowedVoiceId: () => true,
  defaultVoiceId: 'voice_test',
  voiceSpeedDefault: 1.0,
  publicBaseUrl: 'https://example.test',
};

const healthyAgent = (toolIds = [], sysTools = ['end_call']) => ({
  platform_settings: {
    overrides: { enable_conversation_initiation_client_data_from_webhook: true },
    data_collection: { interest_level: { type: 'string', description: 'x' } },
  },
  conversation_config: {
    agent: { language: 'ar', prompt: { tool_ids: toolIds, tools: sysTools.map((n) => ({ name: n })) } },
  },
});

/** Stub the voice facade and record what the pipeline asked it to do. */
function stubVoice({ syncAgent, getAgent, deleteTool } = {}) {
  const orig = {
    syncAgent: voice.syncAgent, getAgent: voice.getAgent,
    getWorkspaceSettings: voice.getWorkspaceSettings,
    bindPhoneNumber: voice.bindPhoneNumber, deleteTool: voice.deleteTool,
  };
  const seen = { webhookTools: null, transferNumber: undefined, deleted: [] };
  voice.syncAgent = syncAgent || (async (_c, opts) => {
    seen.webhookTools = opts.webhookTools;
    seen.transferNumber = opts.transferNumber;
    for (const t of opts.webhookTools || []) {
      await opts.hooks.onToolSynced?.(t.existingToolId || `tool_${t.featureKey}`, t.featureKey);
    }
    await opts.hooks.onAgentSynced?.('agent_x');
    return { agentId: 'agent_x' };
  });
  voice.getAgent = getAgent || (async () => healthyAgent(
    (seen.webhookTools || []).map((t) => t.existingToolId || `tool_${t.featureKey}`),
    seen.transferNumber ? ['end_call', 'transfer_to_number'] : ['end_call'],
  ));
  voice.getWorkspaceSettings = async () => ({
    webhooks: { post_call_webhook_id: 'wh' },
    conversation_initiation_client_data_webhook: { url: 'https://example.test/init' },
  });
  voice.bindPhoneNumber = async (c) => ({ phoneNumberId: c.phoneNumberId, agentId: c.agentId });
  voice.deleteTool = deleteTool || (async (_c, id) => { seen.deleted.push(id); return true; });
  return { seen, restore: () => Object.assign(voice, orig) };
}

const stepOf = (r, k) => r.steps.find((s) => s.key === k);

before(async () => { await initDb(); });
after(async () => {
  try {
    for (const t of ['company_tools', 'company_features', 'company_publish_runs', 'kb_chunks', 'kb_documents', 'scenarios']) {
      await dataRun(`DELETE FROM ${t} WHERE company_id LIKE ?`, [`%-${RUN}`]);
    }
    await dataRun('DELETE FROM companies WHERE id LIKE ?', [`%-${RUN}`]);
  } catch { /* best effort */ }
  try { await dbClose?.(); } catch {}
  if (!IS_PG) for (const s of ['', '-wal', '-shm']) fs.rmSync(TMP_DB + s, { force: true });
});

// ══ Registry shape ════════════════════════════════════════════════
test('only knowledge_base and call_transfer are implemented in this phase', () => {
  assert.deepEqual(registry.enableableKeys().sort(), ['call_transfer', 'knowledge_base']);
  for (const k of ['appointment_booking', 'ticket_creation', 'send_message', 'workflow_action',
    'system_integration', 'data_exchange', 'request_creation', 'customer_update']) {
    assert.equal(registry.getFeature(k)?.status, 'planned', `${k} must stay planned`);
  }
});

test('the knowledge-base endpoint path is UNCHANGED', () => {
  // Every already-published agent has /tools/kb baked into its tool config.
  // Renaming it would break live companies until each was republished.
  assert.equal(registry.getFeature('knowledge_base').endpoint, 'kb');
  assert.equal(registry.featureByEndpoint('kb').key, 'knowledge_base');
});

test('the generated KB tool config is IDENTICAL to the legacy builder', () => {
  // The config is live on published agents; drifting from it would silently
  // change what the model is allowed to send.
  const legacy = el.buildKbToolConfig({ companyId: 'co-x', publicBaseUrl: 'https://e.test' });
  const generated = el.buildFeatureToolConfig({
    feature: registry.getFeature('knowledge_base'), companyId: 'co-x', publicBaseUrl: 'https://e.test',
  });
  assert.deepEqual(generated, legacy);
});

// ══ 1. Enable / disable ═══════════════════════════════════════════
test('a capability with no row falls back to the registry default', async () => {
  // This is what stops every existing company losing its KB tool the moment
  // the capability layer ships.
  const id = await makeCompany('default');
  assert.equal(await store.featureEnabled(id, 'knowledge_base'), true);
  assert.equal(await store.featureEnabled(id, 'call_transfer'), true);
});

test('disabling then re-enabling round-trips', async () => {
  const id = await makeCompany('toggle');
  assert.equal((await store.setFeature(id, 'knowledge_base', false)).ok, true);
  assert.equal(await store.featureEnabled(id, 'knowledge_base'), false);
  assert.equal((await store.setFeature(id, 'knowledge_base', true)).ok, true);
  assert.equal(await store.featureEnabled(id, 'knowledge_base'), true);
});

test('a PLANNED capability cannot be enabled, and is never reported enabled', async () => {
  const id = await makeCompany('planned');
  const r = await store.setFeature(id, 'appointment_booking', true);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_IMPLEMENTED');
  assert.equal(await store.featureEnabled(id, 'appointment_booking'), false);
});

test('a planned capability stays disabled even if a row claims otherwise', async () => {
  // Backstop against a row written by an older build or by hand.
  const id = await makeCompany('forced');
  await sql.upsertCompanyFeature.run({
    company_id: id, feature_key: 'send_message', enabled: 1, config: null,
  });
  assert.equal(await store.featureEnabled(id, 'send_message'), false,
    'the registry overrules the row for anything not implemented');
});

test('an unknown capability is refused and never enabled', async () => {
  const id = await makeCompany('unknown');
  assert.equal((await store.setFeature(id, 'not_a_feature', true)).code, 'UNKNOWN_FEATURE');
  assert.equal(await store.featureEnabled(id, 'not_a_feature'), false);
});

test('featureEnabled fails CLOSED on missing input', async () => {
  assert.equal(await store.featureEnabled(null, 'knowledge_base'), false);
  assert.equal(await store.featureEnabled('co-x', null), false);
});

// ══ Company A cannot affect company B ═════════════════════════════
test('changing company A capabilities does not touch company B', async () => {
  const a = await makeCompany('iso-a');
  const b = await makeCompany('iso-b');
  await store.setFeature(a, 'knowledge_base', false);

  assert.equal(await store.featureEnabled(a, 'knowledge_base'), false);
  assert.equal(await store.featureEnabled(b, 'knowledge_base'), true, 'B keeps the default');

  const rowsB = await dataAll('SELECT * FROM company_features WHERE company_id = ?', [b]);
  assert.equal(rowsB.length, 0, 'B has no rows at all — A wrote nothing into B');
});

test('tool rows are company-scoped', async () => {
  const a = await makeCompany('tool-a', { toolId: 'tool_a' });
  const b = await makeCompany('tool-b', { toolId: 'tool_b' });
  const ta = await store.loadTools(a);
  const tb = await store.loadTools(b);
  assert.equal(ta.get('knowledge_base').toolId, 'tool_a');
  assert.equal(tb.get('knowledge_base').toolId, 'tool_b');
});

// ══ 5/6. Publishing attaches only enabled capabilities ════════════
test('enabled KB with indexed documents => the tool IS attached', async () => {
  const id = await makeCompany('kb-on', { chunks: 2 });
  const { seen, restore } = stubVoice();
  try {
    const r = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(r.status, 'published', r.error || '');
    assert.deepEqual(seen.webhookTools.map((t) => t.featureKey), ['knowledge_base']);
    assert.match(stepOf(r, STEP.FEATURES_RESOLVE).detail, /knowledge_base/);
    const tools = await store.loadTools(id);
    assert.ok(tools.get('knowledge_base')?.toolId, 'the tool id is persisted per capability');
  } finally { restore(); }
});

test('disabled KB => the tool is NOT attached, even with documents present', async () => {
  const id = await makeCompany('kb-off', { chunks: 2 });
  await store.setFeature(id, 'knowledge_base', false);
  const { seen, restore } = stubVoice();
  try {
    const r = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(r.status, 'published', r.error || '');
    assert.deepEqual(seen.webhookTools, [], 'no tool was planned');
    assert.match(stepOf(r, STEP.FEATURES_RESOLVE).detail, /knowledge_base \(disabled\)/);
  } finally { restore(); }
});

test('enabled KB with NO documents is held back, and says why', async () => {
  const id = await makeCompany('kb-nodocs', { chunks: 0 });
  const { seen, restore } = stubVoice();
  try {
    const r = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(r.status, 'published');
    assert.deepEqual(seen.webhookTools, []);
    assert.match(stepOf(r, STEP.FEATURES_RESOLVE).detail, /لا توجد مستندات مفهرسة/);
  } finally { restore(); }
});

// ══ 7. Transfer behaviour preserved ═══════════════════════════════
test('transfer is attached when enabled AND a number is configured', async () => {
  const id = await makeCompany('tr-on', { transfer: '+966500000000' });
  const { seen, restore } = stubVoice();
  try {
    const r = await publishCompany({
      company: companyObj(id, { settings: { transferPhoneNumber: '+966500000000' } }), deps: DEPS,
    });
    assert.equal(r.status, 'published', r.error || '');
    assert.equal(seen.transferNumber, '+966500000000', 'the number reaches the driver unchanged');
  } finally { restore(); }
});

test('disabling call_transfer withholds the number even when configured', async () => {
  // The capability gates the provider SYSTEM tool by withholding the number
  // that causes it to be declared.
  const id = await makeCompany('tr-off', { transfer: '+966500000000' });
  await store.setFeature(id, 'call_transfer', false);
  const { seen, restore } = stubVoice();
  try {
    const r = await publishCompany({
      company: companyObj(id, { settings: { transferPhoneNumber: '+966500000000' } }), deps: DEPS,
    });
    assert.equal(r.status, 'published', r.error || '');
    assert.equal(seen.transferNumber, null, 'no number => transfer_to_number is not declared');
  } finally { restore(); }
});

test('transfer enabled but no number configured is held back, not failed', async () => {
  const id = await makeCompany('tr-nonum');
  const { seen, restore } = stubVoice();
  try {
    const r = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(r.status, 'published');
    assert.equal(seen.transferNumber, null);
    assert.match(stepOf(r, STEP.FEATURES_RESOLVE).detail, /call_transfer \(لم يُضبط رقم التحويل/);
  } finally { restore(); }
});

// ══ 8. Re-publish does not duplicate ══════════════════════════════
test('re-publishing REUSES the stored tool id instead of creating another', async () => {
  const id = await makeCompany('nodupe', { chunks: 1 });
  let created = 0;
  const { restore } = stubVoice({
    syncAgent: async (_c, opts) => {
      for (const t of opts.webhookTools || []) {
        // The driver decides create-vs-update from existingToolId.
        const toolId = t.existingToolId || (`tool_new_${++created}`);
        await opts.hooks.onToolSynced?.(toolId, t.featureKey);
      }
      await opts.hooks.onAgentSynced?.('agent_x');
      return { agentId: 'agent_x' };
    },
    getAgent: async () => healthyAgent(['tool_new_1']),
  });
  try {
    await publishCompany({ company: companyObj(id), deps: DEPS });
    await publishCompany({ company: companyObj(id), deps: DEPS });
    await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(created, 1, 'the tool was created once across three publishes');
    const rows = await dataAll('SELECT * FROM company_tools WHERE company_id = ?', [id]);
    assert.equal(rows.length, 1, 'and exactly one row exists');
  } finally { restore(); }
});

test('the composite key makes a duplicate tool row impossible', async () => {
  const id = await makeCompany('pk');
  await sql.upsertCompanyTool.run({
    company_id: id, feature_key: 'knowledge_base', elevenlabs_tool_id: 'tool_1', config_hash: null,
  });
  await sql.upsertCompanyTool.run({
    company_id: id, feature_key: 'knowledge_base', elevenlabs_tool_id: 'tool_2', config_hash: null,
  });
  const rows = await dataAll('SELECT * FROM company_tools WHERE company_id = ?', [id]);
  assert.equal(rows.length, 1, 'the second write UPDATED rather than inserted');
  assert.equal(rows[0].elevenlabs_tool_id, 'tool_2');
});

// ══ Pruning ═══════════════════════════════════════════════════════
test('disabling a capability removes its tool on the next publish', async () => {
  const id = await makeCompany('prune', { chunks: 1, toolId: 'tool_old' });
  await store.setFeature(id, 'knowledge_base', false);
  const { seen, restore } = stubVoice();
  try {
    const r = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(r.status, 'published', r.error || '');
    assert.deepEqual(seen.deleted, ['tool_old'], 'the provider tool was deleted');
    const rows = await dataAll('SELECT * FROM company_tools WHERE company_id = ?', [id]);
    assert.equal(rows.length, 0, 'and its row removed');
    assert.match(stepOf(r, STEP.TOOLS_PRUNE).detail, /knowledge_base/);
  } finally { restore(); }
});

// ══ 13. Failure / retry ═══════════════════════════════════════════
test('a tool created before a later failure survives, and the retry reuses it', async () => {
  const id = await makeCompany('retry', { chunks: 1 });
  let created = 0;
  let failNext = true;
  const { restore } = stubVoice({
    syncAgent: async (_c, opts) => {
      for (const t of opts.webhookTools || []) {
        const toolId = t.existingToolId || (`tool_r_${++created}`);
        await opts.hooks.onToolSynced?.(toolId, t.featureKey);
      }
      if (failNext) { failNext = false; throw new Error('agent PATCH exploded'); }
      await opts.hooks.onAgentSynced?.('agent_x');
      return { agentId: 'agent_x' };
    },
    getAgent: async () => healthyAgent(['tool_r_1']),
  });
  try {
    const first = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(first.published, false);
    assert.equal(first.failedStep, STEP.PROVIDER_SYNC);
    const afterFail = await store.loadTools(id);
    assert.equal(afterFail.get('knowledge_base')?.toolId, 'tool_r_1', 'the tool survived the failure');

    const second = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(second.published, true, second.error || '');
    assert.equal(created, 1, 'the retry did NOT create a second tool');
  } finally { restore(); }
});

test('readback refuses an agent carrying a tool the company is not entitled to', async () => {
  const id = await makeCompany('extra', { chunks: 1 });
  const { restore } = stubVoice({ getAgent: async () => healthyAgent(['tool_knowledge_base', 'tool_rogue']) });
  try {
    const r = await publishCompany({ company: companyObj(id), deps: DEPS });
    assert.equal(r.published, false);
    assert.equal(r.failedStep, STEP.VERIFY_READBACK);
    assert.match(r.error, /unrecognised tool/);
  } finally { restore(); }
});

test('readback refuses transfer still declared after the capability is disabled', async () => {
  const id = await makeCompany('tr-stale', { transfer: '+966500000000' });
  await store.setFeature(id, 'call_transfer', false);
  const { restore } = stubVoice({
    getAgent: async () => healthyAgent([], ['end_call', 'transfer_to_number']),
  });
  try {
    const r = await publishCompany({
      company: companyObj(id, { settings: { transferPhoneNumber: '+966500000000' } }), deps: DEPS,
    });
    assert.equal(r.published, false);
    assert.equal(r.failedStep, STEP.VERIFY_READBACK);
    assert.match(r.error, /transfer_to_number is still declared/);
  } finally { restore(); }
});

// ══ 4/9. The security boundary ════════════════════════════════════
const { authorizeToolCall } = require('../routes/webhook');

function toolReq(companyId, { agentId = null, secret = process.env.ELEVENLABS_TOOL_SECRET } = {}) {
  const crypto = require('node:crypto');
  const mac = crypto.createHmac('sha256', secret).update(String(companyId)).digest('base64url');
  const headers = { 'x-company-token': `${companyId}.${mac}` };
  return {
    get: (h) => headers[String(h).toLowerCase()] ?? null,
    body: agentId ? { agent_id: agentId } : {},
    ip: '127.0.0.1',
    dbContext: { bypass: true, companyId: null },
    log: { warn() {}, info() {}, error() {} },
  };
}

test('a DISABLED capability is refused at invocation, without republishing', async () => {
  // The whole point. The agent may still be carrying the tool; the backend says
  // no anyway, and it says no the moment the toggle flips.
  const id = await makeCompany('stale-call', { chunks: 1, agentId: `agent_${RUN}_stale` });
  assert.equal((await authorizeToolCall(toolReq(id), 'knowledge_base')).ok, true, 'allowed while enabled');

  await store.setFeature(id, 'knowledge_base', false);
  const denied = await authorizeToolCall(toolReq(id), 'knowledge_base');
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'FEATURE_DISABLED');
});

test('a stale tool call for a PLANNED capability is refused', async () => {
  const id = await makeCompany('stale-planned');
  const r = await authorizeToolCall(toolReq(id), 'appointment_booking');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('a forged company token is refused before any capability check', async () => {
  const id = await makeCompany('forged');
  const r = await authorizeToolCall(toolReq(id, { secret: 'wrong-secret' }), 'knowledge_base');
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('the company comes from the TOKEN, never from the body', async () => {
  const a = await makeCompany('tok-a', { chunks: 1 });
  const b = await makeCompany('tok-b', { chunks: 1 });
  const req = toolReq(a);
  req.body = { company_id: b, agent_id: null };     // a hostile claim
  const r = await authorizeToolCall(req, 'knowledge_base');
  assert.equal(r.ok, true);
  assert.equal(r.companyId, a, 'the body claim is ignored entirely');
});

test('an agent belonging to ANOTHER company is refused', async () => {
  const a = await makeCompany('agent-a', { chunks: 1, agentId: `agent_${RUN}_a` });
  const b = await makeCompany('agent-b', { chunks: 1, agentId: `agent_${RUN}_b` });
  const r = await authorizeToolCall(toolReq(a, { agentId: `agent_${RUN}_b` }), 'knowledge_base');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('a successful authorization NARROWS the tenant context for the RLS backstop', async () => {
  const id = await makeCompany('narrow', { chunks: 1 });
  const req = toolReq(id);
  assert.equal(req.dbContext.bypass, true, 'starts on the system bypass');
  const r = await authorizeToolCall(req, 'knowledge_base');
  assert.equal(r.ok, true);
  assert.equal(req.dbContext.bypass, false, 'bypass is dropped');
  assert.equal(req.dbContext.companyId, id, 'and pinned to this company');
});

test('a REFUSED authorization leaves the context on the bypass, having touched nothing', async () => {
  const id = await makeCompany('narrow-deny');
  await store.setFeature(id, 'knowledge_base', false);
  const req = toolReq(id);
  const r = await authorizeToolCall(req, 'knowledge_base');
  assert.equal(r.ok, false);
  assert.equal(req.dbContext.companyId, null, 'no tenant was ever selected');
});

// ══ describeFeatures (what the admin UI renders) ══════════════════
test('describeFeatures reports all capabilities with their three states', async () => {
  const id = await makeCompany('describe', { chunks: 1 });
  await store.setFeature(id, 'call_transfer', false);
  const ctx = { kbChunkCount: 1, publicBaseUrl: 'https://e.test', transferNumber: null };
  const list = await store.describeFeatures(id, ctx);

  assert.equal(list.length, registry.allFeatures().length, 'every capability is listed');
  const kb = list.find((f) => f.key === 'knowledge_base');
  const tr = list.find((f) => f.key === 'call_transfer');
  const ap = list.find((f) => f.key === 'appointment_booking');

  assert.equal(kb.enabled, true);
  assert.equal(kb.available, true);
  assert.equal(tr.enabled, false, 'explicitly disabled');
  assert.equal(ap.status, 'planned');
  assert.equal(ap.enabled, false, 'planned is never enabled');
});

test('an enabled capability missing its prerequisites reports a reason', async () => {
  const id = await makeCompany('why', { chunks: 0 });
  const ctx = { kbChunkCount: 0, publicBaseUrl: 'https://e.test', transferNumber: null };
  const kb = (await store.describeFeatures(id, ctx)).find((f) => f.key === 'knowledge_base');
  assert.equal(kb.enabled, true, 'still ON…');
  assert.equal(kb.available, false, '…but cannot attach');
  assert.match(kb.reason, /مستندات/);
});
