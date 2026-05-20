// End-to-end test for the RAG pipeline.
const fs = require('fs');
const path = require('path');

// Sample knowledge that does not exist in the seeded KB.
const SAMPLE_TEXT = `
# سياسة الفنادق الجديدة لأكمي للسفر — 2026

## فنادق دبي
- فندق برج العرب: 3,500 ريال لليلة، إفطار مجاني
- فندق أتلانتس: 2,800 ريال لليلة، الفطور والعشاء مشمولين
- فندق جميرا: 1,950 ريال لليلة، إفطار فقط

## فنادق إسطنبول
- فندق رافلز إسطنبول: 1,200 ريال لليلة في الموسم العادي، 1,800 ريال في رمضان
- فندق سيراجان بالاس: 2,400 ريال لليلة، يطل على البوسفور

## فنادق لندن
- فندق ذا ريتز لندن: 4,200 ريال لليلة (يبدأ من 4,200 — قد يختلف حسب التاريخ)
- فندق كلاريدج: 3,800 ريال لليلة

## برامج العضوية الذهبية
- اشتراك سنوي: 600 ريال
- المزايا: خصم 15% على كل الحجوزات، صعود مبكر للطائرة، 5 كجم وزن إضافي مجاني
- العضوية البلاتينية: 1,500 ريال، تشمل: lounge access في 80 مطار، أمتعة بلا حدود، خصم 25%

## رحلات شهر العسل
- باقة المالديف: 18,500 ريال لشخصين (7 ليالي، طيران وفندق وفطور)
- باقة موريشيوس: 22,000 ريال لشخصين (10 ليالي، all-inclusive)
- باقة سيشل: 25,500 ريال لشخصين (7 ليالي، فندق فاخر)

## ساعات العمل في رمضان
- من 9 صباحاً إلى 2 ظهراً
- من 9 مساءً إلى 12 منتصف الليل
- خط ساخن مفتوح 24/7 طوال الشهر
`;

(async () => {
  const COMPANY = 'acme';
  console.log('RAG end-to-end test');

  // 1. Upload a sample document.
  console.log('1) Upload sample document');
  const form = new FormData();
  const blob = new Blob([SAMPLE_TEXT], { type: 'text/markdown' });
  form.append('file', blob, 'hotels-policy.md');

  const upRes = await fetch(`http://localhost:3000/api/companies/${COMPANY}/documents`, {
    method: 'POST', body: form,
  });
  const up = await upRes.json();
  if (!upRes.ok) {
    console.log('   failed:', up); process.exit(1);
  }
  console.log(`   ok    documentId=${up.documentId} chunks=${up.chunkCount} textLen=${up.textLength}`);

  // 2. List documents.
  console.log('2) List documents');
  const list = await (await fetch(`http://localhost:3000/api/companies/${COMPANY}/documents`)).json();
  list.forEach((d) => console.log(`   - ${d.filename} | ${d.chunk_count} chunks | ${d.size_bytes} bytes`));

  // 3. Retrieval test.
  console.log('3) Retrieval test');
  const queries = [
    'كم سعر فندق برج العرب؟',
    'إيش برامج العضوية عندكم؟',
    'باقات شهر العسل؟',
  ];
  for (const q of queries) {
    const r = await (await fetch(`http://localhost:3000/api/companies/${COMPANY}/rag-test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    })).json();
    console.log(`   q: ${q}`);
    r.chunks.slice(0, 3).forEach((c, i) => {
      console.log(`      [${i+1}] score=${c.score} | ${c.preview.replace(/\n+/g, ' ').slice(0, 100)}...`);
    });
  }

  // 4. Chat using RAG.
  console.log('4) Chat with RAG');
  const chatQs = [
    'كم سعر فندق أتلانتس بدبي؟',
    'إيش الفرق بين العضوية الذهبية والبلاتينية؟',
    'عاوز باقة شهر عسل في المالديف، إيش العرض؟',
  ];
  for (const m of chatQs) {
    const cres = await fetch('http://localhost:3000/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: COMPANY, message: m }),
    });
    const c = await cres.json();
    console.log(`   q: ${m}`);
    console.log(`   a: ${c.reply}`);
  }

  // 5. Cleanup.
  console.log('5) Cleanup: delete document');
  await fetch(`http://localhost:3000/api/companies/${COMPANY}/documents/${up.documentId}`, { method: 'DELETE' });
  console.log('   deleted');
})();
