// A company's knowledge base is two: what its inbound agent knows -- inbound
// calls, and WhatsApp, which answers a customer who wrote first the way an
// inbound call is answered -- and what its outbound agent knows. Every
// document is one or the other (kb_documents.audience).
//
// The split follows the scenario's: a scenario with instructions for inbound
// calls publishes two agents, each reading its own documents. One without
// them publishes a single agent that answers both directions, so it reads
// both -- `null` below means "all of the company's documents".

const AUDIENCES = Object.freeze({
  inbound : 'المكالمات الواردة وواتساب',
  outbound: 'المكالمات الصادرة',
});

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

/** A document row (or chunk joined to one) belongs to this audience. */
const inAudience = (row, audience) => !audience || !row.audience || row.audience === audience;

module.exports = { AUDIENCES, validAudience, scenarioAudience, agentAudience, inAudience, hasInboundPart };
