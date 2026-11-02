// Requests sent on to the company's own Estate: what is sent, what is not and
// why, once per request, and what Estate said -- kept on the request.
//
// Real statements on a throwaway SQLite DB; Estate is a stub standing in for
// the HTTP call (deps.post), answering the way Estate's Laravel API does.
//
//   node --test scripts/test-estate.js
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB = path.join(require('node:os').tmpdir(), `sa-estate-${Date.now()}.db`);
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = DB;

let sql; let db; let estate;
const posts = [];
// The system endpoints (rental, maintenance): what was posted where, and
// Estate's maintenance form data.
const systemPosts = [];
let systemAnswer = () => ({ status: 200, data: { status: 'true', message: 'Operation completed successfully' } });
let formData = () => ({ status: 200, data: { status: 'true', response: { data: {} } } });
const formGets = [];
let answer = () => ({ status: 200, data: { status: true, message: 'تمت العملية بنجاح' } });
const fakePost = async (origin, token, form) => {
  posts.push({ origin, token, form: Object.fromEntries(form) });
  const a = answer();
  if (a instanceof Error) throw a;
  return a;
};
const deps = () => ({
  sql, logger: { info() {}, warn() {}, error() {} }, decryptField: (v) => v, post: fakePost,
  postSystem: async (url, keys, form) => { systemPosts.push({ url, keys, form: [...form] }); return systemAnswer(); },
  getSystem: async (url, keys) => { formGets.push({ url, keys }); return formData(url); },
});

before(() => {
  ({ sql, db } = require('../db'));
  estate = require('../services/estate');
  db.prepare("INSERT INTO companies (id, name, language, system_prompt) VALUES ('maheer', 'مهير', 'ar', '')").run();
});
after(() => {
  try { db.close(); } catch {}
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
});
beforeEach(() => {
  posts.length = 0; systemPosts.length = 0; formGets.length = 0;
  systemAnswer = () => ({ status: 200, data: { status: 'true', message: 'Operation completed successfully' } });
  answer = () => ({ status: 200, data: { status: true, message: 'تمت العملية بنجاح' } });
  configure({ url: 'https://maher.e-statee.com', platform: 'ai_chat', enabled: true, projects: PROJECTS }, 'estate-key');
});

function configure(e, token, secret = null) {
  db.prepare('UPDATE companies SET settings = ?, estate_token = ?, estate_secret = ? WHERE id = ?').run(JSON.stringify({ estate: e }), token, secret, 'maheer');
  require('../companies').invalidateCache();
}
const company = () => require('../companies').loadCompany('maheer');

let seq = 0;
function callWith(requests, number = '+966501234567') {
  const id = `conv-${++seq}`;
  db.prepare(`INSERT INTO calls (id, company_id, caller_number, duration_sec, transcript, direction, created_at)
              VALUES (?, 'maheer', ?, 60, 'وكيل: هلا', 'inbound', datetime('now'))`).run(id, number);
  for (const [type, fields] of requests) {
    db.prepare(`INSERT INTO customer_requests (company_id, conversation_id, request_type, customer_name, fields)
                VALUES ('maheer', ?, ?, ?, ?)`).run(id, type, fields.customer_name || null, JSON.stringify(fields));
  }
  return db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
}
const requestsOf = (callId) => db.prepare('SELECT * FROM customer_requests WHERE conversation_id = ? ORDER BY id').all(callId);

const PROJECTS = [{ name: 'M-10 — أدوار، حي المغرزات', code: 'M-10' }, { name: 'وكن 038 — فلل، حي النهضة', code: 'W-38' }];
const INTEREST = {
  customer_name: 'أبو فهد', interest_status: 'مهتم جداً', project: 'M-10 — أدوار، حي المغرزات', interest_reasons: 'الموقع', property_type: 'شقة',
  purchase_reason: 'سكن', payment_method: 'تمويل بنكي', referral_source: 'سناب',
};

