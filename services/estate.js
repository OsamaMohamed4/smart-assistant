// Estate (e-statee.com): the real-estate ERP the client's companies run their
// sales in, each on its own address (Maheer's is maher.e-statee.com). A
// request the agent files on a call goes on to the company's Estate as a new
// attention request -- a lead -- through the endpoint Estate documents for
// Make & Zapier (https://api-docs.e-statee.com/new-attention-request-19392637e0):
//
//   POST {company's Estate}/api/v1/make/attention-request/attention-request-store
//   Authorization: Bearer {the company's Estate API key}
//   form-encoded body
//
// What Estate asked for, in its reply of 2026-10-21 (relayed by the client):
// the customer's name, phone, the project they are interested in, and their
// notes; rooms, district, budget and the like when the call has them; no
// email and no campaign data. `platform` is `ai_chat`. The project goes as
// its short code in project_codes[0] (M-10 for Maheer, W-38 for Wakan), not
// as an id. Both companies' projects live on one Estate, Maheer's address,
// with one key -- told apart by the project code.
//
// What goes, and what does not:
//   - Purchase-interest requests only. That endpoint makes sales leads; Estate
//     keeps rental requests in a module of their own, not linked here.
//   - name, phone (from the call record, never from the model), platform,
//     project_codes[0] when the customer named a project on the company's
//     list, and note: every answer the customer gave, labelled as on the
//     requests page. The call collects no rooms, district or budget, so none
//     is sent; whatever the customer said goes in the note.
//   - The project list -- name as the agent offers it, Estate's code -- is set
//     per company by a superadmin. The model picks from those names (the
//     request tool's enum, rebuilt on «نشر»), so a name maps to its code
//     exactly; nothing is guessed from free text.
//   - After the call ends: the customer's number is attached from the call
//     record, which exists only then. A request made on WhatsApp carries the
//     WhatsApp number instead, and goes as soon as the customer confirms it
//     (services/whatsapp/requests.js).
//
// Nothing is sent until a superadmin has set the address, the key and the
// platform value and switched it on. Every attempt, and why one did not go,
// is kept on the request (estate_status / estate_detail).
//
// Three kinds of request, three endpoints (Estate's guides of 2026-11-01):
//   - purchase interest: the Make & Zapier endpoint above, with the API key.
//     Its choices (property type, reason for buying, payment, how they heard)
//     go as fields Estate resolves by name; the rest goes in the note.
//   - rental interest, residential, commercial or office: the system endpoint
//     /api/v1/system/rental-attention-requests/store, with the API key and a
//     secret key (x-api-key, x-secret-key), its choices by Estate's ids.
//   - maintenance: /api/v1/system/maintenance-requests/store, same keys. It
//     takes the unit by Estate's own ids -- project, building, unit -- which
//     are looked up in Estate's maintenance form data from what the customer
//     said (locateUnit). What cannot be matched is not guessed: the request
//     stays on the requests page, with the reason.
// Each kind is switched on apart.
//
// deps.post / deps.postSystem / deps.getSystem (and check's `send…`) replace
// the HTTP calls in tests; production always uses the functions below, with
// their SSRF check.
const axios = require('axios');
const { assertSafeUrl } = require('../lib/ssrf');
const { REQUEST_TYPES, FIELDS } = require('../lib/request-types');
const EO = require('../lib/estate-options');

const PATH = '/api/v1/make/attention-request/attention-request-store';
const SYSTEM = {
  rental        : '/api/v1/system/rental-attention-requests/store',
  maintenance   : '/api/v1/system/maintenance-requests/store',
  maintenanceForm: '/api/v1/system/maintenance-requests/get-form-data',
};
const TIMEOUT_MS = 15_000;
// Which endpoint each request type goes to.
const SCOPE_OF = { interest: 'interest', leasing: 'rental', leasing_commercial: 'rental', maintenance: 'maintenance' };
const SCOPE_LABEL = { interest: 'طلبات الاهتمام', rental: 'طلبات التأجير', maintenance: 'طلبات الصيانة' };
const PLATFORM_MAX = 60;
// Estate's value for a lead from the assistant (its reply of 2026-10-21).
const PLATFORM_DEFAULT = 'ai_chat';
const PROJECTS_MAX = 200;
const PROJECT_NAME_MAX = 120;
// Estate's format (its note of 2026-10-31): the company's letter, a hyphen,
// the project's number -- W-38 is Wakan's project 38, M-12 Maheer's 12.
const PROJECT_CODE = /^[A-Z]{1,4}-\d{1,6}$/;

