// The capability registry: what a company's agent is ALLOWED to do.
//
// Configuration, not branches. Adding a capability means adding an entry here
// plus a handler — it must never mean another `if` in the publish pipeline or
// another column on `companies`.
//
// Two states matter and are not the same thing:
//
//   status: 'implemented'  the backend can actually perform it
//   status: 'planned'      declared so the UI can show the roadmap, but the
//                          server REFUSES to enable it. A planned capability
//                          can never produce a tool, so a half-built feature
//                          cannot reach a caller.
//
// `defaultEnabled` exists for one specific reason. Before this registry,
// knowledge_base and call_transfer were implicit — attached whenever their data
// happened to be present. If "no row" meant "disabled", every existing company
// would silently lose its knowledge-base tool the next time it published. So
// those two default to enabled: absent configuration means "behave exactly as
// before", and `requires` still decides whether a tool is actually attached.

const KB_TOOL_DESCRIPTION = 'البحث في قاعدة معرفة الشركة عن معلومة محددة (أسعار، مشاريع، مواصفات، عروض) عندما لا تكون المعلومة متوفرة في تعليماتك. استخدمها قبل أن تقول إن المعلومة غير متوفرة.';

const { REQUEST_TYPES, FIELDS } = require('../../lib/request-types');

/**
 * The request tool's body, generated from lib/request-types.js so the schema
 * the model sees can never drift from the fields the server keeps.
 *
 * The caller's phone number is deliberately NOT a property. Question 11 says
 * to take it directly from the call; it is joined from the call record, which
 * the provider fills from the line itself, so the model can neither be asked
 * for it nor supply a different one.
 */
function requestBodyProperties(projects = []) {
  const types = Object.keys(REQUEST_TYPES);
  const props = {
    request_type: {
      type: 'string',
      enum: types,
      description: 'نوع الطلب: ' + types.map((t) => `${t} = ${REQUEST_TYPES[t].labelAr}`).join('، '),
    },
    customer_confirmed: {
      type: 'boolean',
      description: 'true فقط إذا قرأت البيانات على العميل وأكدها صراحة',
    },
  };
  const all = new Set(types.flatMap((t) => REQUEST_TYPES[t].fields));
  for (const key of all) {
    props[key] = { type: 'string', description: FIELDS[key].descriptionAr };
  }
  // A company that lists its projects (for Estate) has the model pick one by
  // name, so the name maps to the project's code exactly; never one off the list.
  const names = [...new Set((projects || []).map((p) => p.name).filter(Boolean))];
  if (props.project && names.length) {
    props.project = {
      type: 'string',
      enum: names,
      description: 'المشروع الذي يهتم به العميل، من هذه القائمة فقط، سواء ذكره باسمه أو برقمه. إن لم يحدد العميل مشروعاً منها فاترك الحقل فارغاً.',
    };
  }
  return props;
}

// The client's answer to question 31: interest and a visit with a sales
// representative both need the customer's explicit confirmation. Said in the
// tool's own description, because that is what the model reads at the moment
// it decides whether to call — not in the operator's scenario, which this
// system does not write into. `source` is where the customer's number is taken
// from: the call, or the WhatsApp conversation.
const requestToolDescription = (source = 'المكالمة') =>
  'سجّل طلب العميل (اهتمام بالشراء، أو تأجير سكني، أو تأجير مكتبي/تجاري) ليتابعه فريق المبيعات. '
  + 'اجمع الحقول المطلوبة لنوع الطلب، ثم اقرأ البيانات على العميل واطلب تأكيده الصريح، '
  + `ولا تستدعِ الأداة قبل أن يؤكد. لا تسأل عن رقم الجوال — يُسجَّل تلقائياً من ${source}.`;

// The company's projects as it listed them for Estate (services/estate.js).
// Lazy: estate.js needs lib/request-types too, and nothing here needs it at load.
const companyProjects = (company) => require('../estate').settingsOf(company).projects;

/**
 * @typedef {object} Feature
 * @property {string}  key            stable id, also the company_features row key
 * @property {string}  labelAr        client-facing name (business terms, not internals)
 * @property {string}  descriptionAr  one line for the admin UI
 * @property {'implemented'|'planned'} status
 * @property {'webhook'|'system'} kind webhook => a provider tool; system => a
 *                                     built-in provider tool with no endpoint
 * @property {?string} endpoint        path segment under /webhook/elevenlabs/tools/
 * @property {?string} toolName        the name the model sees
 * @property {boolean} defaultEnabled  applies when the company has no explicit row
 * @property {?function} requires      (ctx) => true | string reason-it-cannot-attach
 */