// ─── after a call ─────────────────────────────────────────────────
test('a purchase-interest request goes to the company\'s Estate after the call, once', async () => {
  const call = callWith([['interest', INTEREST]]);
  assert.deepEqual(await estate.afterCall(await company(), call, deps()), [{ sent: true }]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].origin, 'https://maher.e-statee.com');
  assert.equal(posts[0].token, 'estate-key');
  // The customer's choices in Estate's own fields, by name.
  assert.deepEqual(Object.keys(posts[0].form), ['name', 'phone', 'platform', 'project_codes[0]', 'payment_method', 'property_type', 'reason_for_buy', 'note']);
  assert.equal(posts[0].form.payment_method, 'bank');
  assert.equal(posts[0].form.property_type, 'شقة');
  assert.equal(posts[0].form.reason_for_buy, 'سكن');
  assert.equal(posts[0].form.name, 'أبو فهد');
  assert.equal(posts[0].form.phone, '966501234567');        // as Estate asked: country code, no "+"
  assert.equal(posts[0].form.platform, 'ai_chat');
  assert.equal(posts[0].form['project_codes[0]'], 'M-10');
  assert.equal(posts[0].form.note, [
    // Where, and with which company's assistant: both companies' leads land on one Estate.
    'طلب اهتمام من مكالمة واردة', 'المساعد الذكي: ناصر — مهير',
    // What has no field of its own, and a source not on Estate's list, in words.
    'حالة الاهتمام: مهتم جداً', 'المشروع المهتم به: M-10 — أدوار، حي المغرزات', 'أبرز أسباب الاهتمام: الموقع', 'كيف سمعت عنا: سناب',
  ].join('\n'));
  const [row] = requestsOf(call.id);
  assert.equal(row.estate_status, 'sent');
  assert.equal(row.estate_detail, 'تمت العملية بنجاح');
  // The same call's event again: nothing new goes.
  assert.deepEqual(await estate.afterCall(await company(), call, deps()), [{ duplicate: true }]);
  assert.equal(posts.length, 1);
});

test('rental and maintenance stay home until switched on, and need the secret key', async () => {
  const call = callWith([['leasing', { customer_name: 'سارة', unit_area: '120' }], ['maintenance', { customer_name: 'سارة' }]]);
  await estate.afterCall(await company(), call, deps());
  assert.equal(posts.length + systemPosts.length, 0);
  assert.deepEqual(requestsOf(call.id).map((r) => [r.estate_status, /غير مفعّل/.test(r.estate_detail)]), [['skipped', true], ['skipped', true]]);
  assert.match(estate.validateSettings({ url: 'https://maher.e-statee.com', enabled: true, rental: true }, { hasToken: true }).error, /المفتاح السري/);
  configure({ url: 'https://maher.e-statee.com', enabled: true, rental: true, maintenance: true }, 'estate-key');
  const call2 = callWith([['leasing', { customer_name: 'سارة' }]]);
  await estate.afterCall(await company(), call2, deps());
  assert.match(requestsOf(call2.id)[0].estate_detail, /المفتاح السري/);
  assert.equal(systemPosts.length, 0);
});

// ─── Rental: the system endpoint, by Estate's ids ─────────────────
test('a rental request goes to the rental endpoint with both keys and Estate\'s ids', async () => {
  configure({ url: 'https://maher.e-statee.com', enabled: true, rental: true, projects: PROJECTS }, 'estate-key', 'estate-secret');
  const call = callWith([
    ['leasing', { customer_name: 'سارة', unit_area: '٣٠٠ متر', interest_reasons: 'موقع العقار، السعر المناسب', referral_source: 'إنستجرام', customer_notes: 'تفضّل الدور الأرضي' }],
    ['leasing_commercial', { customer_name: 'سارة', rental_category: 'مكتبي', unit_area: '2000', business_activity: 'مكتب محاماة', referral_source: 'أحد الأصدقاء' }],
  ]);
  assert.deepEqual(await estate.afterCall(await company(), call, deps()), [{ sent: true }, { sent: true }]);
  assert.equal(posts.length, 0, 'not the purchase endpoint');
  const [home, office] = systemPosts;
  assert.equal(home.url, 'https://maher.e-statee.com/api/v1/system/rental-attention-requests/store');
  assert.deepEqual(home.keys, { key: 'estate-key', secret: 'estate-secret' });
  const get = (p, k) => p.form.filter(([key]) => key === k).map(([, v]) => v);
  assert.deepEqual(get(home, 'client[name]'), ['سارة']);
  assert.deepEqual(get(home, 'client[phone]'), ['966501234567']);
  assert.deepEqual(get(home, 'platform'), ['ai_chat']);
  assert.deepEqual(get(home, 'type'), ['residential']);
  assert.deepEqual(get(home, 'interest_status'), ['interested']);
  assert.deepEqual(get(home, 'unit_size_range_option_id'), ['103'], '300 m² is in 150-1000');
  assert.deepEqual(get(home, 'how_hear_about_us[]'), ['11']);
  assert.deepEqual(get(home, 'interested_option_ids[]'), ['99', '100']);
  assert.match(get(home, 'note')[0], /المساحة المطلوبة للوحدة: ٣٠٠ متر\nملاحظات العميل: تفضّل الدور الأرضي/);
  assert.doesNotMatch(get(home, 'note')[0], /كيف سمعت عنا|أبرز أسباب/, 'sent as ids, not repeated');
  assert.deepEqual(get(office, 'type'), ['office']);
  assert.deepEqual(get(office, 'unit_size_range_option_id'), ['167']);
  assert.deepEqual(get(office, 'how_hear_about_us[]'), [], 'not on Estate\'s list: in the note');
  assert.match(get(office, 'note')[0], /نوع النشاط التجاري: مكتب محاماة[\s\S]*كيف سمعت عنا: أحد الأصدقاء/);
});

