// Reads a company's own public website into plain text, page by page, so the
// text can go into its knowledge base like any uploaded file.
//
// What it does: starts from one address, follows links that stay on the same
// site (and the sitemap, when there is one), turns each page's HTML into text,
// and hands the pages back. What it does not do: run the site's JavaScript.
//
// A site built as an app (Laravel + Inertia, as maheer.sa is; Next.js) draws
// its pages in the browser, so their HTML has next to no text -- but the
// server puts each page's data in that HTML, as JSON, for the app to start
// from. That data is read instead (embeddedData / dataText below): projects,
// units, prices and specifications, each with its own label. A site that
// draws its content by script and embeds no such data is detected and
// reported, not guessed around.
//
// Safety: every address it fetches -- the first, each link, each redirect -- is
// checked by lib/ssrf.js, so a site cannot lead the server to internal
// addresses. Pages are capped in size, count and time, and requests are spaced.

const crypto = require('crypto');
const { isSafeUrl, assertSafeUrl } = require('./ssrf');

const USER_AGENT   = 'MasarBot/1.0 (+https://getmasar.sa)';
const MAX_PAGES    = 150;
const MAX_BYTES    = 1.5 * 1024 * 1024;
const TIMEOUT_MS   = 12000;
const DELAY_MS     = 350;
const MAX_REDIRECTS = 4;
const MAX_URL_LEN  = 300;
const MIN_PAGE_CHARS = 80;

// Files that are not pages. PDFs and Word files are uploaded by hand instead.
const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|avif|pdf|docx?|xlsx?|pptx?|zip|rar|mp4|mov|mp3|css|js|json|xml|txt|woff2?|ttf|eot)$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bareHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
const sameSite = (a, b) => bareHost(new URL(a).hostname) === bareHost(new URL(b).hostname);

// One canonical form per page: no #fragment, no tracking parameters, no
// trailing slash (except the root), so the same page is never read twice.
function normalizeUrl(href, base) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_|ref$)/i.test(k)) u.searchParams.delete(k);
  }
  if (SKIP_EXT.test(u.pathname)) return null;
  let s = u.toString();
  if (u.pathname.length > 1 && s.endsWith('/') && !u.search) s = s.slice(0, -1);
  return s.length <= MAX_URL_LEN ? s : null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', hellip: '…' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x10FFFF ? String.fromCodePoint(n) : ' ';
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
}

// HTML -> { title, text, links }. Text keeps the page's structure: headings as
// "# ", list items as "- ", table cells joined with " | ", so a price table
// still reads as rows.
function parseHtml(html, baseUrl) {
  const src = String(html || '');
  const links = [];
  const hrefRe = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = hrefRe.exec(src))) {
    const h = decodeEntities((m[1] ?? m[2] ?? '').trim());
    if (!h || /^(mailto:|tel:|javascript:|#|whatsapp:|sms:)/i.test(h)) continue;
    const n = normalizeUrl(h, baseUrl);
    if (n) links.push(n);
  }

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';

  let t = src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // The Saudi riyal is often drawn as an icon after the amount; dropped
    // with the other icons, "1699000 <svg>" would lose its currency.
    .replace(/<svg\b[^>]*(?:riyal|ryal|sar-|currency)[^>]*>[\s\S]*?<\/svg>/gi, ' ريال ')
    .replace(/<(script|style|noscript|svg|template|head|nav|select|option)\b[\s\S]*?<\/\1>/gi, ' ')
    // Lines follow the page's blocks, not how its source happens to be
    // wrapped: "1699000</strong>\n<svg>" is one line on screen, so one here.
    .replace(/\s+/g, ' ')
    .replace(/<h[1-6]\b[^>]*>/gi, '\n\n# ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<br\s*\/?>|<\/(p|div|section|article|tr|li|ul|ol|table|h[1-6]|header|footer|main|form|address|figure)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t)
    .replace(/[ \t\f\v ]+/g, ' ')
    .split('\n')
    .map((l) => l.replace(/(\s*\|\s*)+$/, '').trim())
    .filter((l) => l && l !== '-' && l !== '#' && l !== '|')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return { title, text: t, links };
}

// Page body, capped in bytes, decoded by its declared charset.
async function readBody(res) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_BYTES) throw new Error('page too large');
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { try { await reader.cancel(); } catch {} throw new Error('page too large'); }
    parts.push(value);
  }
  const buf = Buffer.concat(parts);
  const cs = /charset=([\w-]+)/i.exec(res.headers.get('content-type') || '')?.[1]
    || /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString('latin1'))?.[1]
    || 'utf-8';
  try { return new TextDecoder(cs).decode(buf); } catch { return buf.toString('utf8'); }
}