const FEATURES = [
  {
    key: 'knowledge_base',
    labelAr: 'قاعدة المعرفة',
    descriptionAr: 'البحث في مستندات الشركة أثناء المكالمة للإجابة بمعلومات رسمية.',
    status: 'implemented',
    kind: 'webhook',
    // DELIBERATELY 'kb', not 'knowledge_base'. This path is baked into the tool
    // config of every already-published agent; renaming it would break live
    // companies until each was republished, for no gain.
    endpoint: 'kb',
    toolName: 'search_knowledge_base',
    toolDescriptionAr: KB_TOOL_DESCRIPTION,
    responseTimeoutSecs: 10,
    // The ONLY model-authored field. Everything else on the request is filled
    // by the provider from its own system variables.
    bodyProperties: {
      query: { type: 'string', description: 'نص السؤال أو الكلمات المفتاحية للبحث' },
    },
    bodyRequired: ['query'],
    defaultEnabled: true,
    requires: (ctx) => {
      if (!ctx.publicBaseUrl) return 'PUBLIC_BASE_URL غير مضبوط';
      if (!(ctx.kbChunkCount > 0)) return 'لا توجد مستندات مفهرسة';
      return true;
    },
  },
  {
    key: 'call_transfer',
    labelAr: 'تحويل المكالمات',
    descriptionAr: 'تحويل المكالمة إلى موظف بشري عند الحاجة.',
    status: 'implemented',
    // A provider-native tool: no endpoint of ours, so nothing to authenticate
    // and nothing to store in company_tools.
    kind: 'system',
    endpoint: null,
    toolName: 'transfer_to_number',
    defaultEnabled: true,
    requires: (ctx) => (ctx.transferNumber ? true : 'لم يُضبط رقم التحويل في الإعدادات'),
  },

  {
    key: 'request_creation',
    labelAr: 'استقبال الطلبات',
    descriptionAr: 'تسجيل طلبات العملاء (اهتمام، تأجير) وإحالتها لفريق المبيعات للمتابعة.',
    status: 'implemented',
    kind: 'webhook',
    endpoint: 'request',
    toolName: 'submit_customer_request',
    toolDescriptionAr: requestToolDescription('المكالمة'),
    responseTimeoutSecs: 10,
    bodyProperties: requestBodyProperties(),
    // Per company at publish: its project list becomes the project field's choices.
    bodyPropertiesFor: (company) => requestBodyProperties(companyProjects(company)),
    bodyRequired: ['request_type', 'customer_confirmed'],
    // Opt-in. A capability that files records on a company's behalf must be
    // switched on by someone who decided they want it, never appear on every
    // agent because the code shipped.
    defaultEnabled: false,
    requires: (ctx) => (ctx.publicBaseUrl ? true : 'PUBLIC_BASE_URL غير مضبوط'),
  },

  // ── Declared for the roadmap; the server refuses to enable these. ──
  // Kept as separate capabilities from the company's point of view even where
  // they will later share backend infrastructure — the client's configuration
  // should not expose our internal groupings.
  //
  // appointment_booking stays planned: the client's answers describe request
  // capture, not slot allocation, and every calendar question (lead time,
  // horizon, buffers, alternatives, holidays, cancellation, rescheduling) was
  // answered "مب الان".
  { key: 'appointment_booking', labelAr: 'حجز المواعيد',        descriptionAr: 'حجز المواعيد للعملاء أثناء المكالمة.',              status: 'planned', kind: 'webhook' },
  { key: 'ticket_creation',     labelAr: 'فتح البلاغات',         descriptionAr: 'فتح بلاغ أو شكوى وتتبّعها.',                        status: 'planned', kind: 'webhook' },
  { key: 'customer_update',     labelAr: 'تحديث بيانات العملاء', descriptionAr: 'تحديث بيانات العميل في سجلات الشركة.',              status: 'planned', kind: 'webhook' },
  { key: 'send_message',        labelAr: 'إرسال الرسائل',        descriptionAr: 'إرسال رسالة للعميل من قوالب معتمدة.',               status: 'planned', kind: 'webhook' },
  { key: 'workflow_action',     labelAr: 'تنفيذ الإجراءات',      descriptionAr: 'تنفيذ إجراء تشغيلي معرّف مسبقاً.',                  status: 'planned', kind: 'webhook' },
  { key: 'system_integration',  labelAr: 'الربط مع الأنظمة',     descriptionAr: 'الاتصال بأنظمة الشركة الداخلية.',                   status: 'planned', kind: 'webhook' },
  { key: 'data_exchange',       labelAr: 'تبادل البيانات',       descriptionAr: 'قراءة بيانات من أنظمة الشركة أثناء المكالمة.',      status: 'planned', kind: 'webhook' },
];

const BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));
const BY_ENDPOINT = new Map(FEATURES.filter((f) => f.endpoint).map((f) => [f.endpoint, f]));

const getFeature   = (key) => BY_KEY.get(String(key || '')) || null;
const featureByEndpoint = (ep) => BY_ENDPOINT.get(String(ep || '')) || null;
const isImplemented = (key) => getFeature(key)?.status === 'implemented';
const allFeatures  = () => FEATURES.slice();

/** Keys a company may actually turn on. Anything else is refused server-side. */
const enableableKeys = () => FEATURES.filter((f) => f.status === 'implemented').map((f) => f.key);

module.exports = {
  FEATURES, getFeature, featureByEndpoint, isImplemented, allFeatures, enableableKeys,
  requestToolDescription,
};
