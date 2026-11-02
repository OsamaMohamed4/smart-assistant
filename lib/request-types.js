// The request types an agent may file, and the fields each one carries.
//
// Every type and field below comes from the client's own requirements sheet
// (متطلبات تفعيل وتشغيل الذكاء الاصطناعي.xlsx, question 10), in their wording --
// except maintenance, whose fields are those of Estate's maintenance form (its
// guide of 2026-11-01, relayed by the client), where the request goes. Nothing
// is inferred: a complaint has no type, its fields never having been given.
//
// `options`: Estate keeps these as choices, not words (lib/estate-options.js),
// so the model picks from Estate's own names and each maps to Estate's id.
//
// Why "appointments" became "requests": the same sheet answers the booking
// questions with "فوري (كرفع طلب)" for duration, an unlimited number in
// parallel, and "تم رفع طلب وسيتم التواصل معك خلال 72 ساعة عمل" as the lead
// time. There are no slots to allocate. What the client calls an appointment is
// a request their sales team follows up on, so that is what gets built.
//
// No field is enforced as mandatory. The sheet asked which ones were and the
// answer did not say, and turning away a real lead because one answer was
// missing is the worse failure: the caller's number is attached from the call
// record regardless, so even a sparse request can be followed up. The agent is
// told to gather every field; the server keeps whatever it got.

// Shared definitions, so a field means the same thing in every type it
// appears in and reads the same in the dashboard.
const EO = require('./estate-options');

const F = {
  customer_name   : { labelAr: 'الاسم', descriptionAr: 'اسم العميل الكريم' },
  interest_status : {
    labelAr: 'حالة الاهتمام',
    descriptionAr: 'حالة اهتمام العميل: «مهتم» إن كان يريد الشراء الآن، و«محتمل» إن كان متردداً أو يقارن، و«مهتم مستقبلاً» إن كان يريد الشراء لاحقاً',
    options: EO.INTEREST_STATUS.map((x) => x.name),
  },
  interest_reasons: {
    labelAr: 'أبرز أسباب الاهتمام',
    // The client's "(الموقع – السعر – المواصفات وجودة التصميم)", in Estate's words.
    descriptionAr: `أبرز أسباب اهتمام العميل، واحد أو أكثر من: ${EO.INTEREST_REASONS.map((x) => x.name).join('، ')}. افصل بينها بفاصلة`,
  },
  property_type   : { labelAr: 'نوع العقار', descriptionAr: 'نوع العقار الذي يبحث عنه العميل', options: ['فيلا', 'دور', 'شقة', 'تاون هاوس', 'مكتب', 'معرض تجاري'] },
  purchase_reason : { labelAr: 'سبب الشراء', descriptionAr: 'سبب رغبة العميل في الشراء', options: ['سكن', 'استثمار'] },
  payment_method  : { labelAr: 'طريقة الدفع', descriptionAr: 'طريقة الدفع التي يفضلها العميل', options: ['كاش', 'تمويل بنكي'] },
  referral_source : { labelAr: 'كيف سمعت عنا', descriptionAr: 'كيف عرف العميل عن الشركة، الأقرب لما قاله', options: EO.HOW_HEARD.map((x) => x.name) },
  unit_area       : { labelAr: 'المساحة المطلوبة للوحدة', descriptionAr: 'مساحة الوحدة التي يحتاجها العميل، بالمتر المربع كما ذكرها' },
  business_activity: { labelAr: 'نوع النشاط التجاري', descriptionAr: 'نوع النشاط التجاري الذي ستُستخدم له الوحدة' },
  // Estate files an office and a shop apart (the rental guide's `type`).
  rental_category : { labelAr: 'قسم التأجير', descriptionAr: 'مكتبي إن كانت الوحدة مكتباً، وتجاري إن كانت محلاً أو معرضاً', options: ['مكتبي', 'تجاري'] },
  // Not on the requirements sheet: Estate, the client's ERP, needs it for a
  // lead (its reply of 2026-10-21: name, phone, the project, notes). Its code
  // (W-38) is made from the number the customer gave (services/estate.js).
  project         : { labelAr: 'المشروع المهتم به', descriptionAr: 'المشروع الذي يهتم به العميل، باسمه أو برقمه كما ذكره هو، مثل: وكن 38. اتركه فارغاً إن لم يحدد مشروعاً' },
  // Whatever else the customer asked for that has no field of its own ("إيجار
  // منتهٍ بالتمليك"): kept apart, so a choice above stays a choice.
  customer_notes  : { labelAr: 'ملاحظات العميل', descriptionAr: 'أي تفصيل آخر طلبه العميل يخص طلبه وليس له حقل هنا' },
  // Maintenance: where the unit is, as the customer names it -- Estate's ids
  // for it are looked up when the request is sent (services/estate.js).
  residence_project: { labelAr: 'المشروع', descriptionAr: 'المشروع الذي فيه وحدة العميل، باسمه أو برقمه كما ذكره، مثل: مهير 10' },
  building        : { labelAr: 'المبنى', descriptionAr: 'المبنى أو العمارة كما ذكرها العميل، مثل: A أو مبنى ب' },
  unit            : { labelAr: 'رقم الوحدة', descriptionAr: 'رقم الوحدة أو الشقة كما ذكره العميل. يُترك فارغاً للفيلا' },
  maintenance_issue: { labelAr: 'نوع المشكلة', descriptionAr: 'نوع مشكلة الصيانة، الأقرب لما وصفه العميل', options: EO.MAINTENANCE_ISSUES.map((x) => x.name) },
  issue_description: { labelAr: 'وصف المشكلة', descriptionAr: 'وصف المشكلة كما شرحها العميل' },
};

