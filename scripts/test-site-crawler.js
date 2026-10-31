// Reading a company's site into its knowledge base: a page as text, and a
// site built as an app (Laravel + Inertia, as maheer.sa is) through the data
// it embeds in each page -- which is all there is to read, the page itself
// being drawn in the browser.
//
// A fake site over a stub fetch; no network.
//
//   node --test scripts/test-site-crawler.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crawler = require('../lib/site-crawler');

// An Inertia page: the app's root element, its data in data-page, HTML-escaped.
const inertiaPage = (component, props) =>
  `<!DOCTYPE html><html lang="ar"><head><title inertia>${props.pageTitle || ''} - مهير</title><script src="/build/app.js"></script></head>`
  + `<body><div id="app" data-page="${JSON.stringify({ component, props, url: '/', version: 'x' })
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#039;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"></div></body></html>`;

const SHARED = {
  errors: {}, auth: null, locale: 'ar', estateToken: 'secret-key-1234', csrf_token: 'abc',
  menu: [{ label: 'مشاريعنا', route: 'https://maheer.example/real-estates' }],
  settings: { websiteName: 'مهير العقارية', phone: '+966 9200 31118', logoWhite: 'https://maheer.example/logo.png' },
};
const LIST = inertiaPage('Website/RealEstate/Index', {
  ...SHARED, pageTitle: 'مشاريعنا',
  data: { realEstates: [
    { id: 59, slug: 'mhyr-10', name: 'مهير', projectCode: 'M-10', status: 'للبيع', statusID: 'under_sale', typeText: 'أدوار', type: 'floor',
      region: 'حي المغرزات، الرياض', price: '1,999,000', showPrice: true, cover: 'https://maheer.example/storage/1/10.jpg' },
  ] },
});
const SHOW = inertiaPage('Website/RealEstate/Show', {
  ...SHARED, pageTitle: 'مهير 10',
  data: {
    realEstate: { id: 59, slug: 'mhyr-10', project_code: 'M-10', name: { ar: 'مهير', en: 'Maheer' }, name_text: 'مهير',
      status: 'under_sale', status_text: 'للبيع', district: 'حي المغرزات', latitude: 24.75, created_at: '2026-03-09T12:40:41Z',
      description: { ar: '<p>مشروع <strong>سكني</strong></p>', en: 'Residential' } },
    units: [{
      id: 989, name_with_building: 'A - 1', floor: -1, floor_text: null, total_area: '431.91', price_before_tax: '2699000.00',
      status: 'emptying', status_text: 'تم الإفراغ', planImage: 'https://maheer.example/storage/179/plan.jpg',
      specifications: [
        { id: 213, name: 'غرف نوم', num_value: 4, option: { id: 45, name: 'غرف نوم', name_en: 'Bed Room' }, option_type: 'x' },
        { id: 228, name: null, num_value: 1 },
        { id: 217, name: 'مجلس', num_value: null },
      ],
      services: [{ id: 4, name: { ar: 'مطبخ', en: 'Kitchen' }, name_text: 'مطبخ', pivot: { real_estate_unit_id: 989 }, icon: 'https://x/i.png' }],
    }],
  },
});

test('an app\'s page is read from the data it embeds: labelled, in words, without ids, media or keys', () => {
  const data = crawler.embeddedData(SHOW);
  assert.ok(data, 'the Inertia data is found');
  const text = crawler.dataText(data);
  assert.match(text, /project_code: M-10/);
  assert.match(text, /status: للبيع/, 'the words, not the code');
  assert.doesNotMatch(text, /under_sale|emptying/);
  assert.match(text, /description: مشروع سكني/, 'Arabic, its HTML taken out');
  assert.match(text, /^name: مهير$/m);
  // One unit, one line: its figures first, its specifications after.
  const unit = text.split('\n').find((l) => l.includes('A - 1'));
  assert.equal(unit, '- name_with_building: A - 1 | floor: -1 | total_area: 431.91 | price_before_tax: 2699000.00 | status: تم الإفراغ'
    + ' | specifications: غرف نوم: 4، مجلس | services: مطبخ');
  // Never into a knowledge base: keys, tokens, ids, dates, coordinates, media.
  for (const bad of [/secret-key/, /csrf|abc/, /989|213/, /2026-03-09/, /24\.75/, /storage|\.jpg|\.png/, /Bed Room|Kitchen|Maheer/]) {
    assert.doesNotMatch(text, bad, String(bad));
  }
});