test('a size outside Estate\'s ranges is not forced into one', () => {
  assert.equal(estate.rentalSizeId('residential', '120 م²'), null);
  assert.equal(estate.rentalSizeId('commercial', '1200'), null);
  assert.equal(estate.rentalSizeId('commercial', '1,000'), 164);
  assert.equal(estate.rentalSizeId('office', 'كبيرة'), null);
  assert.deepEqual(estate.interestReasonIds('الموقع والمواصفات'), [99, 101]);
});

// ─── Maintenance: the unit by Estate's ids ────────────────────────
// Estate's form data: the projects, and -- asked for a project or a building
// -- its buildings and units.
const MAINT_FORM = (url) => {
  const q = new URL(url).searchParams;
  const data = { maintenance_categories: [{ id: 124, name: 'سباكة' }], projects: [
    { id: 41, name: 'مهير 10', code: 'M-10' }, { id: 42, name: 'مهير 11', code: 'M-11' }, { id: 43, name: 'وكن 10', code: 'W-10' }] };
  if (q.get('project_id') === '41') {
    data.buildings = [{ id: 501, name: 'A', project_id: 41 }, { id: 502, name: 'B', project_id: 41 }];
    if (q.get('building_id') === '502') data.units = [{ id: 9001, name: 'B - 1', building_id: 502 }, { id: 9002, name: 'B - 2', building_id: 502 }];
  }
  return { status: 200, data: { status: 'true', response: { data } } };
};

test('a maintenance request finds the unit in Estate and goes with its problem type', async () => {
  configure({ url: 'https://maher.e-statee.com', enabled: true, maintenance: true, projects: PROJECTS }, 'estate-key', 'estate-secret');
  formData = MAINT_FORM;
  const call = callWith([['maintenance', {
    customer_name: 'أبو خالد', residence_project: 'مهير ١٠', building: 'مبنى ب', unit: 'شقة 2',
    maintenance_issue: 'سباكة — مواسير', issue_description: 'تسريب مياه تحت حوض المطبخ',
  }]]);
  assert.deepEqual(await estate.afterCall(await company(), call, deps()), [{ sent: true }]);
  const [p] = systemPosts;
  assert.equal(p.url, 'https://maher.e-statee.com/api/v1/system/maintenance-requests/store');
  const form = Object.fromEntries(p.form);
  assert.equal(form.project_id, '41', 'M-10: Maheer\'s letter, not Wakan\'s W-10');
  assert.equal(form.building_id, '502', '«مبنى ب» is B');
  assert.equal(form.unit_id, '9002');
  assert.equal(form['option_id[]'], '124');
  assert.equal(form['sec_option_id[]'], '177');
  assert.equal(form.title, 'سباكة — مواسير');
  assert.match(form.description, /^تسريب مياه تحت حوض المطبخ\n\nطلب صيانة من مكالمة واردة\nالمساعد الذكي: ناصر — مهير/);
  assert.equal(form.applicant_name, 'أبو خالد');
  assert.equal(form.applicant_phone, '966501234567');
  assert.ok(formGets.length && formGets.every((g) => g.keys.secret === 'estate-secret'));
});

