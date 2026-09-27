// Regression suite for the company facts block (Phase B, step 1 / decision D1).
//
// The rule under test is narrow and easy to erode: this block states DATA and
// never behaviour. The operator's scenario is the only place that says how the
// agent should act, and nothing here may add to it, paraphrase it, or fill a
// gap with a default sentence.
//
//   node --test scripts/test-business-profile.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  renderFactsBlock, parseBusinessProfile, businessProfileSchema, isEmptyProfile,
} = require('../lib/business-profile');

const CO = { id: 'co-test', name: 'وكن للتطوير والاستثمار العقاري' };
const FULL = {
  description: 'شركة عقارية سعودية متخصصة في التطوير والاستثمار.',
  workingHours: [
    { days: 'الأحد إلى الخميس', from: '09:00', to: '17:00' },
    { days: 'الجمعة', closed: true },
  ],
  services: ['بيع وشراء العقارات', 'التسويق العقاري'],
  rules: ['لا نقدّم استشارات قانونية', 'الأسعار بالريال السعودي'],
};

// ══ The no-behaviour rule ═════════════════════════════════════════
test('a company with NO facts renders nothing at all', () => {
  // The important property: every company that has not filled this in gets
  // byte-identical prompt output to before the feature existed.
  assert.equal(renderFactsBlock(CO, null), '');
  assert.equal(renderFactsBlock(CO, {}), '');
  assert.equal(renderFactsBlock(CO, '{}'), '');
  assert.equal(isEmptyProfile(CO, null), true);
});

test('the name alone is NOT enough to emit a block', () => {
  // The scenario already says the company name everywhere; a block containing
  // only that is noise added to the operator's prompt for nothing.
  assert.equal(renderFactsBlock(CO, { services: [] }), '');
});

test('an empty field renders NOTHING — no placeholder, no apology', () => {
  const out = renderFactsBlock(CO, { services: ['بيع العقارات'] });
  assert.ok(out.includes('الخدمات'), 'the filled section appears');
  assert.ok(!out.includes('ساعات العمل'), 'the empty hours section is absent entirely');
  assert.ok(!out.includes('قواعد العمل'), 'the empty rules section is absent entirely');
  assert.ok(!/غير محدد|غير متوفر|لم يتم/.test(out), 'no "not specified" filler text');
});

test('the block contains no behavioural instruction to the model', () => {
  const out = renderFactsBlock(CO, FULL);
  // Words that would mean we had started writing the operator's prompt for
  // them: imperative verbs aimed at the agent, and the classic hallucination
  // guardrail. The knowledge-base block does carry such a sentence; this one
  // deliberately does not.
  for (const forbidden of ['استخدم', 'لا تختلق', 'يجب عليك', 'أنت مساعد', 'تأكد من']) {
    assert.ok(!out.includes(forbidden), `must not instruct the model: "${forbidden}"`);
  }
});

test('the heading is a label, and the block is clearly delimited', () => {
  const out = renderFactsBlock(CO, FULL);
  assert.ok(out.startsWith('\n\n---\n\n'), 'separated from the operator text');
  assert.ok(out.includes('## معلومات الشركة'), 'labelled section');
});

// ══ Content ═══════════════════════════════════════════════════════
test('all five requested facts render when present', () => {
  const out = renderFactsBlock(CO, FULL);
  assert.ok(out.includes(CO.name), 'company name');
  assert.ok(out.includes('شركة عقارية سعودية'), 'description');
  assert.ok(out.includes('الأحد إلى الخميس: 09:00 - 17:00'), 'working hours');
  assert.ok(out.includes('- بيع وشراء العقارات'), 'services');
  assert.ok(out.includes('- لا نقدّم استشارات قانونية'), 'business rules');
});

test('a closed day renders as closed rather than a fake time range', () => {
  const out = renderFactsBlock(CO, FULL);
  assert.ok(out.includes('الجمعة: مغلق'));
  assert.ok(!out.includes('الجمعة: undefined'));
  assert.ok(!/الجمعة:\s*-\s*$/m.test(out));
});

