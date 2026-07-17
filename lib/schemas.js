// Zod request schemas — one per validated endpoint. Field names, types and
// caps mirror exactly what each handler reads today (see server.js / routes),
// so a currently-valid request stays valid; only malformed input is rejected.
//
// Design notes:
// - `.strip()` (Zod default) removes unknown keys. Every handler here already
//   reads only known keys, so stripping is behaviour-preserving AND stops junk
//   reaching the DB.
// - Fields the handler validates with its own regex + localized message
//   (transferPhoneNumber, webhookUrl) are kept loose here (string + length) so
//   that nicer, Arabic error stays the source of truth.
// - `.passthrough()` is used ONLY where the handler reads more fields than are
//   enumerated here (campaigns), to guarantee we never drop a needed key.
const { z } = require('zod');

const companyId = z
  .string()
  .regex(/^[a-z0-9-]{1,40}$/, 'must be lowercase letters, digits or hyphens (max 40)');

const optStr = (max) => z.string().max(max).optional();
const optNum = () => z.coerce.number().finite().optional();

// ── params ──────────────────────────────────────────────────────
const companyIdParam = z.object({ id: companyId }).passthrough();

// ── POST /api/v1/agent/chat (public, API-key) ───────────────────
// company_id optional (a company-scoped key decides the tenant); the handler
// keeps its own 413 for the 4000-char business cap, so no max on message here.
const agentChatBody = z.object({
  company_id: z.string().max(40).optional(),
  customer_phone: z.string().trim().min(1, 'customer_phone is required').max(40),
  message: z.string().min(1, 'message is required'),
});

// ── POST /api/companies ─────────────────────────────────────────
const companyCreateBody = z.object({
  id: companyId,
  name: z.string().trim().min(1, 'name is required').max(200),
  language: optStr(20),
  voiceId: optStr(60),
  phoneNumber: optStr(40),
  systemPrompt: optStr(30000),
  kbText: optStr(200000),
});

// ── PATCH /api/companies/:id ────────────────────────────────────
const companyPatchBody = z.object({
  name: optStr(200),
  language: optStr(20),
  voiceId: optStr(60),
  phoneNumber: optStr(40),
  assistantId: optStr(120),
  systemPrompt: optStr(30000),
  kbText: optStr(200000),
});

// ── PATCH /api/companies/:id/settings ───────────────────────────
const MODELS = ['gpt-4.1', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4o-mini'];
const settingsBody = z.object({
  voiceId: optStr(60),
  model: z.enum(MODELS).optional(),
  temperature: optNum(),
  maxTokens: optNum(),
  stability: optNum(),
  similarityBoost: optNum(),
  optimizeStreamingLatency: optNum(),
  voiceSpeed: optNum(),
  dailyMessageCap: optNum(),
  dailyOutboundCap: optNum(),
  outboundPhoneNumberId: optStr(80),
  inboundPhoneNumberId: optStr(80),
  transferPhoneNumber: optStr(20), // loose — handler enforces E.164 + Arabic msg
  webhookUrl: optStr(300), // loose — handler enforces http(s) + Arabic msg
  webhookSecret: optStr(128),
});

// ── POST /api/companies/:id/api-keys ────────────────────────────
const apiKeyCreateBody = z.object({ name: optStr(80) });

// ── POST /api/companies/:id/scenarios ───────────────────────────
const scenarioCreateBody = z.object({
  name: z.string().trim().min(1, 'name is required').max(200),
  instructionPrompt: z.string().trim().min(1, 'instructionPrompt is required').max(30000),
  firstMessage: optStr(2000),
  firstMessageInbound: optStr(2000),
  description: optStr(4000),
  successCriteria: z.array(z.any()).max(100).optional(),
  variables: z.any().optional(),
  knowledgeBaseIds: z.array(z.any()).max(500).optional(),
  isActive: z.boolean().optional(),
  language: optStr(8),
});

// ── POST /api/companies/:id/campaigns ───────────────────────────
// passthrough: the handler reads scheduling fields beyond those enumerated here.
const campaignCreateBody = z
  .object({
    name: z.string().trim().min(1, 'name is required').max(120),
    contacts: z.array(z.any()).max(5000).optional(),
    numbersText: z.string().max(500000).optional(),
  })
  .passthrough();

module.exports = {
  companyIdParam,
  agentChatBody,
  companyCreateBody,
  companyPatchBody,
  settingsBody,
  apiKeyCreateBody,
  scenarioCreateBody,
  campaignCreateBody,
  MODELS,
};