test('a project or building that does not match exactly one is not guessed', async () => {
  configure({ url: 'https://maher.e-statee.com', enabled: true, maintenance: true, projects: PROJECTS }, 'estate-key', 'estate-secret');
  formData = MAINT_FORM;
  const cases = [
    [{ residence_project: 'مهير 99', building: 'A' }, /لم نجد المشروع «مهير 99»/],
    [{ residence_project: 'مهير 10' }, /لم يحدد العميل المبنى، وفي المشروع 2 مبانٍ/],
    [{ residence_project: 'مهير 10', building: 'Z' }, /لم نطابق المبنى «Z»/],
    [{ residence_project: '', building: 'A' }, /لم يذكر العميل المشروع/],
  ];
  for (const [where, re] of cases) {
    const call = callWith([['maintenance', { customer_name: 'س', maintenance_issue: 'كهرباء — إنارة', ...where }]]);
    await estate.afterCall(await company(), call, deps());
    const [row] = requestsOf(call.id);
    assert.equal(row.estate_status, 'skipped', JSON.stringify(where));
    assert.match(row.estate_detail, re);
  }
  // A unit not found is left out -- Estate takes none for a villa -- and stays in the description.
  const call = callWith([['maintenance', { customer_name: 'س', maintenance_issue: 'أخرى', residence_project: 'M-10', building: 'B', unit: '77' }]]);
  await estate.afterCall(await company(), call, deps());
  const form = Object.fromEntries(systemPosts.at(-1).form);
  assert.equal(form.unit_id, undefined);
  assert.equal(form['sec_option_id[]'], undefined, '«أخرى» has no sub-type');
  assert.match(form.description, /رقم الوحدة: 77/);
  assert.equal(systemPosts.length, 1);
});

test('the check reads the rental endpoint\'s fields and counts what the maintenance data holds', async () => {
  formData = MAINT_FORM;
  const r = await estate.check({
    url: 'https://maher.e-statee.com', token: 'k', secret: 's',
    send: async () => ({ status: 422, data: { errors: { phone: ['الجوال مطلوب'] } } }),
    sendSystem: async (url, keys, form) => { systemPosts.push({ url, keys, form: [...form] }); return { status: 422, data: { errors: { 'client.name': ['الاسم مطلوب'], unit_size_range_option_id: ['المساحة مطلوبة'] } } }; },
    getForm: async (url) => MAINT_FORM(url),
  });
  assert.equal(r.ok, true);
  const [rental, maintenance] = r.more;
  assert.match(rental.text, /التأجير: المفتاح مقبول.*الاسم مطلوب — المساحة مطلوبة/);
  assert.deepEqual(systemPosts[0].form, [], 'an empty request');
  assert.match(maintenance.text, /الصيانة: المفتاحان مقبولان.*3 مشروعاً/);
  const without = await estate.check({ url: 'https://maher.e-statee.com', token: 'k', send: async () => ({ status: 422, data: {} }) });
  assert.match(without.more[0].text, /احفظ المفتاح السري/);
});


test('a request without the customer\'s name is not sent with a made-up one', async () => {
  const call = callWith([['interest', { interest_status: 'مهتم' }]]);
  await estate.afterCall(await company(), call, deps());
  assert.equal(posts.length, 0);
  assert.match(requestsOf(call.id)[0].estate_detail, /بلا اسم عميل/);
});

test('nothing at all goes while it is off, without the key, or to an address that is not Estate', async () => {
  for (const [e, token] of [
    [{ url: 'https://maher.e-statee.com', platform: 'p', enabled: false }, 'k'],
    [{ url: 'https://maher.e-statee.com', platform: 'p', enabled: true }, null],
    [{ url: 'https://evil.example.com', platform: 'p', enabled: true }, 'k'],
  ]) {
    configure(e, token);
    const call = callWith([['interest', INTEREST]]);
    await estate.afterCall(await company(), call, deps());
    assert.equal(requestsOf(call.id)[0].estate_status, null, JSON.stringify(e));
  }
  assert.equal(posts.length, 0);
});

// ─── Estate's answers ─────────────────────────────────────────────
test('a choice Estate refuses by name sends the lead again with everything in the note', async () => {
  answer = () => (posts.length === 1
    ? { status: 422, data: { message: 'invalid', errors: { property_type: ['نوع العقار غير صحيح'] } } }
    : { status: 200, data: { status: true, message: 'تمت العملية بنجاح' } });
  const call = callWith([['interest', INTEREST]]);
  assert.deepEqual(await estate.afterCall(await company(), call, deps()), [{ sent: true }]);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].form.property_type, undefined);
  assert.match(posts[1].form.note, /نوع العقار: شقة[\s\S]*طريقة الدفع: تمويل بنكي/);
});