// "https://maher.e-statee.com" from what was pasted -- the bare address or the
// full endpoint. Only an Estate address: customer details go nowhere else.
function estateOrigin(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.port || !/^[a-z0-9-]+\.e-statee\.com$/i.test(u.hostname)) return null;
  return `https://${u.hostname.toLowerCase()}`;
}

function settingsOf(company) {
  const e = company?.settings?.estate || {};
  return {
    url: estateOrigin(e.url),
    platform: String(e.platform || '').trim().slice(0, PLATFORM_MAX) || PLATFORM_DEFAULT,
    enabled: e.enabled === true,
    projects: Array.isArray(e.projects) ? e.projects.filter((p) => p?.name && p?.code) : [],
    // Interest went before the other two existed, so it stays on unless turned off.
    scopes: { interest: e.interest !== false, rental: e.rental === true, maintenance: e.maintenance === true },
  };
}

// The project list as pasted: one per line, "name = code" (the code after the
// last "="). Returns { projects } or { error } naming the line.
function parseProjects(input) {
  if (Array.isArray(input)) input = input.map((p) => `${p?.name || ''} = ${p?.code || ''}`).join('\n');
  const projects = [];
  const seen = new Set();
  const lines = String(input || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const at = line.lastIndexOf('=');
    const name = (at > 0 ? line.slice(0, at) : '').trim().replace(/\s+/g, ' ');
    const raw = (at > 0 ? line.slice(at + 1) : '').trim();
    const code = cleanCode(raw);
    if (!name || !raw) return { error: `السطر ${i + 1}: اكتبه «اسم المشروع = رمزه في Estate»` };
    if (name.length > PROJECT_NAME_MAX) return { error: `السطر ${i + 1}: اسم المشروع أطول من المسموح` };
    if (!PROJECT_CODE.test(code)) return { error: `السطر ${i + 1}: رمز المشروع «${raw.slice(0, 30)}» ليس بصيغة Estate: حرف الشركة ثم شرطة ثم رقم المشروع، مثل W-38 أو M-12` };
    const key = normalizeName(name);
    if (seen.has(key)) return { error: `السطر ${i + 1}: المشروع «${name}» مكرر` };
    seen.add(key);
    projects.push({ name, code });
  }
  if (projects.length > PROJECTS_MAX) return { error: `الحد الأعلى ${PROJECTS_MAX} مشروعاً` };
  return { projects };
}

// For matching what the model sent against the list: the enum makes it the
// same text, but spacing, diacritics and the kashida are not worth a miss.
function normalizeName(s) {
  return String(s || '').normalize('NFKC').replace(/[ً-ٰٟـ]/g, '')
    .replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
}

// A code as typed, in Estate's form: "w-38", "W–38" (another dash) and
// "W-٣٨" are all W-38. Nothing else is changed: "W38" stays wrong, to be
// written again, rather than guessed at.
function cleanCode(raw) {
  return String(raw || '').trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6F0))
    .replace(/\s*[‐-―−]\s*|\s*-\s*/g, '-')
    .toUpperCase();
}

// The Estate code for the project the customer named, or null. Sent as
// Estate writes it, whatever a list saved before the format was enforced holds.
function projectCode(value, projects) {
  const v = normalizeName(value);
  if (!v) return null;
  const hit = (projects || []).find((p) => normalizeName(p.name) === v || normalizeName(p.code) === v);
  return hit ? cleanCode(hit.code) : null;
}

// Digits with the country code, no "+" and no local 0: 966501234567,
// 966115009384. Estate asked for exactly this (2026-10-24), after a lead went
// as "+0115009384"; its docs' example (0551234567) is not what it wants.
function estatePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^966[1-9]\d{8}$/.test(d)) return d;
  if (/^0[1-9]\d{8}$/.test(d)) return `966${d.slice(1)}`;
  if (/^5\d{8}$/.test(d)) return `966${d}`;
  // A local number of any other length is not one this can place.
  if (d.startsWith('0')) return null;
  return d.length >= 8 && d.length <= 15 ? d : null;
}

function parseFields(request) {
  try { return request.fields ? JSON.parse(request.fields) || {} : {}; } catch { return {}; }
}

// Where the request was made, in words.
function sourceOf(request) {
  if (request.channel === 'whatsapp') return 'محادثة واتساب';
  if (request.call_direction === 'inbound') return 'مكالمة واردة';
  if (request.call_direction === 'outbound') return 'مكالمة صادرة';
  return 'مكالمة';
}