// One page. Redirects are followed by hand so each hop is checked, and a
// redirect off the site is refused.
async function fetchPage(url, { guard = assertSafeUrl, origin = url, fetchImpl = fetch, xml = false } = {}) {
  let cur = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await guard(cur);
    const res = await fetchImpl(cur, {
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': 'ar,en;q=0.8' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      try { await res.body?.cancel(); } catch {}
      const next = loc && normalizeUrl(loc, cur);
      if (!next || !sameSite(next, origin)) throw new Error('redirect off the site');
      cur = next;
      continue;
    }
    if (!res.ok) { try { await res.body?.cancel(); } catch {} throw new Error(`HTTP ${res.status}`); }
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    if (type && !type.includes('html') && !(xml && type.includes('xml'))) { try { await res.body?.cancel(); } catch {} throw new Error('not a page'); }
    return { url: cur, html: await readBody(res) };
  }
  throw new Error('too many redirects');
}

// The sitemap, when the site has one: every address it lists on the same site.
async function sitemapUrls(origin, opts) {
  try {
    const { html } = await fetchPage(new URL('/sitemap.xml', origin).toString(), { ...opts, origin, xml: true });
    const out = [];
    for (const m of String(html).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      const n = normalizeUrl(decodeEntities(m[1]), origin);
      if (n && sameSite(n, origin)) out.push(n);
    }
    return out;
  } catch { return []; }
}

