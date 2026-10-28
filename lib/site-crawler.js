// Reads a company's own public website into plain text, page by page, so the
// text can go into its knowledge base like any uploaded file.
//
// What it does: starts from one address, follows links that stay on the same
// site (and the sitemap, when there is one), turns each page's HTML into text,
// and hands the pages back. What it does not do: run the site's JavaScript. A
// site that draws its content in the browser has nothing in its HTML to read;
// that is detected and reported, not guessed around.
//
// Safety: every address it fetches -- the first, each link, each redirect -- is
// checked by lib/ssrf.js, so a site cannot lead the server to internal
// addresses. Pages are capped in size, count and time, and requests are spaced.

const crypto = require('crypto');
const { isSafeUrl, assertSafeUrl } = require('./ssrf');

const USER_AGENT   = 'MasarBot/1.0 (+https://getmasar.sa)';
const MAX_PAGES    = 60;
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
    .replace(/<(script|style|noscript|svg|template|head|nav|select|option)\b[\s\S]*?<\/\1>/gi, ' ')
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
    const { title, text, links } = parseHtml(page.html, page.url);
    if (pages.length === 0 && looksScriptRendered(page.html, text)) scriptRendered = true;
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
  MAX_PAGES,
};