// The assistant the customer spoke to, as the note names it: its name and its
// company's. Both companies' leads land on one Estate, and Estate asked
// (2026-10-31) for the agent in the note to tell them apart.
function agentLabel(company) {
  if (!company) return null;
  const { fillGlobals } = require('../companies');
  const name = String(fillGlobals('{{agent_name}}', company) || '').trim();
  return [name, company.name].filter(Boolean).join(' — ') || null;
}

// Every answer the customer gave, one per line, in the client's own labels,
// under where it was made -- an inbound or outbound call, or a WhatsApp
// conversation -- and with which assistant. `omit`: answers sent as Estate's
// own choices, which would only repeat here.
function buildNote(request, fields, company = null, { omit = [] } = {}) {
  const type = REQUEST_TYPES[request.request_type];
  const agent = agentLabel(company);
  const head = `${type?.labelAr || request.request_type} من ${sourceOf(request)}`;
  const lines = agent ? [head, `المساعد الذكي: ${agent}`] : [`${head} مع المساعد الذكي`];
  const skip = new Set(['customer_name', ...omit]);
  for (const k of type?.fields || Object.keys(fields)) {
    if (skip.has(k) || !fields[k]) continue;
    lines.push(`${FIELDS[k]?.labelAr || k}: ${fields[k]}`);
  }
  return lines.join('\n');
}

// ─── Purchase interest: the Make endpoint's choices ───────────────
// Estate resolves these by name (its docs: "option id or its ar/en name").
// Each is [Estate's field, the value, our field it came from].
function paymentCode(v) {
  const s = String(v || '');
  if (/كاش|نقد/.test(s)) return 'cash';
  if (/بنك|تمويل/.test(s)) return 'bank';
  return null;
}
function interestChoices(fields) {
  const out = [];
  const pay = paymentCode(fields.payment_method);
  if (pay) out.push(['payment_method', pay, 'payment_method']);
  if (fields.property_type) out.push(['property_type', fields.property_type, 'property_type']);
  if (fields.purchase_reason) out.push(['reason_for_buy', fields.purchase_reason, 'purchase_reason']);
  const heard = EO.HOW_HEARD_BY_NAME.get(fields.referral_source);
  if (heard) out.push(['how_hear_about_us[]', heard.name, 'referral_source']);
  return out;
}

// The forms to try, in order: with the choices, and -- should Estate refuse a
// choice's name -- without them, everything in the note. A lead is never lost
// to a name Estate spells differently.
function interestForms({ request, fields, name, phone, cfg, company }) {
  const code = projectCode(fields.project, cfg.projects);
  const base = () => {
    const form = new URLSearchParams();
    form.set('name', name);
    form.set('phone', phone);
    form.set('platform', cfg.platform);
    if (code) form.set('project_codes[0]', code);
    return form;
  };
  const choices = interestChoices(fields);
  const plain = base();
  plain.set('note', buildNote(request, fields, company));
  if (!choices.length) return [plain];
  const rich = base();
  for (const [k, v] of choices) rich.append(k, v);
  rich.set('note', buildNote(request, fields, company, { omit: choices.map((c) => c[2]) }));
  return [rich, plain];
}

// ─── Rental interest: the system endpoint, by Estate's ids ────────
const RENTAL_TYPE = { 'مكتبي': 'office', 'تجاري': 'commercial' };
function rentalType(request, fields) {
  if (request.request_type === 'leasing') return 'residential';
  return RENTAL_TYPE[fields.rental_category] || 'commercial/office';
}
// "120 متر", "٣٥٠ م٢" -> a number, or null.
function areaOf(text) {
  const d = String(text || '').replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/[,٬]/g, '');
  const m = /\d+(?:\.\d+)?/.exec(d);
  return m ? Number(m[0]) : null;
}
// Estate's size option for this type, when the area falls in one of its ranges.
function rentalSizeId(type, area) {
  const n = areaOf(area);
  if (n == null) return null;
  return (EO.RENTAL_SIZES[type] || []).find((r) => n >= r.from && n <= r.to)?.id ?? null;
}
// The reasons the customer gave, as Estate's ids ("الموقع، السعر" names two).
const REASON_WORDS = [[/موقع/, 99], [/سعر/, 100], [/مواصفات|تصميم|جودة/, 101]];
function interestReasonIds(text) {
  const s = String(text || '');
  return [...new Set(REASON_WORDS.filter(([re]) => re.test(s)).map(([, id]) => id))];
}
function rentalForm({ request, fields, name, phone, cfg, company }) {
  const type = rentalType(request, fields);
  const form = new URLSearchParams();
  form.set('client[name]', name);
  form.set('client[phone]', phone);
  form.set('platform', cfg.platform);
  form.set('type', type);
  form.set('interest_status', 'interested');                 // filed only once the customer confirmed
  const size = rentalSizeId(type, fields.unit_area);
  if (size) form.set('unit_size_range_option_id', String(size));
  const omit = [];
  const heard = EO.HOW_HEARD_BY_NAME.get(fields.referral_source);
  if (heard) { form.append('how_hear_about_us[]', String(heard.id)); omit.push('referral_source'); }
  const reasons = interestReasonIds(fields.interest_reasons);
  for (const id of reasons) form.append('interested_option_ids[]', String(id));
  if (reasons.length) omit.push('interest_reasons');
  form.set('note', buildNote(request, fields, company, { omit }));
  return form;
}