// A page whose content is drawn by script has an almost empty body next to its
// script tags.
function looksScriptRendered(html, text) {
  return text.length < 200 && /<script\b/i.test(html)
    && /(id=["'](root|app|__next|__nuxt)["']|__NEXT_DATA__|__NUXT__|ng-version|data-reactroot)/i.test(html);
}

// ─── Data an app embeds in its page ───────────────────────────────
// Inertia: <div id="app" data-page="{…page JSON…}">, its props the page's
// data. Next.js: <script id="__NEXT_DATA__">, its props.pageProps.
function embeddedData(html) {
  const src = String(html || '');
  const inertia = /\bdata-page\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(src);
  if (inertia) {
    try {
      const page = JSON.parse(decodeEntities(inertia[1] ?? inertia[2]));
      if (page && typeof page.props === 'object') return page.props;
    } catch {}
  }
  const next = /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(src);
  if (next) {
    try {
      const page = JSON.parse(next[1]);
      if (page?.props?.pageProps && typeof page.props.pageProps === 'object') return page.props.pageProps;
    } catch {}
  }
  return null;
}

// What an app's data carries besides content: ids, dates, flags, media,
// coordinates, the framework's own state -- and anything that names a key or
// a token, which never goes into a knowledge base.
const SKIP_KEY_ANY_CASE = new RegExp([
  'token|secret|password|passwd|api_?key|csrf|xsrf|session|cookie',
  '^(uuid|slug|errors|auth|flash\\w*|alertMessages|userAbilities|uploadLimits|assetUrl|locale|ziggy|menu|countries|meta|links|sliders|hasHeader|hasSlider|component|version)$',
  '(image|images|img|video|videos|cover|logo|icon|icons|media|brochure|thumbnail|thumb|avatar|photo|photos|banner|gallery)(white|black)?$',
  '^(latitude|longitude|lat|lng|lon)$|(url|route|href|link)$',
  '^(conversions\\w*|manipulations|custom_properties|responsive_images|generated_conversions|disk|mime_type|file_name|size|order_column|model_type|collection_name|option_type)$',
].join('|'), 'i');
// Case matters here: "statusID" and "createdAt" are bookkeeping, "flat" is not.
const SKIP_KEY_EXACT = /^id$|(^|_)ids?$|[a-z]Id$|[a-z]ID$|_at$|[a-z]At$|^(is|has|show)(_|[A-Z])/;
const skipKey = (k) => SKIP_KEY_ANY_CASE.test(k) || SKIP_KEY_EXACT.test(k);

const isUrlText = (s) => /^(https?:)?\/\//i.test(s) || /^\/(storage|build|assets|images|uploads)\//i.test(s);
const isLocalized = (v) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length > 0 && Object.keys(v).every((k) => /^(ar|en)$/.test(k));

// A stored description is often HTML.
const plain = (s) => (/<[a-z][^>]*>/i.test(s) ? parseHtml(s, 'http://x/').text.replace(/\n+/g, ' ') : s)
  .replace(/\s+/g, ' ').trim();

// A scalar worth writing, as text; '' when it is not.
function scalarText(v) {
  if (v == null || typeof v === 'boolean') return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return !s || isUrlText(s) ? '' : plain(s);
}

// An object's entries, the ones worth writing, with a label each. "status"
// and "status_text" (or "statusText") are one field: the words win over the
// code ("للبيع", not "under_sale") when there are words.
function dataEntries(obj) {
  const out = [];
  const wordsOf = (k) => [obj[`${k}_text`], obj[`${k}Text`]].map((x) => inlineText(x)).find(Boolean) || '';
  for (const [k, v] of Object.entries(obj)) {
    const base = k.replace(/(_text|Text)$/, '');
    if (skipKey(base) || skipKey(k)) continue;
    // "name_en" beside "name": the same field in the other language; and
    // "name_ar" beside "name" says it again.
    if (/(_en|En)$/.test(k) || (/(_ar|Ar)$/.test(k) && k.replace(/(_ar|Ar)$/, '') in obj)) continue;
    if (base !== k) {
      if (base in obj && wordsOf(base)) out.push([base, v]);   // the words, under the field's name
      else if (!(base in obj) && inlineText(v)) out.push([base, v]);
      continue;
    }
    if (wordsOf(k)) continue;                                   // written by its words instead
    out.push([k, v]);
  }
  return out;
}

// One value on one line: an object as "label: value | …", a list joined by
// "، ", a specification ({name, num_value}) as "name: value".
function inlineText(v, depth = 0) {
  if (v == null || typeof v !== 'object') return scalarText(v);
  if (isLocalized(v)) return scalarText(v.ar) || scalarText(v.en);
  if (depth > 4) return '';
  if (Array.isArray(v)) return v.map((x) => inlineText(x, depth + 1)).filter(Boolean).join('، ');
  // A specification -- {name: "غرف نوم", num_value: 2, option: {…its definition…}}
  // -- is its name and its value; the rest only describes the name.
  const VALUE_KEYS = ['num_value', 'value', 'count', 'quantity'];
  const label = inlineText(v.name ?? v.label ?? v.title, depth + 1);
  if (VALUE_KEYS.some((k) => k in v)) {
    if (!label) return '';                                      // a value with nothing to say what of
    const value = VALUE_KEYS.map((k) => scalarText(v[k])).find(Boolean);
    return value ? `${label}: ${value}` : label;
  }
  const entries = dataEntries(v)
    .map(([k, x]) => [k, x, inlineText(x, depth + 1)])
    .filter(([, , t]) => t);
  // A record that is only a name ({id, name: "مجلس", …bookkeeping}) is that name.
  if (label && entries.every(([k]) => /^(name|label|title)$/.test(k))) return label;
  // Figures first, then the lists and records inside, so a unit's line opens
  // with its number, area and price.
  const flat = [];
  const nested = [];
  for (const [k, x, t] of entries) {
    (x && typeof x === 'object' && !isLocalized(x) ? nested : flat).push(`${k}: ${t}`);
  }
  const parts = [...flat, ...nested];
  return depth ? (parts.length ? `(${parts.join(' | ')})` : '') : parts.join(' | ');
}

const DATA_TEXT_MAX = 60000;
// The page's data as text: a scalar on a line of its own ("price: 1999000"),
// a list of records one record per line, so each unit's figures stay together
// when the text is cut into chunks; a section's name as a "# " heading.
function dataText(data) {
  const lines = [];
  const walk = (obj, depth) => {
    for (const [k, v] of dataEntries(obj)) {
      if (v == null || typeof v !== 'object' || isLocalized(v)) {
        const t = inlineText(v);
        if (t) lines.push(`${k}: ${t}`);
      } else if (Array.isArray(v)) {
        const rows = v.map((x) => inlineText(x)).filter(Boolean);
        if (!rows.length) continue;
        if (v.every((x) => x == null || typeof x !== 'object')) { lines.push(`${k}: ${rows.join('، ')}`); continue; }
        lines.push('', `# ${k}`, ...rows.map((r) => `- ${r}`));
      } else if (depth < 3) {
        const at = lines.length;
        lines.push('', `# ${k}`);
        walk(v, depth + 1);
        if (lines.length === at + 2) lines.length = at;   // nothing under it
      } else {
        const t = inlineText(v);
        if (t) lines.push(`${k}: ${t}`);
      }
    }
  };
  walk(data, 0);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, DATA_TEXT_MAX);
}

// Same-site pages the data points to: every address in it, and -- on a list
// page -- each record's own page, "/real-estates" + "/" + its slug, which an
// app builds in the browser and never writes out. A guess that is checked:
// an address that is not a page is skipped like any other.
function dataLinks(data, pageUrl) {
  const out = new Set();
  const path = new URL(pageUrl).pathname.replace(/\/+$/, '');
  const visit = (v, inList) => {
    if (typeof v === 'string') {
      if (/^https?:\/\//i.test(v) || v.startsWith('/')) {
        const n = normalizeUrl(v, pageUrl);
        if (n) out.add(n);
      }
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) visit(x, true); return; }
    if (inList && path && typeof v.slug === 'string' && /^[\w-]{1,120}$/u.test(v.slug)) {
      const n = normalizeUrl(`${path}/${encodeURIComponent(v.slug)}`, pageUrl);
      if (n) out.add(n);
    }
    for (const x of Object.values(v)) visit(x, false);
  };
  visit(data, false);
  return [...out];
}

