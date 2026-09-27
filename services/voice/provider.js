// The contract every voice provider driver implements, plus the shared shapes
// the rest of the application is allowed to see.
//
// Nothing in here talks to a network. Its job is to define ONE vocabulary for
// calls so that `services/call-events.js`, the campaign worker and the HTTP
// routes never learn a provider's field names. When a provider changes, this
// file and one driver change; everything downstream does not.

/**
 * A call event, normalized out of whatever envelope the provider sent.
 *
 * `companyId` is deliberately NOT part of what a driver parses out of a
 * payload — it is resolved server-side by `resolveCompanyForEvent`, from
 * identifiers the provider (not the caller, and not the model) controls.
 *
 * @typedef  {Object}  NormalizedCallEvent
 * @property {string}  provider           'elevenlabs'
 * @property {string}  providerCallId     primary id; becomes calls.id
 * @property {?string} providerCallRef    secondary id (SIP call id) for PBX correlation
 * @property {?string} agentId            provider agent that handled the call
 * @property {?string} companyId          filled in by resolveCompanyForEvent
 * @property {'inbound'|'outbound'} direction
 * @property {?string} callerNumber       E.164, the OTHER party
 * @property {?string} destinationNumber  E.164, our side (the 3CX DID)
 * @property {?string} transcript         flattened plain text
 * @property {?string} startedAt          'YYYY-MM-DD HH:MM:SS' UTC
 * @property {?string} endedAt            'YYYY-MM-DD HH:MM:SS' UTC
 * @property {?number} durationSec
 * @property {?string} endedReason
 * @property {?string} recordingUrl   PUBLICLY fetchable URL, or null. Never an
 *                                    internal/provider-scoped identifier: this
 *                                    value is forwarded to customers' systems
 *                                    by the outgoing webhook and appears in CSV
 *                                    exports, so a placeholder here leaks.
 * @property {boolean} hasRecording   whether audio exists at all — the signal
 *                                    the UI needs when there is no public URL
 * @property {?string} summary
 * @property {?Object} structuredData     post-call extraction (lead fields)
 * @property {?number} costUsd       real currency, or null. A provider that
 *                                    bills in its own units must NOT convert at
 *                                    a guessed rate to fill this in — null is
 *                                    the honest answer and costCredits carries
 *                                    what was actually reported.
 * @property {?number} costCredits    provider-native billing units, or null
 * @property {boolean} isFinal            true once the call is over and the
 *                                        row can be treated as complete
 * @property {Object}  metadata           provider-specific extras, for debugging
 */

/**
 * Methods a driver must export. Kept as a plain list so `index.js` can assert
 * a driver is complete at load time rather than exploding on the first call.
 */
// `syncAgent` accepts an OPTIONAL `opts.hooks` object. A driver that creates
// several remote resources must await the matching hook the moment each one
// exists, so the caller can persist its id before any later step can throw:
//
//   hooks.onToolSynced(toolId)          a workspace tool now exists
//   hooks.onAgentSynced(agentId)        the main agent now exists
//   hooks.onInboundAgentSynced(id)      the optional inbound agent now exists
//
// Every hook is optional and may be absent — a driver calls them with `?.`.
// This exists because returning ids only at the END lost resources that had
// really been created when a later call failed, and the next publish then
// created DUPLICATES of them.
const REQUIRED_METHODS = [
  'name',                    // string id, e.g. 'elevenlabs'
  'syncAgent',               // (company, { …, hooks }) -> { agentId, agentIdInbound, toolId }
  'bindPhoneNumber',         // (company) -> { phoneNumberId, phoneNumber, agentId }
  'importPhoneNumber',       // (company, sipConfig) -> { phoneNumberId }
  'startOutboundCall',       // ({ company, toNumber, variables, firstMessage }) -> { callId, callRef, status }
  'fetchCall',               // (providerCallId) -> NormalizedCallEvent | null
  'fetchRecording',          // (providerCallId, { range }) -> { stream, headers } | null
  'listRecentCalls',         // (limit) -> NormalizedCallEvent[]
  'verifyWebhook',           // (req) -> boolean
  'normalizeEvent',          // (payload) -> NormalizedCallEvent | null
];

/** Throws unless `driver` implements the whole contract. */
function assertDriver(driver) {
  if (!driver || typeof driver !== 'object') throw new Error('voice: driver is not an object');
  const missing = REQUIRED_METHODS.filter(
    (m) => !(m === 'name' ? typeof driver.name === 'string' : typeof driver[m] === 'function'),
  );
  if (missing.length) {
    throw new Error(`voice: driver "${driver.name || '?'}" is missing: ${missing.join(', ')}`);
  }
  return driver;
}

// ─── Shared normalizing helpers ───────────────────────────────────
// Drivers use these so every provider produces byte-identical column values.

/**
 * Storage timestamp: 'YYYY-MM-DD HH:MM:SS' UTC. This is the format BOTH db
 * drivers store and every BETWEEN range query compares against, so a provider
 * handing us an ISO string or unix seconds must come through here.
 */
function toStamp(value) {
  if (value === null || value === undefined || value === '') return null;
  let d;
  if (typeof value === 'number') {
    // Unix seconds vs milliseconds: anything below ~1e12 is seconds.
    d = new Date(value < 1e12 ? value * 1000 : value);
  } else {
    d = new Date(value);
  }
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/** Seconds between two stamps, or null when either is missing/invalid. */
function durationBetween(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null;
  const a = new Date(`${startedAt}Z`);
  const b = new Date(`${endedAt}Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const secs = Math.round((b - a) / 1000);
  return secs >= 0 ? secs : null;
}

/** E.164 sanity check. Used before dialling and before trusting a payload. */
const E164_RE = /^\+[1-9]\d{7,14}$/;
const isE164 = (v) => E164_RE.test(String(v || '').trim());

/**
 * Collapse a turn-by-turn transcript into the single TEXT column `calls`
 * has always held, in the same "Role: text" layout the dashboard already
 * renders and `lib/lead-scoring.js` already parses.
 */
function flattenTranscript(turns, roleLabels = { agent: 'AI', user: 'User' }) {
  if (typeof turns === 'string') return turns.trim() || null;
  if (!Array.isArray(turns) || !turns.length) return null;
  const lines = [];
  for (const t of turns) {
    const message = String(t?.message ?? t?.text ?? '').trim();
    if (!message) continue;                      // tool-only turns carry no speech
    const role = roleLabels[t?.role] || t?.role || '?';
    lines.push(`${role}: ${message}`);
  }
  return lines.length ? lines.join('\n') : null;
}

module.exports = {
  REQUIRED_METHODS,
  assertDriver,
  toStamp,
  durationBetween,
  isE164,
  E164_RE,
  flattenTranscript,
};
