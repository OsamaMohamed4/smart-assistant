// End-to-end plumbing check for the three ElevenLabs endpoints, driven through
// the PUBLIC url (the tunnel) exactly as ElevenLabs will drive them.
//
//   node --use-system-ca scripts/elevenlabs-selftest.js
//   node --use-system-ca scripts/elevenlabs-selftest.js --company co-xxxx
//
// Proves, without a phone call or a published agent:
//   · the tunnel reaches this server
//   · post-call HMAC verification accepts a real signature and refuses a forged one
//   · the initiation webhook accepts the configured header and refuses a wrong one
//   · the KB tool accepts its minted company token and refuses a forged one
//   · a call row is written and attributed to the RIGHT company
//
// Every request is synthetic. Nothing is sent to ElevenLabs.
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const { sql } = require('../db');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2); const n = argv[i + 1];
    if (!n || n.startsWith('--')) out[k] = true; else { out[k] = n; i++; }
  }
  return out;
}
const args = parseArgs(process.argv);

const BASE = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const POST_SECRET = (process.env.ELEVENLABS_WEBHOOK_SECRET || '').trim();
const INIT_SECRET = (process.env.ELEVENLABS_INIT_WEBHOOK_SECRET || '').trim() || POST_SECRET;
const TOOL_SECRET = (process.env.ELEVENLABS_TOOL_SECRET || '').trim() || POST_SECRET;
const INIT_HEADER = 'x-elevenlabs-init-token';

let pass = 0; let fail = 0;
function check(ok, label, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

async function post(path, body, headers = {}) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw,
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

// Sign exactly as the provider does: HMAC-SHA256 over `${t}.${rawBody}`.
function signed(body) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const v0 = crypto.createHmac('sha256', POST_SECRET).update(`${t}.${raw}`).digest('hex');
  return { 'elevenlabs-signature': `t=${t},v0=${v0}` };
}

const RUN = Date.now().toString(36);
const CONV_ID = `conv_selftest_${RUN}`;

function transcriptionPayload({ agentNumber, external = '+966555000111' }) {
  return {
    type: 'post_call_transcription',
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      agent_id: `agent_selftest_${RUN}`,
      conversation_id: CONV_ID,
      status: 'done',
      transcript: [
        { role: 'agent', message: 'حياك الله، كيف أقدر أساعدك؟', time_in_call_secs: 0 },
        { role: 'user', message: 'أبغى شقة في الرياض', time_in_call_secs: 3 },
      ],
      metadata: {
        start_time_unix_secs: Math.floor(Date.now() / 1000) - 42,
        call_duration_secs: 42,
        cost: 296,
        charging: { dev_discount: false, tier: 'starter' },
        termination_reason: 'end_call tool was called',
        phone_call: {
          type: 'sip_trunking', direction: 'inbound',
          external_number: external, agent_number: agentNumber,
          call_sid: `sip-selftest-${RUN}`,
        },
      },
      analysis: {
        call_successful: 'success',
        transcript_summary: 'اتصل العميل يسأل عن شقة في الرياض.',
        data_collection_results: {},
        evaluation_criteria_results: {},
      },
    },
  };
}