/**
 * crawlSite({ startUrl, maxPages, delayMs, onProgress })
 * -> { pages: [{ url, title, text }], skipped: [{ url, reason }], scriptRendered }
 *
 * `guard` and `fetchImpl` exist for tests; the defaults are the real,
 * SSRF-checked ones.
 */
async function crawlSite({
  startUrl, maxPages = MAX_PAGES, delayMs = DELAY_MS, onProgress = () => {},
  guard = assertSafeUrl, fetchImpl = fetch,
} = {}) {
  const first = isSafeUrl(startUrl);
  if (!first.ok) throw new Error(first.reason);
  const start = normalizeUrl(startUrl, startUrl);
  if (!start) throw new Error('رابط غير صالح');

  const opts = { guard, fetchImpl };
  const queue = [start];
  const seen = new Set([start]);
  const hashes = new Set();
  const pages = [];
  const skipped = [];
  let scriptRendered = false;

  for (const u of await sitemapUrls(start, opts)) {
    if (!seen.has(u) && seen.size < maxPages * 3) { seen.add(u); queue.push(u); }
  }

  while (queue.length && pages.length < maxPages) {
    const url = queue.shift();
    let page;
    try {
      page = await fetchPage(url, { ...opts, origin: start });
    } catch (e) {
      skipped.push({ url, reason: String(e.message || e).slice(0, 120) });
      onProgress({ pages: pages.length, queued: queue.length, skipped: skipped.length });
      continue;
    }
    const parsed = parseHtml(page.html, page.url);
    let { text, links } = parsed;
    const { title } = parsed;
    // An app's page: its data is its content, and points to its other pages.
    const data = embeddedData(page.html);
    if (data) {
      // Read from its data whenever the data has something to say: it is the
      // whole page, labelled, where the HTML is at most what was drawn.
      const fromData = dataText(data);
      if (fromData.length >= MIN_PAGE_CHARS || fromData.length > text.length) text = fromData;
      links = [...links, ...dataLinks(data, page.url)];
    } else if (pages.length === 0 && looksScriptRendered(page.html, text)) scriptRendered = true;
    const h = contentHash(text);
    if (text.length < MIN_PAGE_CHARS) skipped.push({ url, reason: 'no readable text' });
    else if (hashes.has(h)) skipped.push({ url, reason: 'same text as another page' });
    else { hashes.add(h); pages.push({ url: page.url, title, text }); }
    for (const l of links) {
      if (!seen.has(l) && sameSite(l, start) && seen.size < maxPages * 3) { seen.add(l); queue.push(l); }
    }
    onProgress({ pages: pages.length, queued: queue.length, skipped: skipped.length });
    if (queue.length && delayMs) await sleep(delayMs);
  }
  return { pages, skipped, scriptRendered };
}

