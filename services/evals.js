// Eval harness: runs the company's golden questions through the SAME answer
// pipeline the agent uses (scenario prompt + RAG), then grades each answer
// against the expected one with an LLM judge. Turns prompt editing from
// vibes into a score — and running it on a DRAFT prompt before publishing
// is the practical A/B: compare the draft's score to the active scenario's.
const OpenAI = require('openai');
const { sql } = require('../db');
const { fillGlobals } = require('../companies');
const { retrieve, formatChunksForPrompt } = require('../lib/rag');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 1 });

const MAX_QUESTIONS = 50;
const CONCURRENCY = 3;
const JUDGE_MODEL = 'gpt-4.1-mini';

// Answer one question exactly like the live agent would: scenario prompt
// (globals filled) + retrieved KB chunks + the question.
async function answerQuestion(company, instructionPrompt, question, model) {
  let system = fillGlobals(instructionPrompt, company);
  try {
    const chunks = await retrieve(company.id, question);
    if (chunks.length) system += formatChunksForPrompt(chunks);
  } catch { /* no RAG → prompt-only answer */ }

  const r = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: 400,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: question },
    ],
  });
  return (r.choices[0]?.message?.content || '').trim();
}

async function judgeAnswer(question, expected, actual) {
  const r = await openai.chat.completions.create({
    model: JUDGE_MODEL,
    temperature: 0,
    max_tokens: 200,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'أنت مقيّم جودة لإجابات وكيل خدمة عملاء عقاري. قارن إجابة الوكيل بالإجابة المتوقعة من حيث الحقائق (الأسعار، الأرقام، المعلومات الجوهرية). أعد JSON فقط: {"verdict":"correct"|"partial"|"wrong","reason":"سبب مختصر بالعربية"}. correct = الحقائق الجوهرية مطابقة، partial = صحيحة جزئياً أو ناقصة، wrong = خاطئة أو مختلقة أو رفض الإجابة رغم توفر المعلومة.',
      },
      {
        role: 'user',
        content: `السؤال: ${question}\n\nالإجابة المتوقعة: ${expected}\n\nإجابة الوكيل: ${actual}`,
      },
    ],
  });
  try {
    const j = JSON.parse(r.choices[0]?.message?.content || '{}');
    const verdict = ['correct', 'partial', 'wrong'].includes(j.verdict) ? j.verdict : 'wrong';
    return { verdict, reason: String(j.reason || '').slice(0, 300) };
  } catch {
    return { verdict: 'wrong', reason: 'judge parse error' };
  }
}

// Run the full eval. `instructionPrompt` may be the active scenario's prompt
// or a draft; `label` names the run ('active' / 'draft').
async function runEval(company, instructionPrompt, label) {
  const questions = (await sql.listEvalQuestions.all(company.id)).slice(0, MAX_QUESTIONS);
  if (!questions.length) throw Object.assign(new Error('NO_QUESTIONS'), { code: 'NO_QUESTIONS' });

  const model = ['gpt-4.1', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4o-mini'].includes(company.settings?.model)
    ? company.settings.model : 'gpt-4.1';

  const results = [];
  // Bounded concurrency without deps.
  let idx = 0;
  async function workerLoop() {
    while (idx < questions.length) {
      const q = questions[idx++];
      try {
        const answer = await answerQuestion(company, instructionPrompt, q.question, model);
        const { verdict, reason } = await judgeAnswer(q.question, q.expected, answer);
        results.push({ questionId: q.id, question: q.question, expected: q.expected, answer, verdict, reason });
      } catch (e) {
        results.push({ questionId: q.id, question: q.question, expected: q.expected, answer: null, verdict: 'error', reason: e.message.slice(0, 200) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, questions.length) }, workerLoop));

  const correct = results.filter((r) => r.verdict === 'correct').length;
  const partial = results.filter((r) => r.verdict === 'partial').length;
  const total   = results.length;
  const score   = total ? Math.round(((correct + 0.5 * partial) / total) * 100) : 0;

  const run = await sql.insertEvalRun.run({
    company_id: company.id,
    label     : String(label || 'active').slice(0, 60),
    score, total, correct, partial,
    results   : JSON.stringify(results),
  });

  return { id: Number(run.lastInsertRowid), label, score, total, correct, partial, results };
}

module.exports = { runEval };