test('a refusal keeps Estate\'s own words; sending again by hand goes once it is fixed', async () => {
  answer = () => ({ status: 422, data: { message: 'The given data was invalid.', errors: { email: ['حقل البريد الإلكتروني مطلوب.'], project_ids: ['حقل المشاريع مطلوب.'] } } });
  const call = callWith([['interest', INTEREST]]);
  const [r] = await estate.afterCall(await company(), call, deps());
  assert.equal(r.failed, 'حقل البريد الإلكتروني مطلوب. — حقل المشاريع مطلوب.');
  assert.equal(requestsOf(call.id)[0].estate_status, 'failed');
  assert.equal(requestsOf(call.id)[0].estate_detail, r.failed);

  // Not again on its own (a replayed event)...
  assert.deepEqual(await estate.afterCall(await company(), call, deps()), [{ duplicate: true }]);
  // ...but by hand, once Estate takes it.
  answer = () => ({ status: 201, data: { status: true, message: 'تمت العملية بنجاح' } });
  const row = sql.getRequestForEstate.get(requestsOf(call.id)[0].id, 'maheer');
  assert.deepEqual(await estate.pushRequest(await company(), row, deps(), { retry: true }), { sent: true });
  // And a sent one is never sent again, even by hand.
  const sentRow = sql.getRequestForEstate.get(row.id, 'maheer');
  assert.deepEqual(await estate.pushRequest(await company(), sentRow, deps(), { retry: true }), { duplicate: true });
  assert.equal(posts.length, 3);                            // refused with its choices and without, then by hand
});

test('a 2xx that says status: false is a refusal, not a success', async () => {
  answer = () => ({ status: 200, data: { status: false, message: 'رقم الجوال غير صحيح' } });
  const call = callWith([['interest', INTEREST]]);
  const [r] = await estate.afterCall(await company(), call, deps());
  assert.equal(r.failed, 'رقم الجوال غير صحيح');
});

test('a wrong key, a wrong address and an unreachable Estate each say so', async () => {
  for (const [a, re] of [
    [{ status: 401, data: { message: 'Unauthenticated.' } }, /رفض Estate المفتاح/],
    [{ status: 404, data: { message: 'not found' } }, /لا توجد واجهة الطلبات/],
    [Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }), /تعذّر الوصول إلى Estate: ETIMEDOUT/],
  ]) {
    answer = () => a;
    const call = callWith([['interest', INTEREST]]);
    const [r] = await estate.afterCall(await company(), call, deps());
    assert.match(r.failed, re);
  }
});

// ─── checking, settings, shapes ───────────────────────────────────
test('the check reads Estate\'s answer to a request with no fields', async () => {
  const run = (a, extra = {}) => estate.check({ url: 'https://maher.e-statee.com/api/v1/make/attention-request/attention-request-store', token: 'k', send: async (o, t, f) => { posts.push({ o, f: [...f] }); return a; }, ...extra });
  let r = await run({ status: 422, data: { errors: { name: ['الاسم مطلوب'], phone: ['الجوال مطلوب'] } } });
  assert.equal(r.ok, true);
  assert.match(r.text, /المفتاح مقبول.*الاسم مطلوب — الجوال مطلوب/);
  assert.deepEqual(posts.at(-1).f, []);                    // no fields at all
  assert.equal(posts.at(-1).o, 'https://maher.e-statee.com');
  assert.equal((await run({ status: 401, data: {} })).ok, false);
  assert.match((await run({ status: 404, data: {} })).text, /لا توجد واجهة/);
  r = await run({ status: 200, data: { status: true } });
  assert.equal(r.warn, true);
  assert.match(r.text, /احذفه/);
  assert.match((await estate.check({ url: 'https://example.com', token: 'k' })).text, /غير صالح/);
  assert.match((await estate.check({ url: 'https://maher.e-statee.com', token: null })).text, /لم يُحفظ مفتاح/);
});

