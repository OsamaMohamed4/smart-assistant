// RAG pipeline: extract -> chunk -> embed -> retrieve.
require('dotenv').config();
const OpenAI = require('openai');
const { sql } = require('../db');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 1 });

// Embedding model is env-switchable (EMBED_MODEL=text-embedding-3-large is a
// real Arabic-relevance upgrade). Dimensions are PINNED to 1536 for every
// model so the pgvector column and existing blobs stay compatible — 3-large
// truncated to 1536 dims still clearly beats 3-small. After changing the
// model run scripts/reembed.js once: queries and stored vectors must come
// from the SAME model to be comparable.
const EMBED_MODEL     = process.env.EMBED_MODEL || 'text-embedding-3-small';
const EMBED_DIMS      = 1536;
const CHUNK_WORDS     = 300;                       // target words per chunk
const CHUNK_OVERLAP   = 60;                        // overlap between adjacent chunks
const MIN_CHUNK_WORDS = 15;                        // smallest chunk we keep
const TOP_K           = 4;                         // chunks returned per query
const MAX_CHUNKS_PER_DOC = 500;                    // hard ceiling: rejects ingest if exceeded
const MAX_RAW_TEXT_CHARS = 2_000_000;              // ~2MB of text → defensive cap
// 0.20 let weakly-related chunks through. 0.30 cuts that noise; chunks with
// strong KEYWORD evidence survive independently (see retrieve()), so exact
// prices/project names can't be filtered out by a soft vector score.
const MIN_SCORE       = 0.30;
const KW_OVERRIDE     = 0.5;                       // ≥ half the query terms → keep
const CANDIDATES      = 24;                        // vector candidates pre-fusion

// Repair "mojibake": Arabic UTF-8 bytes that were decoded as Latin1 and
// re-saved, so "العنوان" arrives as "Ø§ÙØ¹ÙÙØ§Ù". Common when users export
// .md/.txt from tools that mishandle encoding. The reversal is exact
// (latin1 -> original UTF-8 bytes), so prices/names/numbers stay faithful.
// Only triggers when the text is clearly dominated by mojibake markers and
// the reversal actually yields more Arabic with no replacement chars — so a
// correctly-encoded file is never touched.
function repairMojibake(text) {
  if (!text) return text;
  const markers = (text.match(/[ØÙÃ]/g) || []).length;
  const arabic  = (text.match(/[؀-ۿ]/g) || []).length;
  if (markers < 10 || markers <= arabic) return text;
  try {
    const repaired = Buffer.from(text, 'latin1').toString('utf8');
    if (repaired.includes('�')) return text;                 // broke it → keep original
    const arabicAfter = (repaired.match(/[؀-ۿ]/g) || []).length;
    return arabicAfter > arabic ? repaired : text;
  } catch {
    return text;
  }
}

// ─── Text extraction ──────────────────────────────────────────
async function extractText(buffer, mime, filename) {
  const ext = (filename || '').toLowerCase().split('.').pop();
  const m = (mime || '').toLowerCase();

  let text;
  if (m.includes('pdf') || ext === 'pdf') {
    const { pdf } = require('pdf-parse');
    const data = await pdf(buffer);
    text = data.text || '';
  } else if (m.includes('officedocument.wordprocessingml') || ext === 'docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    text = result.value || '';
  } else if (m.startsWith('text/') || ext === 'txt' || ext === 'md' || ext === 'markdown') {
    text = buffer.toString('utf8');
  } else {
    throw new Error(`Unsupported file type: ${mime || ext}`);
  }
  return repairMojibake(text);
}

