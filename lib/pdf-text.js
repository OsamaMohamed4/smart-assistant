// Text out of a PDF, in reading order — Arabic included.
//
// pdf.js reports a page as positioned runs of text, in the order they were
// drawn. For Arabic that order is very often the VISUAL one: a page printed by
// Chrome, or exported from Word or InDesign, draws "تجريبي" glyph by glyph
// from left to right, each glyph as its shaped presentation form. Joined as
// drawn, the knowledge base stored "ﻲﺑﯾرﺟﺗ" — text no search could match and no
// agent could read.
//
// So every line is put back together by position: right to left when the line
// is mostly Arabic, with any Latin or digit run inside it kept left to right
// ("750,000" stays 750,000). Runs are taken in drawing order otherwise, which
// keeps columns and text boxes apart instead of interleaving them by height.
// Presentation forms are then folded back to ordinary letters.

const ARABIC_RANGES = '\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF';
const ARABIC = new RegExp(`[${ARABIC_RANGES}]`);
const ARABIC_ALL = new RegExp(`[${ARABIC_RANGES}]`, 'g');
const STRONG_LTR = /[A-Za-z0-9٠-٩۰-۹]/;
const PRESENTATION_FORMS = /[ﭐ-﷿ﹰ-﻿]/g;
const ONLY_MARKS = /^\p{M}+$/u;

// Fonts share one glyph between an Arabic letter and its Persian or Urdu
// look-alike, and the PDF's text map may name the look-alike: an initial yeh
// comes back as ی, a medial heh as ھ. This platform's text is Arabic only, so
// they are always the Arabic letter. The rial sign is one ligature glyph that
// would expand with the Persian yeh; it is spelled out first for the same
// reason.
const LOOKALIKES = { 'ی': 'ي', 'ھ': 'ه', 'ہ': 'ه', 'ک': 'ك' };

function foldPresentationForms(text) {
  return text
    .replace(/﷼/g, 'ريال')
    .replace(PRESENTATION_FORMS, (c) => c.normalize('NFKC'))
    .replace(/[یھہک]/g, (c) => LOOKALIKES[c]);
}

function isRtlText(text) {
  const arabic = (text.match(ARABIC_ALL) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return arabic > latin;
}

// Order one line's runs for reading. Each run's own string is already in
// logical order (pdf.js applies the bidi algorithm per run); only the ORDER of
// the runs comes from where they sit on the page.
function orderRuns(runs) {
  const rtl = isRtlText(runs.map((r) => r.s).join(''));
  // A lone diacritic (a tanween, a shadda) is drawn as its own zero-width run
  // whose x can fall inside the NEIGHBOURING glyph's box, so its position says
  // nothing reliable. It belongs to the letter drawn next to it: the one after
  // it when the line was drawn left to right in visual order, the one before
  // it otherwise. It takes that letter's position and sorts right behind it.
  // pdf.js sometimes hands the mark over glued to a stray space (" ً"); the
  // space is an artefact of its spacing heuristic, not of the text.
  runs = runs.map((r) => (ONLY_MARKS.test(r.s.trim()) ? { ...r, s: r.s.trim() } : r));
  const visualOrder = rtl && runs.length > 1 && runs[runs.length - 1].x > runs[0].x;
  const isMark = runs.map((r) => ONLY_MARKS.test(r.s));
  const isLetter = runs.map((r, i) => !isMark[i] && /\p{L}/u.test(r.s));
  const baseOf = (i) => {
    const step = visualOrder ? 1 : -1;
    for (let j = i + step; j >= 0 && j < runs.length; j += step) if (isLetter[j]) return j;
    for (let j = i - step; j >= 0 && j < runs.length; j -= step) if (isLetter[j]) return j;
    return i;
  };
  const keyed = runs.map((r, i) => ({ ...r, key: isMark[i] ? runs[baseOf(i)].x : r.x, mark: isMark[i] ? 1 : 0 }));
  keyed.sort((a, b) => (rtl ? b.key - a.key : a.key - b.key) || a.mark - b.mark);
  if (!rtl) return keyed;

  // Inside a right-to-left line, a stretch of Latin or digits still reads left
  // to right. Sorting the whole line right to left reversed such a stretch,
  // so turn each one back. Neutral runs (spaces, punctuation) belong to the
  // stretch only when they sit between two of its strong runs.
  const out = [];
  for (let i = 0; i < keyed.length;) {
    if (!STRONG_LTR.test(keyed[i].s) || ARABIC.test(keyed[i].s)) {
      out.push(keyed[i]); i++; continue;
    }
    let end = i;
    for (let j = i + 1; j < keyed.length && !ARABIC.test(keyed[j].s); j++) {
      if (STRONG_LTR.test(keyed[j].s)) end = j;
    }
    out.push(...keyed.slice(i, end + 1).reverse());
    i = end + 1;
  }
  return out;
}

function joinRuns(runs, height) {
  // Some producers draw no space glyphs and leave a gap instead.
  const rtl = isRtlText(runs.map((r) => r.s).join(''));
  let text = '';
  let prev = null;
  for (const r of runs) {
    if (prev) {
      const gap = rtl ? prev.x - (r.x + r.w) : r.x - (prev.x + prev.w);
      if (gap > height * 0.25 && !/\s$/.test(text) && !/^\s/.test(r.s)) text += ' ';
    }
    text += r.s;
    prev = r;
  }
  return text;
}

// Group a page's items into lines. Items are taken in drawing order and a new
// line starts when the baseline moves, the producer marks an end of line, or
// the next run is out of horizontal reach (another column or text box).
function pageText(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;            // marked-content markers
    if (!it.str) { if (it.hasEOL && cur) cur.eol = true; continue; }
    const [a, b, c, d, x, y] = it.transform;
    const height = Math.hypot(c, d) || Math.hypot(a, b) || 10;
    const w = it.width || 0;
    const sameLine = cur && !cur.eol
      && Math.abs(cur.y - y) <= Math.max(cur.height, height) * 0.6
      && x <= cur.maxX + height * 4 && x + w >= cur.minX - height * 4;
    if (!sameLine) {
      cur = { y, height, runs: [], minX: x, maxX: x + w, eol: false };
      lines.push(cur);
    }
    cur.runs.push({ s: it.str, x, w });
    cur.minX = Math.min(cur.minX, x);
    cur.maxX = Math.max(cur.maxX, x + w);
    cur.height = Math.max(cur.height, height);
    if (it.hasEOL) cur.eol = true;
  }

  let out = '';
  let prev = null;
  for (const line of lines) {
    const text = joinRuns(orderRuns(line.runs), line.height).replace(/[ \t]+/g, ' ').trim();
    if (!text) continue;
    if (prev) {
      // Same baseline (a table row split across cells) stays on one line.
      out += Math.abs(prev.y - line.y) <= Math.max(prev.height, line.height) * 0.6 ? ' ' : '\n';
    }
    out += text;
    prev = line;
  }
  return out;
}

async function pdfToText(buffer) {
  // ESM-only package; the legacy build is the one meant for Node.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    // A copy: pdf.js may transfer (detach) the bytes it is given, and the
    // caller still stores the original file.
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(pageText(content.items));
      page.cleanup();
    }
    return foldPresentationForms(pages.join('\n\n'));
  } finally {
    await doc.destroy();
  }
}

module.exports = { pdfToText, pageText, orderRuns, foldPresentationForms };
