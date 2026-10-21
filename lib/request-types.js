// The request types an agent may file, and the fields each one carries.
//
// Every type and field below comes from the client's own requirements sheet
// (متطلبات تفعيل وتشغيل الذكاء الاصطناعي.xlsx, question 10), in their wording.
// Nothing is inferred: a type that the client has not defined is not here, and
// that is deliberate — question 28 (the fields for a maintenance report or a
// complaint) is still unanswered, so neither exists yet. Adding one later is
// adding an entry, not changing code.
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
const F = {
  customer_name   : { labelAr: 'الاسم', descriptionAr: 'اسم العميل الكريم' },
  interest_status : { labelAr: 'حالة الاهتمام', descriptionAr: 'حالة اهتمام العميل كما عبّر عنها' },
  interest_reasons: {
    labelAr: 'أبرز أسباب الاهتمام',
    // The options are the client's own: "(الموقع – السعر – المواصفات وجودة التصميم)".
    descriptionAr: 'أبرز أسباب اهتمام العميل، مثل: الموقع، السعر، المواصفات وجودة التصميم',
  },
  property_type   : { labelAr: 'نوع العقار', descriptionAr: 'نوع العقار الذي يبحث عنه العميل' },
  purchase_reason : { labelAr: 'سبب الشراء', descriptionAr: 'سبب رغبة العميل في الشراء' },
  payment_method  : { labelAr: 'طريقة الدفع', descriptionAr: 'طريقة الدفع التي يفضلها العميل' },
  referral_source : { labelAr: 'كيف سمعت عنا', descriptionAr: 'كيف عرف العميل عن الشركة' },
  unit_area       : { labelAr: 'المساحة المطلوبة للوحدة', descriptionAr: 'مساحة الوحدة التي يحتاجها العميل' },
  business_activity: { labelAr: 'نوع النشاط التجاري', descriptionAr: 'نوع النشاط التجاري الذي ستُستخدم له الوحدة' },
  // Not on the requirements sheet: Estate, the client's ERP, needs it for a
  // lead (its reply of 2026-10-21: name, phone, the project, notes). When the
  // company lists its projects for Estate, the model picks from that list
  // (services/features/registry.js) and the project's code goes with the lead.
  project         : { labelAr: 'المشروع المهتم به', descriptionAr: 'المشروع الذي يهتم به العميل' },
};

const REQUEST_TYPES = {
  // "طلب الاهتمام (حالة الاهتمام - الاسم - رقم الجوال - أبرز أسباب الاهتمام -
  //  نوع العقار - سبب الشراء - طريقة الدفع - كيف سمعت عنا)"
  interest: {
    labelAr: 'طلب اهتمام',
    fields: ['interest_status', 'customer_name', 'project', 'interest_reasons', 'property_type',
      'purchase_reason', 'payment_method', 'referral_source'],
  },
  // "طلب التأجير: اسمك الكريم، رقم الجوال، ما المساحة المطلوبة للوحدة؟،
  //  ما أبرز أسباب اهتمامك؟، كيف سمعت عنا؟"
  leasing: {
    labelAr: 'طلب تأجير',
    fields: ['customer_name', 'unit_area', 'interest_reasons', 'referral_source'],
  },
  // "بيانات مطلوبة (التأجير المكتبي والتجاري): اسمك الكريم، رقم الجوال،
  //  مساحة الوحدة، نوع النشاط التجاري، ما أبرز أسباب اهتمامك؟، كيف سمعت عنا"
  leasing_commercial: {
    labelAr: 'طلب تأجير مكتبي أو تجاري',
    fields: ['customer_name', 'unit_area', 'business_activity', 'interest_reasons', 'referral_source'],
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