test('an hours entry with no times at all is dropped, not half-rendered', () => {
  const out = renderFactsBlock(CO, {
    description: 'x',
    workingHours: [{ days: 'السبت' }, { days: 'الأحد', from: '09:00', to: '17:00' }],
  });
  assert.ok(!out.includes('السبت'), 'a range stating no times states nothing');
  assert.ok(out.includes('الأحد: 09:00 - 17:00'));
});

test('blank list entries are filtered rather than rendered as empty bullets', () => {
  const out = renderFactsBlock(CO, { services: ['بيع', '   ', '', 'إيجار'] });
  assert.ok(out.includes('- بيع'));
  assert.ok(out.includes('- إيجار'));
  assert.ok(!/- \s*\n/.test(out), 'no empty bullet');
});

test('extraFacts carries anything the schema never anticipated', () => {
  // The escape hatch that keeps company specifics OUT of the codebase.
  const out = renderFactsBlock(CO, {
    description: 'x',
    extraFacts: [{ label: 'رقم الترخيص', value: '1200012345' }],
  });
  assert.ok(out.includes('- رقم الترخيص: 1200012345'));
});

test('an extraFact missing a label or value is dropped', () => {
  const out = renderFactsBlock(CO, {
    description: 'x',
    extraFacts: [{ label: '', value: 'v' }, { label: 'l', value: '' }, { label: 'ok', value: 'v' }],
  });
  assert.ok(out.includes('- ok: v'));
  assert.ok(!out.includes('- : '));
});

// ══ Tenant scoping ════════════════════════════════════════════════
test('the block is built from ONE company and cannot carry another tenant', () => {
  const a = renderFactsBlock({ id: 'co-a', name: 'شركة أ' }, { description: 'وصف أ' });
  const b = renderFactsBlock({ id: 'co-b', name: 'شركة ب' }, { description: 'وصف ب' });
  assert.ok(a.includes('شركة أ') && a.includes('وصف أ'));
  assert.ok(!a.includes('شركة ب') && !a.includes('وصف ب'));
  assert.ok(b.includes('شركة ب') && !b.includes('شركة أ'));
});

// ══ Robustness ════════════════════════════════════════════════════
test('an invalid stored profile renders NOTHING rather than half a block', () => {
  // Half a fact block is worse than none: the agent would state the half it got
  // as though it were the whole truth.
  assert.deepEqual(parseBusinessProfile('not json at all'), {});
  assert.deepEqual(parseBusinessProfile('[1,2,3]'), {});
  assert.deepEqual(parseBusinessProfile({ services: 'should be an array' }), {});
  assert.equal(renderFactsBlock(CO, { services: 'should be an array' }), '');
});

test('a stored JSON string and an equivalent object render identically', () => {
  assert.equal(renderFactsBlock(CO, JSON.stringify(FULL)), renderFactsBlock(CO, FULL));
});

test('rendering is deterministic — re-publishing produces identical text', () => {
  // Idempotency at the prompt level: an unchanged profile must not produce a
  // different prompt, or every publish would look like a change.
  assert.equal(renderFactsBlock(CO, FULL), renderFactsBlock(CO, FULL));
});

test('the schema rejects oversized and malformed input', () => {
  assert.equal(businessProfileSchema.safeParse({ description: 'x'.repeat(4001) }).success, false);
  assert.equal(businessProfileSchema.safeParse({ services: new Array(61).fill('s') }).success, false);
  assert.equal(businessProfileSchema.safeParse({ workingHours: [{ from: '09:00' }] }).success, false,
    'an hours entry requires `days`');
  assert.equal(businessProfileSchema.safeParse(FULL).success, true);
});

test('unknown keys are stripped, not stored', () => {
  const parsed = businessProfileSchema.safeParse({ description: 'x', evil: 'payload' });
  assert.equal(parsed.success, true);
  assert.ok(!('evil' in parsed.data), 'zod strips what the schema does not declare');
});