async function main() {
  if (!/^https:\/\//i.test(BASE)) {
    console.error('PUBLIC_BASE_URL must be the public https tunnel URL. Got:', BASE || '(unset)');
    process.exit(1);
  }
  if (!POST_SECRET) { console.error('ELEVENLABS_WEBHOOK_SECRET is not set'); process.exit(1); }

  // Pick the company under test: the one whose DID we will pretend was dialled.
  const companies = await sql.listCompanies.all();
  const company = args.company
    ? companies.find((c) => c.id === args.company)
    : companies.find((c) => c.phone_number);
  if (!company) {
    console.error('No company with a phone_number to test against. Pass --company <id>.');
    process.exit(1);
  }
  if (!company.phone_number) {
    console.error(`Company ${company.id} has no phone_number — company resolution cannot be tested.`);
    process.exit(1);
  }

  console.log(`\n  base     ${BASE}`);
  console.log(`  company  ${company.id}  (${company.name})`);
  console.log(`  DID      ${company.phone_number}\n`);

  // ── 1. reachability ───────────────────────────────────────────
  const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch((e) => ({ err: e.message }));
  check(health.ok === true, 'tunnel reaches the server (/health)', JSON.stringify(health).slice(0, 200));

  // ── 2. post-call webhook: forged signature must be refused ────
  const payload = transcriptionPayload({ agentNumber: company.phone_number });
  const forged = await post('/webhook/elevenlabs', payload, {
    'elevenlabs-signature': `t=${Math.floor(Date.now() / 1000)},v0=deadbeef`,
  });
  check(forged.status === 401, 'post-call webhook REFUSES a forged signature', `got ${forged.status}`);

  // ── 3. post-call webhook: a real signature is accepted ────────
  const good = await post('/webhook/elevenlabs', payload, signed(payload));
  check(good.status === 200, 'post-call webhook accepts a valid signature', `got ${good.status} ${good.text.slice(0, 160)}`);

  // Processing is async after the ack; give it a moment.
  await new Promise((r) => setTimeout(r, 1500));

  // ── 4. the call row exists and is attributed correctly ────────
  const row = await sql.getCall.get(CONV_ID);
  check(!!row, 'a call row was written from the webhook');
  if (row) {
    check(row.company_id === company.id,
      `the call resolved to the RIGHT company (${company.id})`,
      `company_id = ${row.company_id}`);
    check(row.direction === 'inbound', 'direction stored as inbound', `direction = ${row.direction}`);
    check(!!row.transcript, 'transcript stored');
    check(!!row.summary, 'summary stored');
    check(Number(row.cost_credits) === 296, 'cost_credits captured from metadata.cost',
      `cost_credits = ${row.cost_credits}`);
    check(row.cost_usd === null || row.cost_usd === undefined,
      'cost_usd is null (no ELEVENLABS_USD_PER_CREDIT set — correct)',
      `cost_usd = ${row.cost_usd}`);
    check(!row.recording_url, 'recording_url is null, never a fake identifier',
      `recording_url = ${row.recording_url}`);
  }

  // ── 5. initiation webhook ─────────────────────────────────────
  const initBody = { caller_id: '+966555000111', agent_id: 'agent_unknown', called_number: company.phone_number, call_sid: 'x' };
  const initBad = await post('/webhook/elevenlabs/init', initBody, { [INIT_HEADER]: 'wrong-token' });
  check(initBad.status === 401, 'init webhook REFUSES a wrong token', `got ${initBad.status}`);

  const initNone = await post('/webhook/elevenlabs/init', initBody, {});
  check(initNone.status === 401, 'init webhook REFUSES a missing token', `got ${initNone.status}`);

  const initOk = await post('/webhook/elevenlabs/init', initBody, { [INIT_HEADER]: INIT_SECRET });
  check(initOk.status === 200, 'init webhook accepts the configured header', `got ${initOk.status}`);
  if (initOk.json) {
    check(initOk.json.type === 'conversation_initiation_client_data', 'init returns the expected envelope');
    const dv = initOk.json.dynamic_variables || {};
    check(dv.company_id === company.id,
      'init resolved the company from the DIALLED number',
      `company_id = ${dv.company_id}`);
    check(!!dv.company_name, 'init returns the company name', `company_name = ${dv.company_name}`);
  }

  // ── 6. KB tool authentication ─────────────────────────────────
  const mint = (id) => `${id}.${crypto.createHmac('sha256', TOOL_SECRET).update(String(id)).digest('base64url')}`;
  const kbBad = await post('/webhook/elevenlabs/tools/kb', { query: 'test' },
    { 'X-Company-Token': `${company.id}.forged` });
  check(kbBad.status === 401, 'KB tool REFUSES a forged company token', `got ${kbBad.status}`);

  const kbOk = await post('/webhook/elevenlabs/tools/kb', { query: 'ما هي مشاريعكم؟' },
    { 'X-Company-Token': mint(company.id) });
  check(kbOk.status === 200, 'KB tool accepts the minted company token', `got ${kbOk.status}`);
  if (kbOk.json) {
    console.log(`          KB replied: ${String(kbOk.json.result || '').slice(0, 120)}`);
  }

  // ── 7. the published agent, if there is one ───────────────────
  // Skipped rather than failed when the company has not been published yet:
  // everything above is meaningful on its own, and this section is what proves
  // the publish did what it claims.
  if (!company.elevenlabs_agent_id) {
    console.log('\n  (company not published yet — agent checks skipped)');
  } else {
    const key = (process.env.ELEVENLABS_API_KEY || '').trim();
    const base = (process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '');
    const r = await fetch(`${base}/v1/convai/agents/${company.elevenlabs_agent_id}`, {
      headers: { 'xi-api-key': key },
    });
    const agent = r.ok ? await r.json() : null;
    check(!!agent, `the published agent exists at ElevenLabs (${company.elevenlabs_agent_id})`, `HTTP ${r.status}`);
    if (agent) {
      const ps = agent.platform_settings || {};
      const ov = ps.overrides || {};
      check(ov.enable_conversation_initiation_client_data_from_webhook === true,
        'initiation webhook is ENABLED on the agent (else inbound calls lose company context)',
        `flag = ${ov.enable_conversation_initiation_client_data_from_webhook}`);
      check(Object.keys(ps.data_collection || {}).length > 0,
        'post-call data collection fields are configured',
        `${Object.keys(ps.data_collection || {}).length} field(s)`);
      const cc = agent.conversation_config || {};
      const toolIds = cc.agent?.prompt?.tool_ids || [];
      // A company with no knowledge base SHOULD have no KB tool — server.js
      // attaches it only when kbChunkCount > 0. Failing that configuration would
      // be reporting correct behaviour as broken. The real defect is an index
      // that exists while the tool is missing, so only assert when there are
      // chunks to search.
      const kbChunks = Number((await sql.countCompanyChunks.get(company.id))?.n || 0);
      if (kbChunks === 0) {
        console.log('  SKIP  knowledge-base tool — company has 0 KB chunks, so no tool is expected');
        console.log('          upload a document and re-publish if you want to test RAG in a call');
      } else {
        check(toolIds.length > 0,
          `the knowledge-base tool is attached (${kbChunks} chunk(s) indexed)`,
          `tool_ids = ${JSON.stringify(toolIds)} — publish ran before the documents were indexed; re-publish`);
      }
      check(String(cc.agent?.language || '').startsWith('ar'),
        'agent language is Arabic', `language = ${cc.agent?.language}`);
    }
  }

  console.log(`\n  ${fail === 0 ? 'SELF-TEST OK' : 'SELF-TEST FAILED'} — ${pass} passed, ${fail} failed`);
  console.log(`  test call row: ${CONV_ID}  (delete it from the UI, or leave it)\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nself-test error:', e.message); process.exit(1); });