// ─── Chunking: heading-aware, paragraph-aware, sentence-aware ──
function splitByHeadings(text) {
  // Treat markdown headings (#, ##, ...) as natural section boundaries.
  const lines = text.split('\n');
  const sections = [];
  let cur = [];
  for (const line of lines) {
    if (/^#{1,4}\s/.test(line.trim()) && cur.length) {
      sections.push(cur.join('\n').trim());
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) sections.push(cur.join('\n').trim());
  return sections.filter(Boolean);
}

function chunkText(text) {
  // Normalize whitespace and line endings.
  const cleaned = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) return [];

  // Split by markdown headings first when the document has structure.
  const sections = splitByHeadings(cleaned);
  const useSections = sections.length > 1;
  const blocks = useSections ? sections : [cleaned];

  // Each block: split into paragraphs.
  const paragraphs = blocks.flatMap((b) =>
    b.split(/\n\n+/).map((p) => p.trim()).filter(Boolean)
  );

  // Split long paragraphs into sentences.
  const segments = [];
  for (const p of paragraphs) {
    const words = p.split(/\s+/).filter(Boolean);
    if (words.length <= CHUNK_WORDS) {
      segments.push(p);
    } else {
      // Split on Arabic and English sentence terminators.
      const sentences = p.split(/(?<=[.!?؟])\s+/).filter(Boolean);
      let cur = [];
      let curWords = 0;
      for (const s of sentences) {
        const w = s.split(/\s+/).length;
        if (curWords + w > CHUNK_WORDS && cur.length) {
          segments.push(cur.join(' '));
          cur = [s]; curWords = w;
        } else {
          cur.push(s); curWords += w;
        }
      }
      if (cur.length) segments.push(cur.join(' '));
    }
  }

  // Merge small segments into chunks with overlap between adjacent chunks.
  const chunks = [];
  let buf = [];
  let bufWords = 0;
  for (const seg of segments) {
    const w = seg.split(/\s+/).length;
    if (bufWords + w > CHUNK_WORDS && buf.length) {
      chunks.push(buf.join('\n\n'));
      // Carry the tail of the previous chunk into the next for context overlap.
      const tailWords = buf.join(' ').split(/\s+/).slice(-CHUNK_OVERLAP);
      buf = [tailWords.join(' '), seg];
      bufWords = tailWords.length + w;
    } else {
      buf.push(seg);
      bufWords += w;
    }
  }
  if (buf.length) chunks.push(buf.join('\n\n'));

  // Drop chunks that are too small to be useful.
  return chunks
    .map((c) => c.trim())
    .filter((c) => c.split(/\s+/).length >= MIN_CHUNK_WORDS);
}

// ─── Embeddings ───────────────────────────────────────────────
async function embedBatch(texts) {
  if (!texts.length) return [];
  const r = await openai.embeddings.create({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIMS });
  return r.data.map((d) => d.embedding);
}

async function embedOne(text) {
  const [v] = await embedBatch([text]);
  return v;
}

// Float32Array <-> Buffer. Storing binary is ~3x smaller than JSON.
function vecToBuffer(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}
function bufferToVec(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

// ─── Cosine similarity ────────────────────────────────────────
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

// ─── Ingest pipeline ──────────────────────────────────────────
async function ingestDocument({ companyId, filename, mime, buffer }) {
  const text = await extractText(buffer, mime, filename);
  if (!text || text.trim().length < 50) {
    throw new Error('Could not extract enough text from the file.');
  }
  // Defensive caps to prevent runaway embedding costs from oversized or
  // adversarial documents (e.g. PDFs full of repeated whitespace).
  if (text.length > MAX_RAW_TEXT_CHARS) {
    throw new Error(`File text too large (${text.length} chars). Limit is ${MAX_RAW_TEXT_CHARS}.`);
  }

  // Split text into chunks first so we can reject before paying for storage.
  const chunks = chunkText(text);
  if (chunks.length > MAX_CHUNKS_PER_DOC) {
    throw new Error(`Document produces ${chunks.length} chunks; limit is ${MAX_CHUNKS_PER_DOC}. Split the file.`);
  }

  // Store the parent document row.
  const docResult = await sql.insertDocument.run({
    company_id : companyId,
    filename   : filename,
    mime_type  : mime || null,
    size_bytes : buffer.length,
    raw_text   : text,
    raw_data   : buffer,
  });
  const documentId = Number(docResult.lastInsertRowid);

  if (!chunks.length) {
    return { documentId, chunkCount: 0, textLength: text.length };
  }

  // Batch embeddings (OpenAI accepts arrays).
  const BATCH = 64;
  let chunkIndex = 0;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const vectors = await embedBatch(batch);
    for (let j = 0; j < batch.length; j++) {
      await sql.insertChunk.run({
        company_id : companyId,
        document_id: documentId,
        chunk_index: chunkIndex++,
        text       : batch[j],
        embedding  : vecToBuffer(vectors[j]),
        token_count: Math.ceil(batch[j].length / 2), // rough estimate (Arabic ≈ 2 chars/token)
      });
    }
  }

  return { documentId, chunkCount: chunks.length, textLength: text.length };
}

