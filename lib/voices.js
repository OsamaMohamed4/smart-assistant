// The voices a company's agent may speak with.
//
// One list, read by the settings screen, the publish step and the Playground,
// so a voice cannot be offered in one place and refused in another. Every id
// here is on the ElevenLabs account the platform publishes with: an id that is
// not is accepted by our API and fails only at publish time, as the provider's
// opaque "Couldn't Find Voice". Gender and accent are read from GET /v1/voices,
// not inferred; the labels are the names the operator gave them.
//
// The operator chose two (2026-10-12) and dropped the female one, Mona (منى),
// on 2026-10-23: ناصر is the only voice now. No agent was speaking with Mona
// and no scenario named منى when it went (checked against the live agents).
//
// The male voice is the provider's "Jeddawi", but it is shown -- and the agent
// introduces itself -- as ناصر (operator's request, 2026-10-19). The label is
// the name; the id, and so the sound, did not change.
const MONA    = 'o0oG1TnHDWDdKbAeBgCO';
const JEDDAWI = 'yXEnnEln9armDCyhkXcA';

const VOICES = [
  { id: JEDDAWI, name: 'Jeddawi', label: 'ناصر', description: 'صوت رجالي سعودي عميق وواثق', gender: 'male', accent: 'saudi' },
];

// Used when a company has not picked one. Jeddawi is the voice production
// already runs on. Code is the source of truth rather than a Railway variable,
// so a stale ELEVENLABS_VOICE_ID cannot silently override it.
const DEFAULT_VOICE_ID = JEDDAWI;

// Voices that were in the catalogue before it was replaced, and what speaks in
// their place. A company saved with one of them would otherwise fail every
// publish ("unknown voice") and every settings save, so it is moved to the
// replacement instead -- from its next publish, not retroactively. Ali and
// Nasser were male, as is Jeddawi. Mona was female: a company still saved
// with her speaks as ناصر, and {{agent_name}} / {{agent_gender}} follow the
// voice, so the agent's name and grammar turn masculine with it.
const RETIRED_VOICES = {
  MI88rOZjXbH22N8KHXUo: JEDDAWI, // Ali
  cFUFIbKkO2iZFwS8cRnY: JEDDAWI, // Nasser
  [MONA]: JEDDAWI,               // Mona (منى), dropped 2026-10-23
};

// Scenarios written while a voice's name was the agent's name carry that name
// as text, so it stayed put whatever voice the company moved to. The operator
// asked for ناصر to go (2026-10-13): each standalone occurrence becomes
// {{agent_name}}, which follows the voice. Standalone means not inside a
// longer word -- الناصرية and ناصري are left alone. علي is deliberately not
// handled the same way: written على it is also the preposition "on", and no
// pattern can tell the two apart.
const ARABIC_LETTER = '\\u0621-\\u065F\\u0670-\\u06D3';
const NASSER_RE = new RegExp(`(?<![${ARABIC_LETTER}])ناصر(?![${ARABIC_LETTER}])`, 'g');
function templateAgentName(text, re = NASSER_RE) {
  if (!text) return { text, count: 0 };
  let count = 0;
  const out = String(text).replace(re, () => { count++; return '{{agent_name}}'; });
  return { text: out, count };
}

// The same, for جداوي (and its common misspelling جدواي), when the male
// voice's name became ناصر (2026-10-19): scenarios that wrote the old name
// out would otherwise go on introducing the agent as جداوي.
const JEDDAWI_RE = new RegExp(`(?<![${ARABIC_LETTER}])(?:جداوي|جدواي)(?![${ARABIC_LETTER}])`, 'g');
const templateJeddawi = (text) => templateAgentName(text, JEDDAWI_RE);

// Ids added via EXTRA_VOICE_IDS (comma-separated) are accepted too, so a new
// ElevenLabs voice can be enabled from Railway without a code change.
const EXTRA_VOICE_IDS = new Set(
  String(process.env.EXTRA_VOICE_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
);
const CATALOGUE_IDS = new Set(VOICES.map((v) => v.id));

function isAllowedVoiceId(id) {
  const v = String(id || '').trim();
  if (!v) return false;
  return CATALOGUE_IDS.has(v) || EXTRA_VOICE_IDS.has(v);
}

/**
 * The voice a stored id stands for today. A retired id becomes its
 * replacement; an id that is simply unknown is returned unchanged, so publish
 * still refuses it loudly instead of quietly speaking with something else.
 */
function resolveVoiceId(id) {
  const v = String(id || '').trim();
  if (!v) return null;
  if (isAllowedVoiceId(v)) return v;
  return RETIRED_VOICES[v] || v;
}

module.exports = {
  VOICES, DEFAULT_VOICE_ID, RETIRED_VOICES, isAllowedVoiceId, resolveVoiceId, templateAgentName,
  templateJeddawi,
};