const REQUEST_TYPES = {
  // "طلب الاهتمام (حالة الاهتمام - الاسم - رقم الجوال - أبرز أسباب الاهتمام -
  //  نوع العقار - سبب الشراء - طريقة الدفع - كيف سمعت عنا)"
  interest: {
    labelAr: 'طلب اهتمام',
    fields: ['interest_status', 'customer_name', 'project', 'interest_reasons', 'property_type',
      'purchase_reason', 'payment_method', 'referral_source', 'customer_notes'],
  },
  // "طلب التأجير: اسمك الكريم، رقم الجوال، ما المساحة المطلوبة للوحدة؟،
  //  ما أبرز أسباب اهتمامك؟، كيف سمعت عنا؟"
  leasing: {
    labelAr: 'طلب تأجير',
    fields: ['customer_name', 'unit_area', 'interest_reasons', 'referral_source', 'customer_notes'],
  },
  // "بيانات مطلوبة (التأجير المكتبي والتجاري): اسمك الكريم، رقم الجوال،
  //  مساحة الوحدة، نوع النشاط التجاري، ما أبرز أسباب اهتمامك؟، كيف سمعت عنا"
  leasing_commercial: {
    labelAr: 'طلب تأجير مكتبي أو تجاري',
    fields: ['customer_name', 'rental_category', 'unit_area', 'business_activity', 'interest_reasons', 'referral_source', 'customer_notes'],
  },
  // Estate's maintenance form: the project, building and unit, the problem
  // type, a description, and who reported it.
  maintenance: {
    labelAr: 'طلب صيانة',
    fields: ['customer_name', 'residence_project', 'building', 'unit', 'maintenance_issue', 'issue_description'],
  },
};

// "رقم الجوال" appears in every list above and is deliberately absent from the
// field arrays: question 11 answers "اعتمد مباشره", so it is never asked for
// and never taken from the model. It comes from the call record, which the
// provider fills from the line itself.

// Statuses a request moves through once a person picks it up. Question 37
// ("تحفظ") says changes are stored for staff review rather than applied, so a
// request lands as `new` and only a person moves it on.
const STATUSES = {
  new      : 'جديد',
  in_review: 'قيد المراجعة',
  contacted: 'تم التواصل',
  closed   : 'مغلق',
};

const FIELD_MAX = 500;

/**
 * Keep only the fields this type defines, as trimmed, bounded strings.
 * Everything the model sends is untrusted text: unknown keys are dropped
 * rather than stored, so a model that invents a field cannot widen the record.
 */
function pickFields(type, body) {
  const def = REQUEST_TYPES[type];
  if (!def) return null;
  const out = {};
  for (const key of def.fields) {
    const v = body?.[key];
    if (v === undefined || v === null) continue;
    const s = String(v).replace(/\s+/g, ' ').trim().slice(0, FIELD_MAX);
    if (s) out[key] = s;
  }
  return out;
}

module.exports = { REQUEST_TYPES, FIELDS: F, STATUSES, pickFields, FIELD_MAX };
