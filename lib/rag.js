// RAG pipeline: extract -> chunk -> embed -> retrieve.
require('dotenv').config();
const OpenAI = require('openai');
const { sql } = require('../db');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 1 });

const EMBED_MODEL     = 'text-embedding-3-small';  // 1536 dims, cheap, fast
const EMBED_DIMS      = 1536;
const CHUNK_WORDS     = 300;                       // target words per chunk
const CHUNK_OVERLAP   = 60;                        // overlap between adjacent chunks
const MIN_CHUNK_WORDS = 15;                        // smallest chunk we keep
const TOP_K           = 4;                         // chunks returned per query
const MAX_CHUNKS_PER_DOC = 500;                    // hard ceiling: rejects ingest if exceeded
const MAX_RAW_TEXT_CHARS = 2_000_000;              // ~2MB of text → defensive cap
const MIN_SCORE       = 0.20;                      // cosine threshold

// ─── Text extraction ──────────────────────────────────────────
async function extractText(buffer, mime, filename) {
  const ext = (filename || '').toLowerCase().split('.').pop();
  const m = (mime || '').toLowerCase();

  if (m.includes('pdf') || ext === 'pdf') {
    const { pdf } = require('pdf-parse');
    const data = await pdf(buffer);
    return data.text || '';
  }
  if (m.includes('officedocument.wordprocessingml') || ext === 'docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }
  if (m.startsWith('text/') || ext === 'txt' || ext === 'md' || ext === 'markdown') {
    return buffer.toString('utf8');
  }
  throw new Error(`Unsupported file type: ${mime || ext}`);
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
  const r = await openai.embeddings.create({ model: EMBED_MODEL, input: texts });
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
  const docResult = sql.insertDocument.run({
    company_id : companyId,
    filename   : filename,
    mime_type  : mime || null,
    size_bytes : buffer.length,
    raw_text   : text,
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
      sql.insertChunk.run({
        company_id : companyId,
        document_id: documentId,
        chunk_index: chunkIndex++,
        text       : batch[j],
        embedding  : vecToBuffer(vectors[j]),
        token_count: Math.ceil(batch[j].length / 4), // rough estimate
      });
    }
  }

  return { documentId, chunkCount: chunks.length, textLength: text.length };
}

// ─── Retrieval ────────────────────────────────────────────────
async function retrieve(companyId, query, { topK = TOP_K, minScore = MIN_SCORE } = {}) {
  const countRow = sql.countCompanyChunks.get(companyId);
  if (!countRow || !countRow.n) return [];

  const qVec = await embedOne(query);
  const qVecF32 = new Float32Array(qVec);

  const rows = sql.listCompanyChunks.all(companyId);
  const scored = rows.map((r) => ({
    id         : r.id,
    documentId : r.document_id,
    text       : r.text,
    score      : cosine(qVecF32, bufferToVec(r.embedding)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score >= minScore).slice(0, topK);
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
  chunkText,
  embedOne,
  embedBatch,
  ingestDocument,
  retrieve,
  formatChunksForPrompt,
  vecToBuffer,
  bufferToVec,
  cosine,
  TOP_K,
  MIN_SCORE,
};