test('a list page points to each record\'s own page, which the app builds and never writes out', () => {
  const links = crawler.dataLinks(crawler.embeddedData(LIST), 'https://maheer.example/real-estates');
  assert.ok(links.includes('https://maheer.example/real-estates/mhyr-10'));
  assert.ok(links.includes('https://maheer.example/real-estates'), 'an address in the data');
  assert.ok(!links.some((l) => /\.jpg|\.png/.test(l)), 'no media');
  // On the home page a slug says nothing about where its page is.
  assert.ok(!crawler.dataLinks(crawler.embeddedData(LIST), 'https://maheer.example/').some((l) => l.endsWith('/mhyr-10')));
});

test('Next.js embeds its page data too', () => {
  const html = '<html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">'
    + JSON.stringify({ props: { pageProps: { project: { title: 'برج الياسمين', price: 950000 } } } }) + '</script></body></html>';
  assert.match(crawler.dataText(crawler.embeddedData(html)), /title: برج الياسمين\nprice: 950000/);
});

test('a page\'s lines follow its blocks, not its source\'s line breaks, and the riyal icon is kept as a word', () => {
  const html = '<div class="unit"><a><i class="fas fa-home"></i> 1 <strong>1699000</strong>\n   <svg class="riyal-svg" viewBox="0 0 1 1"><path d="M0"/></svg>\n <strong>للبيع</strong></a></div><div>حمام 2</div>';
  assert.deepEqual(crawler.parseHtml(html, 'https://wakan.example/').text.split('\n'), ['1 1699000 ريال للبيع', 'حمام 2']);
});

test('a figure repeated on every unit of every page is kept; page furniture is not', () => {
  const pages = ['أ', 'ب', 'ج', 'د'].map((x) => ({ url: `https://w.example/${x}`, title: x, text: `# مشروع ${x}\nحمام 2\nجميع الحقوق محفوظة لشركة وكن للتطوير العقاري\nوصف المشروع ${x} بتفاصيل تكفي لتكون صفحة` }));
  const kept = crawler.dropRepeatedLines(pages);
  assert.ok(kept.every((p) => p.text.includes('حمام 2')));
  assert.equal(kept.filter((p) => p.text.includes('جميع الحقوق محفوظة')).length, 1);
});

test('a site built as an app is crawled through its data, list page to each project', async () => {
  const site = {
    'https://maheer.example/': inertiaPage('Website/Home/Index', { ...SHARED, pageTitle: 'الرئيسية', data: { whyMaheer: [{ title: 'جودة في التنفيذ', text: 'تنفيذ بأعلى المعايير وتسليم في الموعد المحدد لكل مشروع.' }] } }),
    'https://maheer.example/real-estates': LIST,
    'https://maheer.example/real-estates/mhyr-10': SHOW,
  };
  const fetchImpl = async (url) => (site[url]
    ? new Response(site[url], { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    : new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } }));
  const r = await crawler.crawlSite({ startUrl: 'https://maheer.example/', delayMs: 0, guard: async () => {}, fetchImpl });
  assert.equal(r.scriptRendered, false, 'the data is there to read');
  assert.deepEqual(r.pages.map((p) => p.url).sort(), Object.keys(site).sort());
  const project = r.pages.find((p) => p.url.endsWith('/mhyr-10'));
  assert.match(project.text, /price_before_tax: 2699000\.00/);
  assert.ok(!r.pages.some((p) => /secret-key/.test(p.text)));
});

test('a page drawn by script with no data in it is still reported, not guessed at', async () => {
  const html = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>';
  const fetchImpl = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  const r = await crawler.crawlSite({ startUrl: 'https://spa.example/', delayMs: 0, guard: async () => {}, fetchImpl });
  assert.equal(r.scriptRendered, true);
  assert.equal(r.pages.length, 0);
});
