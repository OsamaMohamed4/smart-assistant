// "Publish Company" as an actual deployment pipeline.
//
// Publishing touches several remote resources (a workspace tool, one or two
// agents, a phone binding) and any one of them can fail on its own. The old
// implementation wrapped the lot in a single try/catch, so every failure
// surfaced as one opaque 500 and — worse — ids for resources that HAD been
// created were discarded, which made the next attempt create duplicates.
//
// This module fixes both properties:
//
//   · every step reports its own outcome, and the failing one is named
//   · every created resource is persisted the INSTANT it exists (see the
//     `hooks` contract in services/voice/provider.js), so a later failure can
//     never lose it and a retry always updates rather than duplicates
//
// Deliberately NOT done here: rollback. Undoing a correctly-updated agent
// because a later step failed would take a working phone line down to tidy up
// bookkeeping. Prior state is preserved, the failed step is named, and a retry
// converges because every step is an upsert.
const { sql } = require('../../db');
const voice = require('../voice');
const { planCapabilities, loadTools } = require('../features/store');
const { getFeature } = require('../features/registry');

// A step marked `required: false` may fail without failing the publish — it is
// reported as `skipped` or `failed` but the company still reaches 'published'.
// Required steps are the ones whose failure means callers would get a broken or
// mis-configured agent.
const STEP = {
  VALIDATE_COMPANY : 'validate.company',
  VALIDATE_SCENARIO: 'validate.scenario',
  PROMPT_COMPOSE   : 'prompt.compose',
  KB_STATUS        : 'kb.status',
  FEATURES_RESOLVE : 'features.resolve',
  TOOLS_PRUNE      : 'tools.prune',
  // The umbrella provider call. The three below are recorded from inside it by
  // the driver hooks, as each resource actually comes into existence.
  PROVIDER_SYNC    : 'provider.sync',
  TOOLS_SYNC       : 'tools.sync',
  AGENT_UPSERT     : 'agent.upsert',
  AGENT_INBOUND    : 'agent.inbound',
  WEBHOOKS_VERIFY  : 'webhooks.verify',
  PHONE_ATTACH     : 'phone.attach',
  VERIFY_READBACK  : 'verify.readback',
};

// Failures in these steps are the operator's configuration, not the provider's
// fault, so they answer 409 (fix your setup) rather than 502 (upstream broke).
const CONFIG_STEPS = new Set([
  STEP.VALIDATE_COMPANY, STEP.VALIDATE_SCENARIO, STEP.PROMPT_COMPOSE,
]);

class StepFailure extends Error {
  constructor(step, message) {
    super(message);
    this.step = step;
  }
}

/** Collects per-step results, in order, with timings. */
function createRecorder() {
  const steps = [];
  return {
    steps,
    /** Run `fn` as a named step; records ok/failed and rethrows on required. */
    async run(key, required, fn) {
      const t0 = Date.now();
      try {
        const detail = await fn();
        // A step may return the string 'skipped' plus a reason to record that
        // it deliberately did nothing — distinct from having succeeded.
        if (detail && detail.skipped) {
          steps.push({ key, status: 'skipped', detail: detail.reason || null, ms: Date.now() - t0 });
          return null;
        }
        steps.push({ key, status: 'ok', detail: detail?.detail ?? null, ms: Date.now() - t0 });
        return detail?.value ?? null;
      } catch (e) {
        const message = voice.errText ? voice.errText(e) : e.message;
        steps.push({ key, status: 'failed', detail: message, ms: Date.now() - t0 });
        if (required) throw new StepFailure(key, message);
        return null;
      }
    },
    /** Record a step that a driver hook completed on our behalf. */
    note(key, status, detail, ms = 0) {
      steps.push({ key, status, detail: detail ?? null, ms });
    },
  };
}

/**
 * Run the full publish pipeline for one company.
 *
 * `deps` carries the pieces that live in server.js (prompt composition, voice
 * defaults, the public URL) so this module stays testable without booting the
 * HTTP layer.
 *
 * Never throws for an expected failure — returns `{ status: 'failed', … }` with
 * the step that broke. Only a bug in this module escapes.
 */
