// The company's FACTS — the data a caller might ask for, stored per company and
// rendered into the system prompt as a delimited block.
//
// The hard rule this module exists to enforce: it emits DATA, never behaviour.
// Nothing here tells the agent how to act, what tone to use, or what to do when
// it does not know something — that text is the operator's, written in the
// scenario, and this module never adds to it or paraphrases it.
//
// Two consequences of that rule, both deliberate:
//   · a field the operator left empty renders NOTHING. No "working hours: not
//     specified", no placeholder, no apology. An absent fact is absent.
//   · if the whole profile is empty the block itself disappears, so a company
//     that has not filled anything in gets byte-identical output to before.
//
// `extraFacts` exists so an operator can state something this schema never
// anticipated (a licence number, a service area, a partner brand) without a
// migration and without anyone hardcoding their company's specifics in here.

const { z } = require('zod');

const trimmed = (max) => z.string().trim().max(max);

// Working hours are structured rather than free text so they render
// consistently and can later answer "are you open right now" without parsing
// prose. `closed` covers the weekend line, which otherwise needs a fake range.
const workingHoursEntry = z.object({
  days  : trimmed(80),
  from  : trimmed(10).optional(),
  to    : trimmed(10).optional(),
  closed: z.boolean().optional(),
});

const businessProfileSchema = z.object({
  description: trimmed(4000).optional(),
  workingHours: z.array(workingHoursEntry).max(14).optional(),
  services: z.array(trimmed(300)).max(60).optional(),
  rules: z.array(trimmed(500)).max(60).optional(),
  extraFacts: z.array(z.object({
    label: trimmed(120),
    value: trimmed(1000),
  })).max(40).optional(),
});

/** Parse a stored profile (JSON string or object). Never throws. */
function parseBusinessProfile(raw) {
  if (!raw) return {};
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return {}; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const parsed = businessProfileSchema.safeParse(obj);
  // A profile that fails validation is treated as empty rather than partially
  // rendered: half a fact block is more dangerous than none, because the agent
  // would state the half it got as if it were complete.
  return parsed.success ? parsed.data : {};
}

const clean = (arr) => (Array.isArray(arr) ? arr.map((s) => String(s || '').trim()).filter(Boolean) : []);

function renderHours(entries) {
  const lines = [];
  for (const e of entries) {
    const days = String(e?.days || '').trim();
    if (!days) continue;
    if (e.closed) { lines.push(`- ${days}: مغلق`); continue; }
    const from = String(e.from || '').trim();
    const to   = String(e.to   || '').trim();
    if (!from && !to) continue;           // a range with no times states nothing
    lines.push(`- ${days}: ${from}${from && to ? ' - ' : ''}${to}`);
  }
  return lines;
}

/**
 * Render the facts block for ONE company.
 *
 * @param {{name?:string}} company  the tenant — its name is the only company
 *                                  column used, so this is company-scoped by
 *                                  construction and cannot leak another tenant.
 * @param {object|string} profile   stored business_profile
 * @returns {string} '' when there is nothing factual to state.
 */
function renderFactsBlock(company, profile) {
  const p = parseBusinessProfile(profile);
  const sections = [];

  const name = String(company?.name || '').trim();
  if (name) sections.push(`### الاسم\n${name}`);

  const description = String(p.description || '').trim();
  if (description) sections.push(`### نبذة\n${description}`);

  const hours = renderHours(Array.isArray(p.workingHours) ? p.workingHours : []);
  if (hours.length) sections.push(`### ساعات العمل\n${hours.join('\n')}`);

  const services = clean(p.services);
  if (services.length) sections.push(`### الخدمات\n${services.map((s) => `- ${s}`).join('\n')}`);

  const rules = clean(p.rules);
  if (rules.length) sections.push(`### قواعد العمل\n${rules.map((r) => `- ${r}`).join('\n')}`);

  const extras = (Array.isArray(p.extraFacts) ? p.extraFacts : [])
    .map((f) => ({ label: String(f?.label || '').trim(), value: String(f?.value || '').trim() }))
    .filter((f) => f.label && f.value);
  if (extras.length) {
    sections.push(`### معلومات إضافية\n${extras.map((f) => `- ${f.label}: ${f.value}`).join('\n')}`);
  }

  // Only the company NAME is present and nothing else was filled in: that is
  // not worth a block of its own — the name is already all over the scenario.
  if (sections.length <= 1) return '';

  // The heading is a LABEL, not an instruction. Compare the knowledge-base
  // block, which tells the model how to treat what follows; this one does not,
  // because doing so would be putting behaviour in the operator's mouth.
  return `\n\n---\n\n## معلومات الشركة (بيانات رسمية)\n\n${sections.join('\n\n')}\n`;
}

/** True when the profile would render nothing — used by the admin preview. */
function isEmptyProfile(company, profile) {
  return renderFactsBlock(company, profile) === '';
}

module.exports = {
  businessProfileSchema,
  parseBusinessProfile,
  renderFactsBlock,
  isEmptyProfile,
};
