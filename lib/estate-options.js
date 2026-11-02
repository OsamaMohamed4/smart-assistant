// Estate's own option lists, by name and id, for the choices a request carries
// there as choices rather than as words in its note.
//
// Source: Estate's two integration guides of 2026-11-01, relayed by the client
// ("دليل ربط طلبات الاهتمام بالتأجير" and "دليل ربط نموذج طلبات الصيانة"),
// themselves taken from Estate's get-form-data on maher.e-statee.com -- the one
// Estate both companies use. The names are Estate's, word for word; the model
// picks from them (lib/request-types.js), so a name maps to its id exactly.
// Should Estate change a list, it changes here.

// «كيف سمعت عنا؟» (how_hear_about_us).
const HOW_HEARD = [
  ['الأقرباء والأصدقاء', 1], ['إعلان', 2], ['البحث', 3], ['عميل سابق', 4], ['لوحات الطرق', 5],
  ['إعلانات المولات', 6], ['إعلانات المطارات', 7], ['لوحات المشاريع', 8], ['المعارض', 9], ['تويتر', 10],
  ['إنستجرام', 11], ['سناب شات', 12], ['يوتيوب', 13], ['إعلانات جوجل', 14], ['مؤثرين', 16],
  ['رسائل نصية', 17], ['تطبيق عقار', 21], ['أخرى', 22], ['تيك توك', 28], ['معرض وصلت', 57],
  ['سيتي سكيب العالمي', 102], ['واتساب', 154], ['اتصال', 155],
].map(([name, id]) => ({ name, id }));

// «أبرز أسباب الاهتمام» (interested_option_ids) -- the rental form's.
const INTEREST_REASONS = [
  ['موقع العقار', 99], ['السعر المناسب', 100], ['جودة التصميم والمواصفات', 101],
].map(([name, id]) => ({ name, id }));

// The rental form's unit sizes, per rental type. Estate's list has two ranges
// per type and nothing between or beyond them; a size outside both is not
// mapped (it stays, in the customer's words, in the note). The residential
// pair is named «معرض تجاري…» and «مكتب…» in Estate though typed residential:
// kept as Estate has it, by its range.
const RENTAL_SIZES = {
  residential: [{ from: 150, to: 1000, id: 103 }, { from: 1500, to: 3000, id: 104 }],
  commercial : [{ from: 150, to: 1000, id: 164 }, { from: 1500, to: 3000, id: 165 }],
  office     : [{ from: 150, to: 1000, id: 166 }, { from: 1500, to: 3000, id: 167 }],
};

// «حالة الاهتمام» (interest_status): the words the model picks, Estate's code.
const INTEREST_STATUS = [
  ['مهتم', 'interested'], ['محتمل', 'possible'], ['مهتم مستقبلاً', 'attention_in_future'],
].map(([name, code]) => ({ name, code }));

// Maintenance problem types (maintenance_categories): the main type and, under
// it, the sub-types. Every sub-type's name is unique across the list, so one
// choice -- "سباكة — مواسير" -- names both.
const MAINTENANCE = [
  { name: 'مكيفات', id: 94, subs: [['وحدات داخلية', 173], ['وحدات خارجية', 174]] },
  { name: 'أبواب', id: 95, subs: [['نوافذ', 185], ['خزائن', 186], ['أقفال', 187], ['مفصلات', 188], ['مقبض الباب', 189], ['مقبض النافذة', 190], ['الانتر كوم', 191]] },
  { name: 'دهان', id: 96, subs: [['دهانات', 192]] },
  { name: 'عزل (تسريب)', id: 97, subs: [['عزل مائي', 195]] },
  { name: 'سباكة', id: 124, subs: [['خلاطات', 175], ['مراحيض', 176], ['مواسير', 177], ['صرف صحي', 178], ['سخانات مياه', 179], ['خزان', 180]] },
  { name: 'تبليط', id: 125, subs: [['بلاط', 193], ['أرضيات', 194]] },
  { name: 'كهرباء', id: 172, subs: [['أفياش', 181], ['إنارة', 182], ['لوحات كهرباء', 183], ['أجهزة', 184]] },
  { name: 'مصاعد', id: 196, subs: [['كابينة', 197], ['باب المصعد', 198], ['نظام تشغيل', 199]] },
  { name: 'أخرى', id: 98, subs: [] },
];
const MAINTENANCE_SEP = ' — ';
// Every choice the model may make: "main — sub", or the main type alone where it has no sub-types.
const MAINTENANCE_ISSUES = MAINTENANCE.flatMap((m) => (m.subs.length
  ? m.subs.map(([sub, subId]) => ({ name: `${m.name}${MAINTENANCE_SEP}${sub}`, optionId: m.id, subOptionId: subId }))
  : [{ name: m.name, optionId: m.id, subOptionId: null }]));

const byName = (list) => new Map(list.map((x) => [x.name, x]));
const HOW_HEARD_BY_NAME = byName(HOW_HEARD);
const INTEREST_REASON_BY_NAME = byName(INTEREST_REASONS);
const INTEREST_STATUS_BY_NAME = byName(INTEREST_STATUS);
const MAINTENANCE_BY_NAME = byName(MAINTENANCE_ISSUES);

module.exports = {
  HOW_HEARD, INTEREST_REASONS, RENTAL_SIZES, INTEREST_STATUS, MAINTENANCE, MAINTENANCE_ISSUES,
  HOW_HEARD_BY_NAME, INTEREST_REASON_BY_NAME, INTEREST_STATUS_BY_NAME, MAINTENANCE_BY_NAME,
};
