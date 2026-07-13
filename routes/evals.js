// Eval harness API. Mounted at /api/companies/:id/evals (mergeParams) behind
// requireAuth + requireCompanyAccess.
const express = require('express');
const { sql } = require('../db');
const { requireCompanyAccess } = require('../lib/auth');
const { audit } = require('../lib/audit');
const { loadCompany } = require('../companies');
const { runEval } = require('../services/evals');

const router = express.Router({ mergeParams: true });
router.use(requireCompanyAccess);

// ─── Golden questions CRUD ───────────────────────────────────────
router.get('/questions', async (req, res) => {
  res.json(await sql.listEvalQuestions.all(req.params.id));
});

router.post('/questions', async (req, res) => {
  const question = String(req.body?.question || '').trim().slice(0, 1000);
  const expected = String(req.body?.expected || '').trim().slice(0, 2000);
  if (!question || !expected) return res.status(400).json({ error: 'السؤال والإجابة المتوقعة مطلوبان' });
  const r = await sql.insertEvalQuestion.run({ company_id: req.params.id, question, expected });
  audit(req, 'eval.question_add', `companies/${req.params.id}`, { id: Number(r.lastInsertRowid) });
  res.status(201).json({ id: Number(r.lastInsertRowid), question, expected });
});

router.delete('/questions/:qid', async (req, res) => {
  const r = await sql.deleteEvalQuestion.run(Number(req.params.qid), req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'not found' });
  res.json({ deleted: 1 });
});

// ─── Runs ────────────────────────────────────────────────────────
router.get('/runs', async (req, res) => {
  res.json(await sql.listEvalRuns.all(req.params.id));
});

router.get('/runs/:runId', async (req, res) => {
  const run = await sql.getEvalRun.get(Number(req.params.runId), req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  try { run.results = JSON.parse(run.results || '[]'); } catch { run.results = []; }
  res.json(run);
});

// Run against the ACTIVE scenario, or a DRAFT prompt (the practical A/B:
// score the draft before publishing and compare with the last active run).
router.post('/runs', async (req, res) => {
  const company = await loadCompany(req.params.id);
  if (!company) return res.status(404).json({ error: 'not found' });

  let instructionPrompt = null;
  let label = 'active';
  const draft = req.body?.instructionPrompt;
  if (typeof draft === 'string' && draft.trim()) {
    instructionPrompt = draft.trim().slice(0, 30000);
    label = 'draft';
  } else {
    const scenario = await sql.getActiveScenarioForCompany.get(company.id);
    if (!scenario?.instruction_prompt) {
      return res.status(409).json({ error: 'لا يوجد سيناريو مفعّل — فعّل سيناريو أو مرّر مسودة' });
    }
    instructionPrompt = scenario.instruction_prompt;
  }

  try {
    const run = await runEval(company, instructionPrompt, label);
    audit(req, 'eval.run', `companies/${company.id}`, { runId: run.id, label, score: run.score });
    res.json(run);
  } catch (e) {
    if (e.code === 'NO_QUESTIONS') {
      return res.status(409).json({ error: 'أضف أسئلة ذهبية أولاً' });
    }
    req.log.error('eval run failed', { err: e.message, companyId: company.id });
    res.status(502).json({ error: 'تعذر تشغيل الاختبار: ' + String(e.message).slice(0, 200) });
  }
});

module.exports = router;