test('the key goes in the api-key header Estate reads, as well as Bearer', () => {
  const h = estate.estateHeaders('  Bearer k-123 ');
  assert.equal(h['api-key'], 'k-123');                     // a pasted "Bearer " is dropped
  assert.equal(h.Authorization, 'Bearer k-123');
  assert.equal(h['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(estate.estateHeaders('k-123')['api-key'], 'k-123');
});

test('what a copy-paste drags along is dropped from the key, and the hint says so', () => {
  const pasted = '‏ "Bearer ab12-CD34 ef56‎"\n';
  assert.equal(estate.cleanKey(pasted), 'ab12-CD34ef56');
  assert.equal(estate.estateHeaders(pasted)['api-key'], 'ab12-CD34ef56');
  assert.deepEqual(estate.keyHint(pasted), { length: 13, start: 'ab1', end: '56', cleaned: true });
  assert.deepEqual(estate.keyHint('ab12CD34ef56gh78'), { length: 16, start: 'ab1', end: '78', cleaned: false });
  // A short value shows next to nothing of itself.
  assert.deepEqual(estate.keyHint('***'), { length: 3, start: '', end: '', cleaned: false });
  assert.equal(estate.keyHint(''), null);
});

test('a refused key shows Estate\'s own words', async () => {
  // Exactly what maher.e-statee.com answers when the api-key header is wrong or absent.
  const live = { status: 403, data: { status: false, message: 'header api-key is missing or not correct' } };
  const r = await estate.check({ url: 'https://maher.e-statee.com', token: 'k', send: async () => live });
  assert.equal(r.ok, false);
  assert.match(r.text, /رفض Estate المفتاح \(header api-key is missing or not correct\)/);
  answer = () => live;
  const call = callWith([['interest', INTEREST]]);
  const [sent] = await estate.afterCall(await company(), call, deps());
  assert.equal(sent.failed, 'رفض Estate المفتاح (header api-key is missing or not correct)');
});

test('only an https Estate address is accepted, from the bare host or the full endpoint', () => {
  assert.equal(estate.estateOrigin('https://maher.e-statee.com'), 'https://maher.e-statee.com');
  assert.equal(estate.estateOrigin(' https://Maher.e-statee.com/api/v1/make/attention-request/attention-request-store '), 'https://maher.e-statee.com');
  for (const bad of ['http://maher.e-statee.com', 'https://e-statee.com.evil.com', 'https://maher.e-statee.com:8443', 'https://evil.com/maher.e-statee.com', 'maher.e-statee.com', '']) {
    assert.equal(estate.estateOrigin(bad), null, bad);
  }
});

test('numbers go as digits with the country code, never a "+" or a local 0', () => {
  assert.equal(estate.estatePhone('+966 50 123 4567'), '966501234567');
  assert.equal(estate.estatePhone('00966501234567'), '966501234567');
  assert.equal(estate.estatePhone('0501234567'), '966501234567');
  assert.equal(estate.estatePhone('501234567'), '966501234567');
  // A Saudi landline, as 3CX hands it over or internationally -- never "+011…".
  assert.equal(estate.estatePhone('0115009384'), '966115009384');
  assert.equal(estate.estatePhone('+966115009384'), '966115009384');
  assert.equal(estate.estatePhone('01234'), null);
  assert.equal(estate.estatePhone('+201095363467'), '201095363467');
  assert.equal(estate.estatePhone(''), null);
});

test('switching it on needs the address and the key; platform is ai_chat unless set', () => {
  const ok = { url: 'https://maher.e-statee.com', platform: '', enabled: true, projects: '' };
  assert.deepEqual(estate.validateSettings(ok, { hasToken: true }).estate, { url: 'https://maher.e-statee.com', platform: null, enabled: true, projects: [], interest: true, rental: false, maintenance: false });
  assert.equal(estate.settingsOf({ settings: { estate: { platform: null } } }).platform, 'ai_chat');
  assert.equal(estate.settingsOf({ settings: { estate: { platform: 'other' } } }).platform, 'other');
  assert.match(estate.validateSettings(ok, { hasToken: false }).error, /المفتاح/);
  assert.match(estate.validateSettings({ ...ok, url: 'https://x.com' }, { hasToken: true }).error, /غير صالح/);
  assert.deepEqual(estate.validateSettings({ url: '', platform: '', enabled: false }, { hasToken: false }).estate, { url: null, platform: null, enabled: false, projects: [], interest: true, rental: false, maintenance: false });
});

test('the project list is pasted as lines of "name = code", and checked line by line', () => {
  const text = 'M-10 — أدوار، حي المغرزات = M-10\n\n  وكن 038 — فلل، حي النهضة   =   W-38  \n';
  assert.deepEqual(estate.parseProjects(text).projects, [
    { name: 'M-10 — أدوار، حي المغرزات', code: 'M-10' }, { name: 'وكن 038 — فلل، حي النهضة', code: 'W-38' },
  ]);
  // Saved as a list, read back as one.
  assert.deepEqual(estate.parseProjects(estate.parseProjects(text).projects).projects, estate.parseProjects(text).projects);
  assert.match(estate.parseProjects('M-10').error, /السطر 1/);
  assert.match(estate.parseProjects('أ = M-10\nب = رمز').error, /السطر 2: رمز المشروع «رمز» ليس بصيغة Estate/);
  assert.match(estate.parseProjects('أ = M-10\nأ = M-11').error, /مكرر/);
  assert.match(estate.validateSettings({ url: '', projects: 'x =' }, { hasToken: false }).error, /السطر 1/);
});

// Estate's note of 2026-10-31: W-38 is Wakan's project 38, M-12 Maheer's 12, hyphen included.
test('a project code is kept in Estate\'s form: the company\'s letter, a hyphen, the number', async () => {
  assert.deepEqual(estate.parseProjects('وكن 38 = w-38\nمهير 12 = M–12\nوكن 40 = W - ٤٠').projects, [
    { name: 'وكن 38', code: 'W-38' }, { name: 'مهير 12', code: 'M-12' }, { name: 'وكن 40', code: 'W-40' },
  ]);
  for (const bad of ['W38', 'W 38', 'وكن-38', 'W-38A', '38']) {
    assert.match(estate.parseProjects(`وكن = ${bad}`).error, /حرف الشركة ثم شرطة ثم رقم المشروع/, bad);
  }
  // A list saved before the format was enforced still sends the code as Estate writes it.
  configure({ url: 'https://maher.e-statee.com', platform: 'ai_chat', enabled: true, projects: [{ name: 'وكن 38', code: 'w–38' }] }, 'estate-key');
  await estate.afterCall(await company(), callWith([['interest', { ...INTEREST, project: 'وكن 38' }]]), deps());
  assert.equal(posts.at(-1).form['project_codes[0]'], 'W-38');
});

test('the note names the assistant and its company, and the direction of the call', () => {
  const co = { id: 'wakan', name: 'وكن', settings: {} };
  const note = (request) => estate.buildNote({ request_type: 'interest', ...request }, { customer_name: 'فهد' }, co).split('\n').slice(0, 2);
  assert.deepEqual(note({ call_direction: 'inbound' }), ['طلب اهتمام من مكالمة واردة', 'المساعد الذكي: ناصر — وكن']);
  assert.deepEqual(note({ call_direction: 'outbound' }), ['طلب اهتمام من مكالمة صادرة', 'المساعد الذكي: ناصر — وكن']);
  assert.deepEqual(note({ channel: 'whatsapp' }), ['طلب اهتمام من محادثة واتساب', 'المساعد الذكي: ناصر — وكن']);
});

test('the code goes only for a project on the list; otherwise the lead goes without one', async () => {
  assert.equal(estate.projectCode('M-10 — أدوار، حي المغرزات', PROJECTS), 'M-10');
  assert.equal(estate.projectCode('  وكن 038 — فلل،  حي النهضة ', PROJECTS), 'W-38');   // spacing
  assert.equal(estate.projectCode('M-10', PROJECTS), 'M-10');                              // its own code
  assert.equal(estate.projectCode('مشروع لا نعرفه', PROJECTS), null);
  assert.equal(estate.projectCode('', PROJECTS), null);
  const call = callWith([['interest', { ...INTEREST, project: 'مشروع لا نعرفه' }]]);
  await estate.afterCall(await company(), call, deps());
  assert.equal(posts.at(-1).form['project_codes[0]'], undefined);
  assert.match(posts.at(-1).form.note, /المشروع المهتم به: مشروع لا نعرفه/);   // still told, in the note
});

test('the key never rides along with the company, and the requests list carries each outcome', () => {
  const { toCompany } = require('../companies');
  const c = toCompany(sql.listCompanies.all().find((r) => r.id === 'maheer'));
  assert.ok(!JSON.stringify(c).includes('estate-key'));
  const row = sql.listCustomerRequests.all('maheer').find((r) => r.estate_status === 'sent');
  assert.ok(row && 'estate_detail' in row && 'estate_at' in row);
});