async function publishCompany({ company, deps, actorEmail = null, log = null }) {
  const {
    composeSystemPrompt, shapeScenario, resolveAgentModel,
    isAllowedVoiceId, defaultVoiceId, voiceSpeedDefault, publicBaseUrl,
  } = deps;

  const rec = createRecorder();
  const out = {
    agentId: company.agentId || null,
    agentIdInbound: company.agentIdInbound || null,
    toolId: company.kbToolId || null,
    scenarioId: null,
    scenarioName: null,
  };

  // Open the run BEFORE any provider call, so a process that dies mid-publish
  // still leaves a 'running' row explaining what was attempted.
  let runId = null;
  try {
    const r = await sql.insertPublishRun.run({
      company_id: company.id, scenario_id: null, actor_email: actorEmail,
    });
    runId = r.lastInsertRowid ?? null;
  } catch (e) {
    log?.error?.('publish: could not open run record', { err: e.message, companyId: company.id });
  }

  let failure = null;
  try {
    // ── 1. company is configured well enough to publish ──────────
    await rec.run(STEP.VALIDATE_COMPANY, true, async () => {
      if (!company.name || !String(company.name).trim()) {
        throw new Error('الشركة بلا اسم — أضف اسماً قبل النشر.');
      }
      const voiceId = company.settings?.voiceId || defaultVoiceId;
      if (!voiceId) throw new Error('لا يوجد صوت مهيّأ لهذه الشركة.');
      // An unknown voice id is accepted by our API and only fails much later at
      // the provider as "Couldn't Find Voice" — catch it here instead.
      if (isAllowedVoiceId && !isAllowedVoiceId(voiceId)) {
        throw new Error(`معرّف الصوت غير معروف: ${voiceId}`);
      }
      return { detail: `voice=${voiceId} lang=${company.language || 'ar'}` };
    });

    // ── 2. the active scenario is the source of truth ────────────
    const scenario = await rec.run(STEP.VALIDATE_SCENARIO, true, async () => {
      const row = await sql.getActiveScenarioForCompany.get(company.id);
      if (!row || !row.instruction_prompt || !String(row.instruction_prompt).trim()) {
        const err = new Error('فعّل سيناريو أولاً قبل النشر — المساعد يُبنى من السيناريو النشط.');
        err.code = 'NO_ACTIVE_SCENARIO';
        throw err;
      }
      const shaped = shapeScenario(row);
      out.scenarioId = shaped.id;
      out.scenarioName = shaped.name;
      return { value: shaped, detail: `scenario #${shaped.id} "${shaped.name}"` };
    });

    // ── 3. compose the exact text the agent will run on ──────────
    const prompts = await rec.run(STEP.PROMPT_COMPOSE, true, async () => {
      const main = await composeSystemPrompt(company, scenario.instructionPrompt);
      const inboundRaw = (scenario.instructionPromptInbound || '').trim();
      const inbound = inboundRaw ? await composeSystemPrompt(company, inboundRaw) : null;
      return {
        value: { main, inbound },
        detail: `${main.length} chars${inbound ? ` (+${inbound.length} inbound)` : ''}`,
      };
    });

    // ── 4. knowledge base status (reported, never auto-embedded) ──
    const kbChunks = await rec.run(STEP.KB_STATUS, false, async () => {
      const n = Number((await sql.countCompanyChunks.get(company.id))?.n || 0);
      if (n > 0 && !publicBaseUrl) {
        // Not a hard failure: the agent still works from its prompt. But it is
        // exactly the silent degradation worth surfacing.
        throw new Error('توجد قاعدة معرفة لكن PUBLIC_BASE_URL غير مضبوط — أداة البحث لن تُرفق.');
      }
      if (n === 0) return { skipped: true, reason: 'no KB chunks — search tool not attached' };
      return { value: n, detail: `${n} chunk(s)` };
    });

    const s = company.settings || {};
    const clamp = (v, lo, hi, dflt) =>
      (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : dflt);
    const { model, temperature, maxTokens } = resolveAgentModel(company);
    const configuredTransfer = /^\+[0-9]{8,15}$/.test(String(s.transferPhoneNumber || '').trim())
      ? String(s.transferPhoneNumber).trim()
      : null;

    // ── 5. which capabilities does this company actually have? ───
    // The registry decides, from the company's own configuration. A capability
    // that is disabled, or enabled but missing its prerequisites, is reported
    // and then NOT attached — it never reaches the agent.
    const plan = await rec.run(STEP.FEATURES_RESOLVE, true, async () => {
      const ctx = {
        kbChunkCount : Number(kbChunks || 0),
        publicBaseUrl,
        transferNumber: configuredTransfer,
      };
      const p = await planCapabilities(company.id, ctx);
      const held = p.skipped.length
        ? `; held back: ${p.skipped.map((x) => `${x.key} (${x.reason})`).join(', ')}`
        : '';
      return { value: p, detail: `enabled: ${p.attach.join(', ') || 'none'}${held}` };
    });

    // Capabilities gate BOTH kinds of tool. `transfer_to_number` is a provider
    // system tool rather than one of ours, so disabling the capability simply
    // withholds the number that causes it to be declared.
    const transferNumber = plan.attach.includes('call_transfer') ? configuredTransfer : null;

    // One entry per enabled capability that needs a tool of ours, carrying the
    // id already registered for it so the driver updates instead of creating.
    const existingTools = await loadTools(company.id);
    const webhookTools = [];
    for (const key of plan.attach) {
      const feature = getFeature(key);
      if (!feature || feature.kind !== 'webhook') continue;
      const cfg = voice.buildFeatureTool(company, {
        feature, companyId: company.id, publicBaseUrl,
      });
      if (!cfg) continue;                  // no tool secret => fail closed
      webhookTools.push({
        featureKey: key,
        cfg,
        existingToolId: existingTools.get(key)?.toolId || null,
      });
    }

    // ── 6–8. provider resources, each persisted as it appears ────
    // The hooks below are the whole point: an id reaches the database before
    // the next provider call can fail.
    const hooks = {
      onToolSynced: async (toolId, featureKey) => {
        const t0 = Date.now();
        const key = featureKey || 'knowledge_base';
        try {
          await sql.upsertCompanyTool.run({
            company_id: company.id, feature_key: key,
            elevenlabs_tool_id: toolId, config_hash: null,
          });
          // The legacy column is kept in step for anything still reading it.
          if (key === 'knowledge_base') {
            await sql.setCompanyKbTool.run({ id: company.id, tool_id: toolId });
            out.toolId = toolId;
          }
          rec.note(STEP.TOOLS_SYNC, 'ok', `${key}=${toolId}`, Date.now() - t0);
        } catch (e) {
          rec.note(STEP.TOOLS_SYNC, 'failed', `tool ${toolId} (${key}) created but NOT saved: ${e.message}`);
          throw e;
        }
      },
      onAgentSynced: async (agentId) => {
        const t0 = Date.now();
        try {
          await sql.setCompanySynced.run(agentId, company.id);
          out.agentId = agentId;
          rec.note(STEP.AGENT_UPSERT, 'ok', agentId, Date.now() - t0);
        } catch (e) {
          rec.note(STEP.AGENT_UPSERT, 'failed', `agent ${agentId} created but NOT saved: ${e.message}`);
          throw e;
        }
      },
      onInboundAgentSynced: async (agentIdInbound) => {
        const t0 = Date.now();
        try {
          await sql.setCompanyInboundAssistant.run({ id: company.id, aid: agentIdInbound });
          out.agentIdInbound = agentIdInbound;
          rec.note(STEP.AGENT_INBOUND, 'ok', agentIdInbound, Date.now() - t0);
        } catch (e) {
          rec.note(STEP.AGENT_INBOUND, 'failed', `inbound agent created but NOT saved: ${e.message}`);
          throw e;
        }
      },
    };

    await rec.run(STEP.PROVIDER_SYNC, true, async () => {
      await voice.syncAgent(company, {
        prompt       : prompts.main,
        promptInbound: prompts.inbound,
        firstMessage : scenario.firstMessageInbound
                    || scenario.firstMessage
                    || `حياك الله في ${company.name}، كيف يقدر أساعدك؟`,
        firstMessageInbound: scenario.firstMessageInbound || null,
        model, temperature, maxTokens,
        voiceId        : s.voiceId || defaultVoiceId,
        stability      : clamp(s.stability, 0, 1, 0.8),
        similarityBoost: clamp(s.similarityBoost, 0, 1, 0.8),
        voiceSpeed     : clamp(s.voiceSpeed, 0.7, 1.2, voiceSpeedDefault),
        transferNumber,
        webhookTools,
        publicBaseUrl,
        log,
        hooks,
      });
      return { detail: `agent=${out.agentId}, tools=${webhookTools.length}` };
    });

    // ── 9. withdraw tools for capabilities the company no longer has ──
    // Detaching at the agent is not enough on its own — the tool resource would
    // linger at the provider and accumulate with every capability change. The
    // live endpoint refuses disabled capabilities regardless, so this is
    // tidiness rather than the security boundary, and therefore optional.
    await rec.run(STEP.TOOLS_PRUNE, false, async () => {
      const keep = new Set(webhookTools.map((t) => t.featureKey));
      const stale = [...existingTools.entries()].filter(([key]) => !keep.has(key));
      if (!stale.length) return { skipped: true, reason: 'nothing to remove' };
      const removed = [];
      for (const [key, { toolId }] of stale) {
        await voice.deleteTool(company, toolId, log);
        await sql.deleteCompanyTool.run({ company_id: company.id, feature_key: key });
        if (key === 'knowledge_base') {
          await sql.setCompanyKbTool.run({ id: company.id, tool_id: null });
          out.toolId = null;
        }
        removed.push(key);
      }
      return { detail: `removed: ${removed.join(', ')}` };
    });

    // ── 8. workspace webhooks are registered ─────────────────────
    await rec.run(STEP.WEBHOOKS_VERIFY, false, async () => {
      const settings = await voice.getWorkspaceSettings();
      const missing = [];
      if (!settings?.webhooks?.post_call_webhook_id) missing.push('post-call webhook');
      if (!settings?.conversation_initiation_client_data_webhook?.url) missing.push('init webhook');
      if (missing.length) {
        throw new Error(`غير مسجّل في مساحة العمل: ${missing.join('، ')}`);
      }
      return { detail: 'post-call + init webhooks registered' };
    });

    // ── 9. point the company's number at the agent ───────────────
    await rec.run(STEP.PHONE_ATTACH, false, async () => {
      if (!company.phoneNumberId) {
        return { skipped: true, reason: 'no imported phone number for this company' };
      }
      const bound = await voice.bindPhoneNumber({
        ...company,
        agentId: out.agentId,
        agentIdInbound: out.agentIdInbound,
      });
      return { detail: `${bound.phoneNumber || company.phoneNumber} → ${bound.agentId}` };
    });

    // ── 10. read the agent back and assert it is really correct ──
    // This is what catches the class of failure where the provider accepts a
    // payload and quietly stores something else — the init-webhook flag being
    // the live example.
    await rec.run(STEP.VERIFY_READBACK, true, async () => {
      const agent = await voice.getAgent(out.agentId);
      if (!agent) throw new Error(`الوكيل ${out.agentId} غير موجود عند المزوّد بعد النشر.`);
      const problems = [];
      const ov = agent.platform_settings?.overrides || {};
      if (ov.enable_conversation_initiation_client_data_from_webhook !== true) {
        problems.push('initiation webhook flag is false — inbound calls would lose company context');
      }
      if (!Object.keys(agent.platform_settings?.data_collection || {}).length) {
        problems.push('data_collection is empty — post-call lead fields would be blank');
      }
      const lang = String(agent.conversation_config?.agent?.language || '');
      const want = String(company.language || 'ar').split('-')[0].toLowerCase();
      if (!lang.startsWith(want)) problems.push(`language is "${lang}", expected "${want}"`);
      // Every enabled capability that should have a tool must actually be
      // attached, and — just as important — nothing the company is NOT entitled
      // to may be attached. Both directions are asserted, because a capability
      // silently missing and a capability silently present are each bugs.
      const toolIds = agent.conversation_config?.agent?.prompt?.tool_ids || [];
      const expected = await loadTools(company.id);
      for (const t of webhookTools) {
        const id = expected.get(t.featureKey)?.toolId;
        if (id && !toolIds.includes(id)) {
          problems.push(`capability "${t.featureKey}" is enabled but its tool is not attached`);
        }
      }
      const entitled = new Set([...expected.values()].map((v) => v.toolId));
      for (const id of toolIds) {
        if (!entitled.has(id)) problems.push(`an unrecognised tool is attached: ${id}`);
      }
      // The transfer capability is a provider system tool, so it is verified by
      // its presence in the declared tool list rather than by tool_ids.
      const sysTools = (agent.conversation_config?.agent?.prompt?.tools || []).map((t) => t?.name);
      const wantsTransfer = plan.attach.includes('call_transfer') && !!transferNumber;
      if (wantsTransfer && !sysTools.includes('transfer_to_number')) {
        problems.push('call transfer is enabled but transfer_to_number is not declared');
      }
      if (!wantsTransfer && sysTools.includes('transfer_to_number')) {
        problems.push('call transfer is disabled but transfer_to_number is still declared');
      }
      if (problems.length) throw new Error(problems.join('؛ '));
      return { detail: `verified: lang=${lang}, tools=${toolIds.length}, capabilities=${plan.attach.join('+') || 'none'}` };
    });
  } catch (e) {
    failure = e instanceof StepFailure
      ? e
      : new StepFailure('pipeline', e.message);
  }

  // ── persist the outcome ────────────────────────────────────────
  const status = failure ? 'failed' : 'published';
  try {
    if (runId !== null) {
      await sql.finishPublishRun.run({
        id: runId,
        status,
        steps: JSON.stringify(rec.steps),
        error: failure ? String(failure.message).slice(0, 1000) : null,
        failed_step: failure ? failure.step : null,
        agent_id: out.agentId,
      });
    }
    await sql.setCompanyPublishStatus.run({ id: company.id, status });
  } catch (e) {
    log?.error?.('publish: could not record outcome', { err: e.message, companyId: company.id });
  }

  return {
    status,
    published: !failure,
    runId,
    steps: rec.steps,
    failedStep: failure ? failure.step : null,
    error: failure ? failure.message : null,
    // 409 = your configuration is wrong; 502 = the provider call failed.
    httpStatus: failure ? (CONFIG_STEPS.has(failure.step) ? 409 : 502) : 200,
    ...out,
    phoneBound: !!company.phoneNumberId,
  };
}

module.exports = { publishCompany, STEP };
