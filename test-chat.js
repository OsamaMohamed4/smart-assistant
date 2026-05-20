const cases = [
  { companyId: 'acme',      message: 'أبي أحجز رحلة من الرياض إلى دبي يوم الجمعة الجاية' },
  { companyId: 'techstore', message: 'أبي لابتوب للبرمجة في حدود 3 آلاف ريال' },
  { companyId: 'acme',      message: 'ممكن تقترح علي لابتوب؟' },
  { companyId: 'unknown',   message: 'test' },
];

(async () => {
  for (const body of cases) {
    const t0 = Date.now();
    const res = await fetch('http://localhost:3000/chat', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(body),
    });
    const json = await res.json();
    console.log('─────────────────────────────────────────────');
    console.log(`[${body.companyId}] (${res.status}) ${Date.now() - t0}ms`);
    console.log(`> ${body.message}`);
    if (json.reply) console.log(`< ${json.reply}`);
    else            console.log(`< ERROR: ${JSON.stringify(json)}`);
  }
})();