// ─── Maintenance: the unit, by Estate's own ids ───────────────────
const toLatinDigits = (s) => String(s || '').replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))
  .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6F0));
const textOf = (v) => (v && typeof v === 'object' ? (v.ar || v.en || '') : String(v ?? ''));
const labelsOf = (rec) => [rec.name, rec.name_text, rec.title, rec.code, rec.project_code, rec.number]
  .map(textOf).map((s) => s.trim()).filter(Boolean);
const numbersIn = (s) => (toLatinDigits(s).match(/\d+/g) || []).map(Number);

// Every list of records in Estate's answer, by the key it came under, nested
// lists included -- the form data's shape is read, not assumed.
function listsIn(data) {
  const out = {};
  const walk = (v, key, depth) => {
    if (depth > 8 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      const recs = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x) && x.id != null);
      if (recs.length) (out[key] = out[key] || []).push(...recs);
      for (const x of v) walk(x, key, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
  };
  walk(data, '', 0);
  return out;
}
const recordsUnder = (lists, re) => {
  const seen = new Set();
  return Object.entries(lists).filter(([k]) => re.test(k)).flatMap(([, v]) => v)
    .filter((r) => (seen.has(String(r.id)) ? false : seen.add(String(r.id))));
};

// "مبنى ب", "عمارة A", "B" -> "B". Arabic letters in their abjad order.
const AR_LETTER = { 'أ': 'A', 'ا': 'A', 'ب': 'B', 'ج': 'C', 'د': 'D', 'ه': 'E', 'هـ': 'E', 'و': 'F' };
function buildingKey(s) {
  const t = toLatinDigits(s).replace(/مبنى|المبنى|عمارة|العمارة|بلوك|برج|building|block|tower/gi, '').replace(/[\s\-_.]+/g, ' ').trim();
  return (AR_LETTER[t] || t).toUpperCase();
}

const FORM_CACHE_MS = 10 * 60 * 1000;
const formCache = new Map();
async function maintenanceFormData(cfg, keys, query, deps) {
  const qs = new URLSearchParams(Object.entries(query || {}).filter(([, v]) => v != null)).toString();
  const url = `${cfg.url}${SYSTEM.maintenanceForm}${qs ? `?${qs}` : ''}`;
  const hit = formCache.get(url);
  if (hit && Date.now() - hit.at < FORM_CACHE_MS) return hit.data;
  const r = await (deps.getSystem || getSystem)(url, keys);
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`تعذّر جلب بيانات الصيانة من Estate: ${estateReason(r.status, r.data)}`);
  formCache.set(url, { at: Date.now(), data: r.data });
  if (formCache.size > 200) formCache.delete(formCache.keys().next().value);
  return r.data;
}

// The company's letter in Estate's codes (M, W), from its own project list.
const companyLetter = (cfg) => (cfg.projects || []).map((p) => /^([A-Z]+)-/.exec(String(p.code))?.[1]).find(Boolean) || null;

/**
 * Estate's ids for the unit the customer named: { projectId, buildingId,
 * unitId|null } or { error } in words. A project or a building that does not
 * match exactly one record is an error, never a guess; the unit is optional
 * to Estate (a villa has none), so an unmatched unit is left out and its
 * number stays in the description.
 */