// Lines every page repeats (menu remnants, footer, contact block) are kept on
// the first page that has them and dropped from the rest, so they neither fill
// the knowledge base nor crowd out real answers. Pages that end up with no
// text of their own are dropped.
function dropRepeatedLines(pages, { minPages = 4, minCount = 3 } = {}) {
  if (pages.length < minPages) return pages;
  const count = new Map();
  for (const p of pages) {
    for (const l of new Set(p.text.split('\n'))) count.set(l, (count.get(l) || 0) + 1);
  }
  const shown = new Set();
  return pages.map((p) => {
    const kept = p.text.split('\n').filter((l) => {
      if ((count.get(l) || 0) < minCount || l.startsWith('# ')) return true;
      // A short line with a figure is a value, not page furniture: "حمام 2",
      // "9", a unit's price -- the same on many units, and each one's own.
      if (/\d/.test(l) && l.length < 60) return true;
      if (shown.has(l)) return false;
      shown.add(l);
      return true;
    });
    return { ...p, text: kept.join('\n') };
  }).filter((p) => p.text.length >= MIN_PAGE_CHARS);
}

// What goes into the knowledge base for one page: where it came from, then its
// text. The source line lets the assistant say where a fact is from.
function pageDocument(page) {
  return `# ${page.title || page.url}\nالمصدر: ${page.url}\n\n${page.text}`;
}

// Name under which a site's pages are listed, and the prefix that finds them
// again when the site is read anew.
function docPrefix(startUrl) {
  return `🌐 ${bareHost(new URL(startUrl).hostname)} — `;
}
function docName(startUrl, page) {
  const label = (page.title || new URL(page.url).pathname || page.url).replace(/\s+/g, ' ').trim();
  return (docPrefix(startUrl) + label).slice(0, 160);
}

const contentHash = (text) => crypto.createHash('sha1').update(text).digest('hex');

module.exports = {
  crawlSite, parseHtml, normalizeUrl, dropRepeatedLines, pageDocument, docPrefix, docName, contentHash,
  embeddedData, dataText, dataLinks,
  MAX_PAGES,
};
