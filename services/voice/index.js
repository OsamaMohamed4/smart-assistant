// Voice provider facade. Every part of the application that needs to place a
// call, publish an agent, read a transcript or verify a provider webhook goes
// through here — nothing else imports a driver directly.
//
// Today there is exactly one driver. The indirection is not speculation: it is
// what kept the Vapi→ElevenLabs migration to one new file plus a handful of
// call sites, instead of a rewrite of server.js, the campaign worker and the
// call pipeline. A company row carries its own `voice_provider`, so the next
// swap can be staged tenant by tenant rather than flag-day.
const { assertDriver } = require('./provider');
const elevenlabs = require('./elevenlabs');

const DRIVERS = Object.freeze({
  [elevenlabs.name]: assertDriver(elevenlabs),
});

const DEFAULT_PROVIDER = elevenlabs.name;

/**
 * Resolve the driver for a company. Unknown or legacy values (rows written
 * before the provider column existed, or a company still marked 'vapi') fall
 * back to the default rather than throwing: a stale column must never stop a
 * live phone line from being published or dialled.
 */
function driverFor(company) {
  const wanted = company?.voiceProvider || DEFAULT_PROVIDER;
  return DRIVERS[wanted] || DRIVERS[DEFAULT_PROVIDER];
}

/** Driver by explicit name — used by the webhook route, which has no company yet. */
function driverByName(name) {
  return DRIVERS[name] || null;
}

// ─── Thin pass-throughs ───────────────────────────────────────────
// Each takes the company so the right driver is chosen per tenant.
const syncAgent         = (company, opts) => driverFor(company).syncAgent(company, opts);
const bindPhoneNumber   = (company) => driverFor(company).bindPhoneNumber(company);
const importPhoneNumber = (company, sip) => driverFor(company).importPhoneNumber(company, sip);
const startOutboundCall = (args) => driverFor(args.company).startOutboundCall(args);

// Read paths key off the row's stored provider, so a historical call is always
// read back through the driver that created it.
const forCall = (call) => driverByName(call?.provider) || DRIVERS[DEFAULT_PROVIDER];
const fetchCall      = (call) => forCall(call).fetchCall(call.id);
const fetchRecording = (call, opts) => forCall(call).fetchRecording(call.id, opts);

// ─── Post-publish verification reads ──────────────────────────────
// Read the provider's OWN view back after writing to it. A payload being
// accepted is not evidence that it was stored: the initiation-webhook flag is
// accepted and silently defaulted to false, which breaks every inbound call
// while looking like a successful publish. These exist so the publish pipeline
// can assert rather than assume.
const getAgent = (agentId, company) => driverFor(company).getAgent(agentId);
const getWorkspaceSettings = (company) => driverFor(company).getWorkspaceSettings();

// ─── Capability tools ─────────────────────────────────────────────
// Building a tool config from a registry declaration, and removing one when a
// company loses the capability. The publish pipeline is provider-neutral and
// goes through here rather than reaching into the driver.
const buildFeatureTool = (company, args) => driverFor(company).buildFeatureToolConfig(args);
const deleteTool = (company, toolId, log) => driverFor(company).deleteTool(toolId, log);

/**
 * Flatten a provider error into one short, loggable, SQL-bindable string.
 * Providers return error bodies in wildly different shapes (nested objects,
 * arrays of validation messages), and a naive `.slice()` on one of those
 * yields a non-string that then fails to bind — a bug this codebase has
 * already been bitten by once, in the campaign worker.
 */
function errText(e) {
  const driver = DRIVERS[DEFAULT_PROVIDER];
  if (typeof driver.errText === 'function') return driver.errText(e);
  return String(e?.message || 'request failed').slice(0, 500);
}

module.exports = {
  DRIVERS, DEFAULT_PROVIDER,
  driverFor, driverByName, forCall, errText,
  syncAgent, bindPhoneNumber, importPhoneNumber, startOutboundCall,
  fetchCall, fetchRecording, getAgent, getWorkspaceSettings,
  buildFeatureTool, deleteTool,
};