async function locateUnit({ cfg, keys, fields, deps }) {
  const said = String(fields.residence_project || '').trim();
  if (!said) return { error: 'لا يُرسل: لم يذكر العميل المشروع' };
  const projects = recordsUnder(listsIn(await maintenanceFormData(cfg, keys, null, deps)), /project/i);
  if (!projects.length) return { error: 'لا يُرسل: لم نجد قائمة المشاريع في بيانات الصيانة من Estate' };
  const letter = companyLetter(cfg);
  const nums = numbersIn(said);
  const plainSaid = estateName(said);
  const matches = projects.filter((p) => labelsOf(p).some((l) => {
    const code = /^([A-Z]+)-0*(\d+)$/i.exec(l);
    if (code) return nums.includes(Number(code[2])) && (!letter || code[1].toUpperCase() === letter);
    return estateName(l) === plainSaid;
  }));
  if (matches.length !== 1) {
    return { error: matches.length
      ? `لا يُرسل: «${said}» يطابق أكثر من مشروع في Estate (${matches.slice(0, 4).map((p) => labelsOf(p)[0]).join('، ')})`
      : `لا يُرسل: لم نجد المشروع «${said}» بين مشاريع Estate` };
  }
  const project = matches[0];

  const inProject = listsIn(await maintenanceFormData(cfg, keys, { project_id: project.id }, deps));
  const buildings = recordsUnder(inProject, /building/i)
    .filter((b) => b.project_id == null || String(b.project_id) === String(project.id));
  let building = null;
  if (buildings.length === 1) [building] = buildings;
  else {
    const want = buildingKey(fields.building);
    const hits = want ? buildings.filter((b) => labelsOf(b).some((l) => buildingKey(l) === want)) : [];
    if (hits.length !== 1) {
      return { error: !buildings.length
        ? `لا يُرسل: لم نجد مباني المشروع «${labelsOf(project)[0]}» في Estate`
        : fields.building
          ? `لا يُرسل: لم نطابق المبنى «${fields.building}» مع مباني المشروع في Estate`
          : `لا يُرسل: لم يحدد العميل المبنى، وفي المشروع ${buildings.length} مبانٍ` };
    }
    [building] = hits;
  }

  let unitId = null;
  const unitSaid = numbersIn(fields.unit);
  if (unitSaid.length) {
    const inBuilding = listsIn(await maintenanceFormData(cfg, keys, { project_id: project.id, building_id: building.id }, deps));
    const units = recordsUnder(inBuilding, /unit/i)
      .filter((u) => u.building_id == null || String(u.building_id) === String(building.id));
    const hits = units.filter((u) => labelsOf(u).some((l) => numbersIn(l).at(-1) === unitSaid.at(-1)));
    if (hits.length === 1) unitId = hits[0].id;
  }
  return { projectId: project.id, buildingId: building.id, unitId };
}
// For comparing names: Arabic folded, no kashida or diacritics, one space.
function estateName(s) {
  return toLatinDigits(s).normalize('NFKC').replace(/[ً-ٰٟـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

async function maintenanceForm({ request, fields, name, phone, cfg, keys, company, deps }) {
  const issue = EO.MAINTENANCE_BY_NAME.get(fields.maintenance_issue);
  if (!issue) return { error: 'لا يُرسل: نوع المشكلة ليس من قائمة الصيانة في Estate' };
  const where = await locateUnit({ cfg, keys, fields, deps });
  if (where.error) return where;
  const form = new URLSearchParams();
  form.set('project_id', String(where.projectId));
  form.set('building_id', String(where.buildingId));
  if (where.unitId != null) form.set('unit_id', String(where.unitId));
  form.append('option_id[]', String(issue.optionId));
  if (issue.subOptionId) form.append('sec_option_id[]', String(issue.subOptionId));
  form.set('title', issue.name.slice(0, 100));
  // The customer's own words, then the rest of what was said -- the unit as
  // named when its id was not found, the assistant, the source.
  const extra = buildNote(request, fields, company, { omit: ['maintenance_issue', 'issue_description', ...(where.unitId != null ? ['unit'] : [])] });
  form.set('description', [fields.issue_description, extra].filter(Boolean).join('\n\n'));
  if (name) form.set('applicant_name', name);
  form.set('applicant_phone', phone);
  return { form };
}

function buildForm({ name, phone, platform, projectCode: code, note }) {
  const form = new URLSearchParams();
  form.set('name', name);
  form.set('phone', phone);
  form.set('platform', platform);
  if (code) form.set('project_codes[0]', code);
  form.set('note', note);
  return form;
}

// Estate's answer in words: its validation errors, or its message.
function estateReason(status, data) {
  if (status === 401 || status === 403) {
    return `رفض Estate المفتاح${typeof data?.message === 'string' && data.message ? ` (${data.message.slice(0, 200)})` : ''}`;
  }
  if (status === 404) return 'لا توجد واجهة الطلبات هذه على عنوان Estate المحفوظ';
  const errs = data && typeof data.errors === 'object' && data.errors
    ? Object.values(data.errors).flat().filter(Boolean) : [];
  const text = errs.length ? errs.slice(0, 8).join(' — ') : (typeof data?.message === 'string' ? data.message : '');
  return String(text || `HTTP ${status}`).slice(0, 500);
}

// Accepted: a 2xx that does not itself say it failed (the system endpoints
// say so as the string "false").
const accepted = (r) => r.status >= 200 && r.status < 300 && r.data?.status !== false && r.data?.status !== 'false';

// The key as Estate issued it. Copied out of an Arabic chat or e-mail, a key
// picks up what does not show: direction marks (U+200E/F, U+202A-E,
// U+2066-9), zero-width characters, a BOM, non-breaking spaces, a line break,
// quotes around it -- and sometimes the word "Bearer". Any of them makes
// Estate answer "header api-key is missing or not correct". A key has none.
const HIDDEN = /[​-‏‪-‮⁠-⁩﻿ ]/g;
function cleanKey(token) {
  const QUOTES = /^["'`«»\s]+|["'`«»\s]+$/g;
  return String(token || '').replace(HIDDEN, '').replace(QUOTES, '')
    .replace(/^bearer\s+/i, '')
    .replace(/\s+/g, '')
    .replace(QUOTES, '');
}
const bareKey = cleanKey;

// Enough of the saved key to compare with what Estate sent, and no more.
function keyHint(token) {
  const k = cleanKey(token);
  if (!k) return null;
  const head = Math.min(3, Math.floor(k.length / 4));
  const tail = Math.min(2, Math.floor(k.length / 6));       // slice(-0) would be all of it
  return {
    length: k.length,
    start: k.slice(0, head),
    end: tail ? k.slice(-tail) : '',
    cleaned: k !== String(token || ''),
  };
}

// Estate's docs say Bearer, but its server reads the key from an `api-key`
// header: with Bearer alone it answers 403 "header api-key is missing or not
// correct" (seen live on maher.e-statee.com, 2026-10-22). Both are sent.
function estateHeaders(token) {
  const key = bareKey(token);
  return {
    'api-key': key,
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

async function post(origin, token, form) {
  const url = origin + PATH;
  await assertSafeUrl(url);
  return axios.post(url, form.toString(), {
    headers: estateHeaders(token),
    timeout: TIMEOUT_MS,
    maxRedirects: 0,
    validateStatus: () => true,
  });
}

// The system endpoints (rental, maintenance): the API key and the secret key,
// each in its header; X-Requested-With so an error comes back as JSON.
function systemHeaders(keys) {
  return {
    'x-api-key': bareKey(keys?.key),
    'x-secret-key': bareKey(keys?.secret),
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json',
  };
}

// multipart/form-data, as those endpoints document. Each repeated key
// (how_hear_about_us[]) goes as its own part.
async function postSystem(url, keys, form) {
  await assertSafeUrl(url);
  const body = new FormData();
  for (const [k, v] of form) body.append(k, v);
  const res = await fetch(url, { method: 'POST', headers: systemHeaders(keys), body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
async function getSystem(url, keys) {
  await assertSafeUrl(url);
  const res = await fetch(url, { headers: systemHeaders(keys), redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const unreachable = (e) => (/^blocked url:/.test(e.message)
  ? 'عنوان Estate المحفوظ غير مسموح'
  : `تعذّر الوصول إلى Estate: ${e.code || e.message}`).slice(0, 500);

// The company's API key and secret key, decrypted.
async function keysOf(company, deps) {
  const row = await deps.sql.getCompanyEstateToken.get(company.id);
  return { key: deps.decryptField(row?.estate_token) || null, secret: deps.decryptField(row?.estate_secret) || null };
}

// Ready to send: everything a superadmin sets is set. The secret key is
// needed only by rental and maintenance, and is checked there.
async function readiness(company, deps) {
  const cfg = settingsOf(company);
  const { key, secret } = await keysOf(company, deps);
  return { ...cfg, token: key, secret, ready: !!(cfg.enabled && cfg.url && cfg.platform && key) };
}

// One request on to Estate. `retry` takes back one that failed or was
// skipped; a request already sent, or being sent, is never sent again.
async function pushRequest(company, request, deps, { retry = false } = {}) {
  const { sql, logger } = deps;
  const cfg = await readiness(company, deps);
  if (!cfg.ready) return { skipped: 'not configured' };

  const claim = await sql.claimRequestEstate.run({ id: request.id, company_id: company.id, retry: retry ? 1 : 0 });
  if (!claim.changes) return { duplicate: true };
  const finish = (status, detail) => sql.finishRequestEstate.run({ id: request.id, company_id: company.id, status, detail });
  const skip = async (detail) => { await finish('skipped', detail); return { skipped: detail }; };

  const scope = SCOPE_OF[request.request_type];
  if (!scope) return skip('لا يُرسل: ليس لهذا النوع من الطلبات واجهة في Estate');
  if (!cfg.scopes[scope]) return skip(`لا يُرسل: إرسال ${SCOPE_LABEL[scope]} إلى Estate غير مفعّل لهذه الشركة`);
  if (scope !== 'interest' && !cfg.secret) return skip(`لا يُرسل: ${SCOPE_LABEL[scope]} تحتاج المفتاح السري (x-secret-key)، ولم يُحفظ لهذه الشركة`);
  const fields = parseFields(request);
  const name = String(request.customer_name || fields.customer_name || '').trim();
  // Estate's maintenance form takes a request without a name; the others do not.
  if (!name && scope !== 'maintenance') return skip('لا يُرسل: الطلب بلا اسم عميل، وEstate يشترط الاسم');
  const phone = estatePhone(deps.decryptField(request.caller_number));
  if (!phone) return skip('لا يُرسل بعد: رقم العميل يُضاف من سجل المكالمة عند انتهائها');

  try {
    const ctx = { request, fields, name, phone, cfg, company, keys: { key: cfg.token, secret: cfg.secret }, deps };
    // Each attempt: where it goes, and the form. More than one for interest:
    // the second, without Estate's choices, if Estate refuses one by name.
    let attempts;
    if (scope === 'interest') {
      attempts = interestForms(ctx).map((form) => () => (deps.post || post)(cfg.url, cfg.token, form));
    } else {
      const built = scope === 'rental' ? { form: rentalForm(ctx) } : await maintenanceForm(ctx);
      if (built.error) return skip(built.error);
      attempts = [() => (deps.postSystem || postSystem)(`${cfg.url}${SYSTEM[scope]}`, ctx.keys, built.form)];
    }
    let r;
    for (let i = 0; i < attempts.length; i++) {
      r = await attempts[i]();
      if (accepted(r) || r.status !== 422) break;
    }
    if (accepted(r)) {
      await finish('sent', typeof r.data?.message === 'string' ? r.data.message.slice(0, 300) : null);
      logger.info('estate: request sent', { companyId: company.id, requestId: request.id, scope });
      return { sent: true };
    }
    const reason = estateReason(r.status, r.data);
    await finish('failed', reason);
    logger.warn('estate: request refused', { companyId: company.id, requestId: request.id, scope, status: r.status, reason });
    return { failed: reason };
  } catch (e) {
    // Estate's own words, where they are (the maintenance form data refused).
    if (/^تعذّر جلب بيانات الصيانة/.test(e.message)) {
      await finish('failed', e.message.slice(0, 500));
      return { failed: e.message };
    }
    const reason = unreachable(e);
    await finish('failed', reason);
    logger.warn('estate: request not sent', { companyId: company.id, requestId: request.id, err: e.message });
    return { failed: reason };
  }
}

// After a call: every request filed during it. Never throws into the call
// pipeline; each outcome is on its request.
async function afterCall(company, call, deps) {
  if (!settingsOf(company).enabled) return [];
  const rows = await deps.sql.listRequestsForEstate.all(company.id, String(call.id));
  const out = [];
  for (const r of rows) out.push(await pushRequest(company, r, deps));
  return out;
}

// Checks the address and the key with a request that carries no fields:
// Estate refuses it (422) and names the fields it enforces -- which is also
// how its real requirements, as opposed to its docs', come to light. Auth is
// checked before validation, so a 422 means the key was accepted.
//
// With the secret key saved, the two system endpoints are checked too: rental
// the same way (an empty request, refused with the fields it enforces), and
// maintenance by reading its form data -- what the unit lookup will read --
// and counting the projects, buildings and units found in it.
async function checkEmptyStore(fn, what) {
  try {
    const r = await fn();
    if (r.status === 401 || r.status === 403) return { ok: false, text: `${what}: ${estateReason(r.status, r.data)}. تأكد أن المفاتيح المحفوظة هي التي أعطاك إياها Estate، منسوخة كاملة.` };
    if (r.status === 404) return { ok: false, text: `${what}: لا توجد واجهة الطلبات هذه على عنوان Estate المحفوظ. تأكد من العنوان.` };
    if (r.status === 422) return { ok: true, text: `${what}: المفتاح مقبول. يشترط Estate في الطلب: ${estateReason(422, r.data)}` };
    if (accepted(r)) return { ok: true, warn: true, text: `${what}: قبل Estate طلباً بلا بيانات، فربما أنشأ طلباً فارغاً. احذفه من Estate.` };
    return { ok: false, text: `${what}: ردّ Estate: ${estateReason(r.status, r.data)}` };
  } catch (e) {
    return { ok: false, text: `${what}: ${unreachable(e)}` };
  }
}
async function check({ url, token, secret = null, send = post, sendSystem = postSystem, getForm = getSystem }) {
  const origin = estateOrigin(url);
  if (!origin) return { ok: false, text: 'عنوان Estate غير صالح. مثال: https://maher.e-statee.com' };
  if (!token) return { ok: false, text: 'لم يُحفظ مفتاح Estate لهذه الشركة بعد.' };
  const interest = await checkEmptyStore(() => send(origin, token, new URLSearchParams()), 'الاهتمام');
  if (!secret) return { ...interest, more: [{ ok: false, warn: true, text: 'التأجير والصيانة: احفظ المفتاح السري (x-secret-key) ليُفحصا.' }] };
  const keys = { key: token, secret };
  const rental = await checkEmptyStore(() => sendSystem(`${origin}${SYSTEM.rental}`, keys, new URLSearchParams()), 'التأجير');
  let maintenance;
  try {
    const r = await getForm(`${origin}${SYSTEM.maintenanceForm}`, keys);
    if (!(r.status >= 200 && r.status < 300)) {
      maintenance = { ok: false, text: `الصيانة: ${estateReason(r.status, r.data)}` };
    } else {
      const lists = listsIn(r.data);
      const n = (re) => recordsUnder(lists, re).length;
      const counts = { projects: n(/project/i), buildings: n(/building/i), units: n(/unit/i), categories: n(/categor/i) };
      maintenance = counts.projects
        ? { ok: true, text: `الصيانة: المفتاحان مقبولان. في بيانات الصيانة من Estate: ${counts.projects} مشروعاً، و${counts.buildings} مبنى، و${counts.units} وحدة، و${counts.categories} نوعاً من المشاكل.` }
        : { ok: false, warn: true, text: `الصيانة: المفتاحان مقبولان، لكن لم نجد قائمة المشاريع في بيانات الصيانة. ما وصل منها: ${Object.keys(lists).filter(Boolean).slice(0, 12).join('، ') || 'لا شيء'}` };
    }
  } catch (e) {
    maintenance = { ok: false, text: `الصيانة: ${unreachable(e)}` };
  }
  return { ...interest, more: [rental, maintenance] };
}

// Settings as a superadmin saves them. Returns { estate } or { error }.
function validateSettings(body, { hasToken, hasSecret = false }) {
  const b = body || {};
  const rawUrl = String(b.url || '').trim();
  const url = rawUrl ? estateOrigin(rawUrl) : null;
  if (rawUrl && !url) return { error: 'عنوان Estate غير صالح. يجب أن يكون مثل https://maher.e-statee.com' };
  const platform = String(b.platform || '').trim();
  if (platform.length > PLATFORM_MAX) return { error: 'قيمة المصدر (platform) أطول من المسموح' };
  const p = parseProjects(b.projects);
  if (p.error) return { error: p.error };
  const enabled = b.enabled === true;
  if (enabled && (!url || !hasToken)) {
    return { error: 'للتشغيل: احفظ عنوان Estate والمفتاح أولاً' };
  }
  const interest = b.interest !== false;
  const rental = b.rental === true;
  const maintenance = b.maintenance === true;
  if (enabled && (rental || maintenance) && !hasSecret) {
    return { error: 'التأجير والصيانة يحتاجان المفتاح السري (x-secret-key): احفظه أولاً' };
  }
  return { estate: { url, platform: platform || null, enabled, projects: p.projects, interest, rental, maintenance } };
}

module.exports = {
  afterCall, pushRequest, check, validateSettings, settingsOf, readiness,
  estateOrigin, estatePhone, buildNote, buildForm, estateReason, estateHeaders, systemHeaders, cleanKey, keyHint, parseProjects, projectCode,
  interestForms, rentalForm, rentalSizeId, interestReasonIds, locateUnit, listsIn, buildingKey,
  PATH, SYSTEM, PLATFORM_DEFAULT,
};
