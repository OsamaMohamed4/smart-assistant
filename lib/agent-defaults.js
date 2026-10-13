// How every company's agent is published unless the company has chosen
// otherwise in «إعدادات الصوت والموديل».
//
// Copied field by field from the hand-tuned "Wakan - Nasser" agent
// (agent_0701m497f8qpfpkr0vpx3382cckd), read from the live API on 2026-10-13.
// The operator tunes that agent by ear on real calls and asked for it to be
// the default: pressing تحديث on any company should reproduce it.
//
// Code, not Railway variables, is the source of truth -- the reasoning behind
// DEFAULT_VOICE_ID: a stale ELEVENLABS_LLM, ELEVENLABS_TTS_MODEL or
// VOICE_SPEED_DEFAULT left in the environment would otherwise quietly keep
// every agent off the reference.
//
// Deliberately NOT copied from that agent, because the platform depends on
// its own value or the reference's is wrong for a Saudi line:
//   timezone Africa/Cairo           callers are in Riyadh (Asia/Riyadh stays)
//   prompt-injection guard off      the agent answers a public phone number
//   its native knowledge base       companies use the platform's own, by tool
//   per-call overrides, init hook   Playground voices, campaign greetings and
//                                   caller personalisation need them
//   its data-collection fields      the campaign report reads the platform's
// The voice itself (Jeddawi) is DEFAULT_VOICE_ID in lib/voices.js.

// LLMs a company may run on. The provider hosts the Gemini line itself; the
// OpenAI ones are also what the text channel can run directly (see below).
const OPENAI_MODELS = ['gpt-4.1', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4o-mini'];
const AGENT_MODELS = [...OPENAI_MODELS, 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];

const AGENT_DEFAULTS = Object.freeze({
  model                : 'gemini-3.5-flash-lite',
  temperature          : 0.2,
  maxTokens            : 120,
  ttsModel             : 'eleven_v4',
  expressiveMode       : true,
  stability            : 0.55,
  similarityBoost      : 0.75,
  voiceSpeed           : 1.0,
  turnTimeoutSeconds   : 6,
  // -1 is the provider's "never end the call on silence".
  silenceEndCallSeconds: -1,
  // The reference lets a caller talk over the greeting.
  interruptibleGreeting: true,
});

// The settings keys that tune the engine. Everything else a company stores --
// its voice, transfer number, webhook, daily caps -- is its own business and
// never counts as tuning.
const TUNING_KEYS = [
  'model', 'temperature', 'maxTokens', 'ttsModel', 'expressiveMode',
  'stability', 'similarityBoost', 'voiceSpeed', 'turnTimeoutSeconds', 'silenceEndCallSeconds',
];

const clamp = (v, lo, hi, dflt) =>
  (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : dflt);

/** The agent's LLM settings: the company's own choices over the defaults. */
function resolveAgentModel(settings) {
  const s = settings || {};
  return {
    model      : AGENT_MODELS.includes(s.model) ? s.model : AGENT_DEFAULTS.model,
    temperature: clamp(s.temperature, 0, 1, AGENT_DEFAULTS.temperature),
    maxTokens  : clamp(s.maxTokens, 50, 800, AGENT_DEFAULTS.maxTokens),
  };
}

/** The voice and turn-taking settings, resolved the same way. */
function resolveVoiceTuning(settings) {
  const s = settings || {};
  const d = AGENT_DEFAULTS;
  return {
    stability      : clamp(s.stability, 0, 1, d.stability),
    similarityBoost: clamp(s.similarityBoost, 0, 1, d.similarityBoost),
    voiceSpeed     : clamp(s.voiceSpeed, 0.7, 1.2, d.voiceSpeed),
    ttsModel       : s.ttsModel || d.ttsModel,
    expressiveMode : typeof s.expressiveMode === 'boolean' ? s.expressiveMode : d.expressiveMode,
    idleTimeoutSeconds: clamp(s.turnTimeoutSeconds, 1, 60, d.turnTimeoutSeconds),
    // -1 must survive: clamped to the 5s minimum it would turn "never hang up
    // on silence" into a hang-up five seconds into any pause.
    silenceTimeoutSeconds: Number(s.silenceEndCallSeconds) === -1
      ? -1 : clamp(s.silenceEndCallSeconds, 5, 300, d.silenceEndCallSeconds),
    interruptibleGreeting: d.interruptibleGreeting,
  };
}

// The text channel -- Playground chat, the public Agent API, the scenario
// tester, the evals -- calls OpenAI directly, and OpenAI does not serve the
// Gemini line. A company on Gemini is therefore simulated in text on this
// model; the voice agent itself still runs the company's own.
const TEXT_FALLBACK_MODEL = 'gpt-4.1';
function textChannelModel(model) {
  return OPENAI_MODELS.includes(model) ? model : TEXT_FALLBACK_MODEL;
}

/**
 * Remove every tuning key from a stored settings JSON, keeping the rest. Used
 * once, when the reference became the default: settings saved before then
 * hold the old screen's pre-filled values (gpt-4.1 and friends), which would
 * otherwise outrank the reference on every publish. Returns the new JSON and
 * what was removed (null when nothing was), so the change can be logged.
 */
function stripTuning(settingsJson) {
  let s;
  try { s = JSON.parse(settingsJson || '{}') || {}; } catch { return { settings: settingsJson, removed: null }; }
  if (typeof s !== 'object' || Array.isArray(s)) return { settings: settingsJson, removed: null };
  const removed = {};
  for (const k of TUNING_KEYS) {
    if (k in s) { removed[k] = s[k]; delete s[k]; }
  }
  if (!Object.keys(removed).length) return { settings: settingsJson, removed: null };
  return { settings: JSON.stringify(s), removed };
}

module.exports = {
  AGENT_DEFAULTS, AGENT_MODELS, OPENAI_MODELS, TUNING_KEYS, TEXT_FALLBACK_MODEL,
  resolveAgentModel, resolveVoiceTuning, textChannelModel, stripTuning,
};