// ─── Arabic-aware keyword leg ─────────────────────────────────
// Semantic search alone misses exact facts (project names, prices) because
// Arabic embeddings blur them. The keyword leg catches literal evidence and
// the two rankings are fused with Reciprocal Rank Fusion.
const AR_DIACRITICS = /[ً-ْٰـ]/g;           // tashkeel + tatweel
const AR_STOPWORDS = new Set([
  'في', 'من', 'على', 'عن', 'الى', 'إلى', 'ما', 'هل', 'كم', 'ايه', 'اي',
  'هو', 'هي', 'انا', 'انت', 'مع', 'او', 'أو', 'ان', 'أن', 'لو', 'يا',
  'the', 'a', 'an', 'is', 'of', 'in', 'to', 'and', 'or', 'what', 'how',
]);

function normalizeArabic(s) {
  return String(s || '')
    .replace(AR_DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))   // Arabic-Indic → digits
    .toLowerCase();
}

function tokenizeQuery(query) {
  const norm = normalizeArabic(query);
  const raw = norm.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const tokens = [];
  for (let t of raw) {
    if (AR_STOPWORDS.has(t)) continue;
    // Strip a leading definite article so "الياسمين" matches "ياسمين" too.
    const bare = t.replace(/^(ال|وال|بال|لل)/, '');
    if (bare.length >= 2) t = bare;
    if (t.length < 2 && !/^\d+$/.test(t)) continue;
    tokens.push(t);
  }
  return [...new Set(tokens)];
}

// Fraction of query terms present in the chunk; numbers count double —
// a matched price/size is the strongest possible signal in this domain.
function keywordScore(tokens, normText) {
  if (!tokens.length) return 0;
  let hit = 0, weight = 0;
  for (const t of tokens) {
    const w = /^\d+$/.test(t) ? 2 : 1;
    weight += w;
    if (normText.includes(t)) hit += w;
  }
  return weight ? hit / weight : 0;
}

