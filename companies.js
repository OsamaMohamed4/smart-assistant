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

// Async version used at chat time. Appends RAG-retrieved chunks when documents exist.
async function buildSystemPromptWithRAG(company, userQuery) {
  const base = company.systemPrompt;
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

function toCompany(row) {
  if (!row) return null;
  return {
    id           : row.id,
    userId       : row.user_id || null,
    name         : row.name,
    language     : row.language,
    voiceId      : row.voice_id,
    phoneNumber  : row.phone_number,
    assistantId  : row.assistant_id,
    hasKB        : !!row.kb_text,
    systemPrompt : buildBaseSystemPrompt(row.system_prompt, row.kb_text),
    raw          : { systemPrompt: row.system_prompt, kbText: row.kb_text },
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
  buildSystemPromptWithRAG,
};
