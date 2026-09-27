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

  // ── Declared for the roadmap; the server refuses to enable these. ──
  // Kept as separate capabilities from the company's point of view even where
  // they will later share backend infrastructure — the client's configuration
  // should not expose our internal groupings.
  { key: 'appointment_booking', labelAr: 'حجز المواعيد',        descriptionAr: 'حجز المواعيد للعملاء أثناء المكالمة.',              status: 'planned', kind: 'webhook' },
  { key: 'request_creation',    labelAr: 'استقبال الطلبات',      descriptionAr: 'تسجيل طلبات العملاء وإحالتها للفريق المختص.',       status: 'planned', kind: 'webhook' },
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
};
