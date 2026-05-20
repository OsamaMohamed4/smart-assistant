// Verify GPT grounds responses in the KB (no fabricated numbers).
const cases = [
  {
    label  : 'Acme: سعر دبي',
    body   : { companyId: 'acme', message: 'كم سعر تذكرة من الرياض إلى دبي؟' },
    expect : ['750'],
  },
  {
    label  : 'Acme: سياسة الوزن',
    body   : { companyId: 'acme', message: 'كم كيلو شحن مسموح في الدرجة الاقتصادية؟' },
    expect : ['25'],
  },
  {
    label  : 'Acme: الإلغاء قبل 24 ساعة',
    body   : { companyId: 'acme', message: 'لو ألغيت الرحلة قبل 12 ساعة من الإقلاع، يرجع لي المبلغ؟' },
    expect : ['ما فيه', 'ما في', 'لا يوجد', 'مفيه', 'بدون', 'صفر', '0%'],
  },
  {
    label  : 'TechStore: لابتوب للبرمجة الثقيلة',
    body   : { companyId: 'techstore', message: 'أبي لابتوب قوي للـ Machine Learning، وش أفضل خيار عندكم؟' },
    expect : ['Legion', '4,500', '4500'],
  },
  {
    label  : 'TechStore: ضمان',
    body   : { companyId: 'techstore', message: 'الأجهزة عليها ضمان كم؟' },
    expect : ['سنة', '12'],
  },
  {
    label  : 'TechStore: معلومة غير موجودة (شاحن لاسلكي)',
    body   : { companyId: 'techstore', message: 'تبيعون شواحن لاسلكية؟ بكم؟' },
    expect : ['أتأكد', 'الفريق', 'مش متأكد', 'مو متأكد', 'مش متوفر', 'ما عندنا', 'ما في', 'لازم'],
  },
];

(async () => {
  let pass = 0;
  for (const c of cases) {
    const t0 = Date.now();
    const res = await fetch('http://localhost:3000/chat', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(c.body),
    });
    const json  = await res.json();
    const reply = json.reply || '';
    const hit   = c.expect.some((k) => reply.includes(k));
    if (hit) pass++;
    console.log('---');
    console.log(`${hit ? 'PASS' : 'FAIL'} ${c.label}   (${Date.now() - t0}ms)`);
    console.log(`> ${c.body.message}`);
    console.log(`< ${reply}`);
    if (!hit) console.log(`   expected one of: ${c.expect.join(' | ')}`);
  }
  console.log('---');
  console.log(`Result: ${pass}/${cases.length}`);
})();