// ─── Retrieval (hybrid) ───────────────────────────────────────
// 1. Vector leg: pgvector HNSW under postgres / in-memory cosine under
//    sqlite (parity verified to 6 decimals by scripts/migrate-to-pg.js).
// 2. Keyword leg: normalized-Arabic term matching over the company's chunk
//    texts (in-process; at 100k+ chunks move this leg to a tsvector index).
// 3. Fusion: RRF (rank-based, so the two score scales never fight), then
//    keep chunks with real evidence: vector ≥ minScore OR keywords ≥ half
//    the query terms. `score` stays the cosine score for display.
async function retrieve(companyId, query, { topK = TOP_K, minScore = MIN_SCORE } = {}) {
  const countRow = await sql.countCompanyChunks.get(companyId);
  if (!countRow || !countRow.n) return [];

  const qVec = await embedOne(query);
  const qVecF32 = new Float32Array(qVec);
  const { isPg } = require('../db');

  // Vector candidates (unfiltered — the fusion + evidence gate filter later).
  let vecRanked;
  if (isPg) {
    const { retrieveVec } = require('./db-pg');
    vecRanked = await retrieveVec(companyId, qVecF32, { topK: CANDIDATES, minScore: -1 });
  } else {
    const rows = await sql.listCompanyChunks.all(companyId);
    vecRanked = rows
      .map((r) => ({ id: r.id, documentId: r.document_id, text: r.text, score: cosine(qVecF32, bufferToVec(r.embedding)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, CANDIDATES);
  }
  const vecById = new Map(vecRanked.map((r, i) => [r.id, { ...r, vecRank: i }]));

  // Keyword leg over ALL chunk texts (catches what the vector leg missed).
  const tokens = tokenizeQuery(query);
  const kwRanked = [];
  if (tokens.length) {
    const texts = await sql.listCompanyChunkTexts.all(companyId);
    for (const r of texts) {
      const kw = keywordScore(tokens, normalizeArabic(r.text));
      if (kw > 0) kwRanked.push({ id: r.id, documentId: r.document_id, text: r.text, kwScore: kw });
    }
    kwRanked.sort((a, b) => b.kwScore - a.kwScore);
    kwRanked.length = Math.min(kwRanked.length, CANDIDATES);
  }

  // RRF fusion (k=60, the standard constant).
  const K = 60;
  const fused = new Map();
  const upsert = (row) => {
    const cur = fused.get(row.id) || { id: row.id, documentId: row.documentId, text: row.text, score: 0, kwScore: 0, rrf: 0 };
    fused.set(row.id, { ...cur, ...row, rrf: cur.rrf });
    return fused.get(row.id);
  };
  vecRanked.forEach((r, i) => { upsert({ id: r.id, documentId: r.documentId, text: r.text, score: r.score }).rrf += 1 / (K + i); });
  kwRanked.forEach((r, i) => { upsert({ id: r.id, documentId: r.documentId, text: r.text, kwScore: r.kwScore }).rrf += 1 / (K + i); });

  let results = [...fused.values()]
    .filter((r) => (r.score || 0) >= minScore || (r.kwScore || 0) >= KW_OVERRIDE)
    .sort((a, b) => b.rrf - a.rrf);

  // Optional LLM re-rank (RAG_LLM_RERANK=1). Off by default: it adds
  // ~0.5-1.5s, which matters for the in-call KB tool. Strict timeout with
  // fallback to the fused order so it can only improve, never break.
  if (process.env.RAG_LLM_RERANK === '1' && results.length > topK) {
    results = await llmRerank(query, results.slice(0, Math.min(8, results.length)), results);
  }

  return results.slice(0, topK).map(({ rrf, ...r }) => r);
}

async function llmRerank(query, candidates, fallback) {
  try {
    const listing = candidates
      .map((c, i) => `${i + 1}. ${c.text.replace(/\s+/g, ' ').slice(0, 300)}`)
      .join('\n');
    const r = await openai.chat.completions.create(
      {
        model: 'gpt-4.1-mini',
        temperature: 0,
        max_tokens: 60,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'رتّب المقاطع حسب صلتها المباشرة بسؤال العميل. أعد JSON فقط: {"order":[أرقام المقاطع بالأصلح أولاً]}' },
          { role: 'user', content: `السؤال: ${query}\n\nالمقاطع:\n${listing}` },
        ],
      },
      { timeout: 2_500 },
    );
    const order = JSON.parse(r.choices[0]?.message?.content || '{}').order;
    if (!Array.isArray(order) || !order.length) return fallback;
    const picked = order
      .map((n) => candidates[Number(n) - 1])
      .filter(Boolean);
    const rest = candidates.filter((c) => !picked.includes(c));
    return [...picked, ...rest, ...fallback.slice(candidates.length)];
  } catch {
    return fallback;   // any failure → fused order, never worse
  }
}

// Format retrieved chunks as an Arabic prompt block for system prompt injection.
function formatChunksForPrompt(chunks) {
  if (!chunks.length) return '';
  const body = chunks
    .map((c, i) => `### مقطع رقم ${i + 1} (صلة: ${c.score.toFixed(2)})\n${c.text}`)
    .join('\n\n---\n\n');
  return `\n\nمعلومات ذات صلة بسؤال العميل (استخدمها كمصدر حقائق رسمي، لا تخترع شيئاً خارجها):\n\n${body}`;
}

module.exports = {
  extractText,
  repairMojibake,
  chunkText,
  embedOne,
  embedBatch,
  ingestDocument,
  retrieve,
  formatChunksForPrompt,
  vecToBuffer,
  bufferToVec,
  cosine,
  normalizeArabic,
  tokenizeQuery,
  keywordScore,
  TOP_K,
  MIN_SCORE,
  EMBED_MODEL,
};
