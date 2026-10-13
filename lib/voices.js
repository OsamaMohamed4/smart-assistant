// The voices a company's agent may speak with.
//
// One list, read by the settings screen, the publish step and the Playground,
// so a voice cannot be offered in one place and refused in another. Every id
// here is on the ElevenLabs account the platform publishes with: an id that is
// not is accepted by our API and fails only at publish time, as the provider's
// opaque "Couldn't Find Voice". Gender and accent are read from GET /v1/voices,
// not inferred; the labels are the names the operator gave them.
//
// The operator chose exactly these two (2026-10-12). Mona is a Voice Library
// voice and had to be added to the account before it would resolve.
const MONA    = 'o0oG1TnHDWDdKbAeBgCO';
const JEDDAWI = 'yXEnnEln9armDCyhkXcA';

const VOICES = [
  { id: MONA,    name: 'Mona',    label: 'منى',   description: 'صوت نسائي سعودي دافئ وواضح', gender: 'female', accent: 'saudi' },
  { id: JEDDAWI, name: 'Jeddawi', label: 'جداوي', description: 'صوت رجالي سعودي عميق وواثق', gender: 'male',   accent: 'saudi' },
];

// Used when a company has not picked one. Jeddawi is the voice production
// already runs on. Code is the source of truth rather than a Railway variable,
// so a stale ELEVENLABS_VOICE_ID cannot silently override it.
const DEFAULT_VOICE_ID = JEDDAWI;

// Voices that were in the catalogue before it was replaced, and what speaks in
// their place. A company saved with one of them would otherwise fail every
// publish ("unknown voice") and every settings save, so it is moved to the
// replacement instead -- from its next publish, not retroactively. Both were
// male, as is Jeddawi, so an agent's name and wording still fit its voice.
const RETIRED_VOICES = {
  MI88rOZjXbH22N8KHXUo: JEDDAWI, // Ali
  cFUFIbKkO2iZFwS8cRnY: JEDDAWI, // Nasser
};

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

module.exports = { VOICES, DEFAULT_VOICE_ID, RETIRED_VOICES, isAllowedVoiceId, resolveVoiceId };
