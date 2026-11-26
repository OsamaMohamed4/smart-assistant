// Potential-conflict detection across knowledge-base documents (step 3 of the KB
// management flow: "التحقق من أي تعارض محتمل مع مستندات أخرى").
//
// Deterministic and content-based: it reads each document's text, pulls out
// (unit/project code → price) pairs from price-like lines, and flags any code
// that carries MORE THAN ONE distinct price. That is the conflict the business
// cares about — the same unit quoted at two different prices across (or within)
// documents, e.g. an old manual price sheet left live beside the auto-pulled one.
//
// It is intentionally labelled "potential": a code such as "A1" can legitimately
// exist in two different projects at different prices, so the result is evidence
// for a human to review, not an automatic action. No LLM, so it is fast and free.

// A price: a comma-grouped number (1,499,000) or a plain 6–8 digit number
// (1499000). Smaller numbers (areas like 211, room counts) are ignored.
const PRICE_RE = /\d{1,3}(?:,\d{3}){1,3}|\b\d{6,8}\b/g;
// A unit/project code: a short letter+digit token (A1, A-3, TH2, M-10) or an
// Arabic project code (وكن 044 / مهير 10).
const LATIN_CODE_RE = /\b[A-Za-z]{1,3}-?\d{1,4}\b/;
const AR_CODE_RE = /(?:وكن|مهير|ماهر)\s*\d{1,4}/;
const MIN_PRICE = 50000;   // below this it is not a sale price in this domain

// Pull (code, price) pairs from one document's text. Price-like lines are short
// and contain both a code and a number, so we scan line by line (and by bullet).
function pairsFromText(text) {
  const out = [];
  const lines = String(text || '').split(/[\n•]/);
  for (const raw of lines) {
    const line = raw.slice(0, 200); // a price line is short; ignore long prose
    const code = (line.match(LATIN_CODE_RE) || line.match(AR_CODE_RE) || [])[0];
    if (!code) continue;
    const prices = (line.match(PRICE_RE) || [])
      .map((p) => parseInt(p.replace(/,/g, ''), 10))
      .filter((n) => Number.isFinite(n) && n >= MIN_PRICE);
    const norm = code.replace(/\s+/g, ' ').trim().toUpperCase();
    for (const price of prices) out.push({ code: norm, price });
  }
  return out;
}

// docs: [{ id, filename, text }]. Returns a list of potential conflicts, each:
// { code, prices: number[], docCount, entries: [{ price, docId, filename }] }.
// Cross-document conflicts (the same code priced differently in two files) are
// listed first, since they are the most likely to be real.
function findConflicts(docs) {
  const byCode = new Map(); // code -> Map(price -> Map(docId -> filename))
  for (const d of docs || []) {
    for (const { code, price } of pairsFromText(d.text)) {
      if (!byCode.has(code)) byCode.set(code, new Map());
      const pm = byCode.get(code);
      if (!pm.has(price)) pm.set(price, new Map());
      pm.get(price).set(d.id, d.filename);
    }
  }
  const conflicts = [];
  for (const [code, pm] of byCode) {
    if (pm.size < 2) continue; // one price only → no conflict
    const docsInvolved = new Set();
    const entries = [];
    for (const [price, docMap] of pm) {
      for (const [docId, filename] of docMap) {
        docsInvolved.add(docId);
        entries.push({ price, docId, filename });
      }
    }
    conflicts.push({
      code,
      prices: [...pm.keys()].sort((a, b) => a - b),
      docCount: docsInvolved.size,
      entries: entries.sort((a, b) => a.price - b.price),
    });
  }
  conflicts.sort((a, b) => (b.docCount - a.docCount) || a.code.localeCompare(b.code));
  return conflicts;
}

module.exports = { findConflicts, pairsFromText };
