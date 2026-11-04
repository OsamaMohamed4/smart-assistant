// A company's knowledge base is split by channel. Each document belongs to one
// channel (kb_documents.audience):
//   - outbound : the outbound-calls agent
//   - inbound  : the inbound-calls agent
//   - whatsapp : the WhatsApp agent (its own base, no longer merged with inbound)
//   - general  : shared knowledge every channel reads, on top of its own
//
// Listing / upload / delete scope a document to ONE channel (strict, via
// inAudience). Generating a reply instead reads the channel's own documents
// PLUS the shared `general` ones (via inReadAudience), so general knowledge is
// available to every agent without being copied into each base.
//
// `null` audience means "all of the company's documents": a single agent that
// answers every direction (a scenario without inbound-specific instructions)
// reads everything.

const AUDIENCES = Object.freeze({
  outbound: 'المكالمات الصادرة',
  inbound : 'المكالمات الواردة',
  whatsapp: 'واتساب',
  general : 'معرفة عامة مشتركة',
});

// The shared base every channel also reads.
const SHARED_AUDIENCE = 'general';

const validAudience = (v) => (Object.prototype.hasOwnProperty.call(AUDIENCES, v) ? v : null);

const hasInboundPart = (scenario) =>
  !!String(scenario?.instruction_prompt_inbound ?? scenario?.instructionPromptInbound ?? '').trim();

/** Documents for the agent (or text channel) running these instructions. */
function scenarioAudience(scenario, inbound) {
  if (!hasInboundPart(scenario)) return null;
  return inbound ? 'inbound' : 'outbound';
}

/** Documents for the agent that made an in-call tool request. */
function agentAudience(company, agentId) {
  const id = String(agentId || '');
  if (!id || !company?.agentIdInbound) return null;
  if (id === company.agentIdInbound) return 'inbound';
  if (id === company.agentId) return 'outbound';
  return null;
}

// ─── Membership ───────────────────────────────────────────────
// STRICT: a document row (or chunk joined to one) belongs to exactly this
// channel. Used for listing a section, and for scoping upload/delete, so the
// WhatsApp section shows only WhatsApp files, never the shared ones.
const inAudience = (row, audience) => !audience || !row.audience || row.audience === audience;

// READ: what an agent on `audience` actually sees — its own documents plus the
// shared `general` base. Used only when composing a reply, never for listing.
const inReadAudience = (row, audience) => inAudience(row, audience) || row.audience === SHARED_AUDIENCE;

module.exports = {
  AUDIENCES, SHARED_AUDIENCE,
  validAudience, scenarioAudience, agentAudience,
  inAudience, inReadAudience, hasInboundPart,
};
