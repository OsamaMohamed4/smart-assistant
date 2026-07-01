const { sql } = require('./db');
const { MASTER_PROMPT } = require('./lib/master-prompt');

const cache = new Map();

// Core prompt builder: master rules + company-specific prompt + inline KB text.
// Synchronous so it can be used by Vapi assistant creation.
function buildBaseSystemPrompt(systemPrompt, kb) {
  const business = systemPrompt || '';
  const kbBlock  = kb
    ? `\n\n---\nقاعدة معرفة الشركة (استخدمها كمصدر حقائق رسمي):\n\n${kb}`
    : '';
  return `${MASTER_PROMPT}${business}${kbBlock}`;
}

// Resolve the system prompt the chat handler should send to the model for a
// given turn. Order of precedence:
//   1. Latest *active* Scenario for the company (the new Scenarios feature)
//   2. company.system_prompt + kb_text (legacy path before Scenarios)
// Then we append RAG chunks retrieved from the user's query.
// Active Scenario is now the SOLE source of truth. There's no more fallback
// to company.system_prompt — that field is legacy and was removed from the UI.
// If a company has no active scenario, callers see a clear error instead of
// a silently-different prompt.
class NoActiveScenarioError extends Error {
  constructor(companyId) {
    super(`Company "${companyId}" has no active scenario. Activate one from the Scenarios tab first.`);
    this.code = 'NO_ACTIVE_SCENARIO';
    this.status = 409;
  }
}

async function buildSystemPromptWithRAG(company, userQuery, vars) {
  const scenario = sql.getActiveScenarioForCompany.get(company.id);
  if (!scenario || !scenario.instruction_prompt) {
    throw new NoActiveScenarioError(company.id);
  }
  // Runtime vars first (per-call values like agent_name from selected voice),
  // then globals as fallback (date/time, and agent_name ← company.name if
  // the caller didn't supply one). Scenario is the SOLE source of truth — no
  // MASTER prefix — so the text channel matches the Vapi voice channel.
  let filled = fillRuntimeVars(scenario.instruction_prompt, vars);
  filled = fillGlobals(filled, company);
  const base = filled;

  if (!userQuery) return base;
  const chunkCount = sql.countCompanyChunks.get(company.id)?.n || 0;
  if (!chunkCount) return base;
  try {
    const { retrieve, formatChunksForPrompt } = require('./lib/rag');
    const chunks = await retrieve(company.id, userQuery);
    if (!chunks.length) return base;
    return base + formatChunksForPrompt(chunks);
  } catch (e) {
    console.error('RAG retrieval error:', e.message);
    return base;
  }
}

// Replace global template variables (agent_name, date, time, etc) in a prompt
// at chat time. Per-call variables (customer_name, account_number…) stay
// untouched so the model recognises them as runtime placeholders.
function fillGlobals(text, company) {
  if (!text) return text;
  const now = new Date();
  const map = {
    agent_name : company.name || 'المساعد',
    date       : now.toISOString().slice(0, 10),
    time       : now.toISOString().slice(11, 16),
  };
  return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(map, name) ? map[name] : m
  );
}

// Apply per-call variables (customer_name, account_number, ...) supplied by
// the caller (Playground form, Vapi context). Unknown placeholders stay
// untouched so a bad payload can't silently delete part of the prompt.
function fillRuntimeVars(text, vars) {
  if (!text || !vars || typeof vars !== 'object') return text;
  return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, name) => {
    const v = vars[name];
    return (v !== undefined && v !== null && v !== '') ? String(v) : m;
  });
}

function toCompany(row) {
  if (!row) return null;
  let settings = {};
  try { if (row.settings) settings = JSON.parse(row.settings) || {}; } catch {}
  return {
    id            : row.id,
    userId        : row.user_id || null,
    name          : row.name,
    language      : row.language,
    voiceId       : row.voice_id,
    phoneNumber   : row.phone_number,
    assistantId   : row.assistant_id,
    lastSyncedAt  : row.last_synced_at || null,
    hasKB         : !!row.kb_text,
    settings,
    systemPrompt  : buildBaseSystemPrompt(row.system_prompt, row.kb_text),
    raw           : { systemPrompt: row.system_prompt, kbText: row.kb_text },
  };
}

function loadCompany(id) {
  if (cache.has(id)) return cache.get(id);
  const company = toCompany(sql.getCompany.get(id));
  if (company) cache.set(id, company);
  return company;
}

function listCompanies() {
  return sql.listCompanies.all().map((r) => r.id);
}

function listCompaniesFull() {
  return sql.listCompanies.all().map(toCompany);
}

function invalidateCache(id) {
  if (id) cache.delete(id);
  else    cache.clear();
}

module.exports = {
  loadCompany, listCompanies, listCompaniesFull, invalidateCache,
  buildSystemPromptWithRAG, fillGlobals, fillRuntimeVars,
  NoActiveScenarioError,
};
