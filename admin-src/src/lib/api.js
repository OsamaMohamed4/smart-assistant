// All API calls relative to current origin (proxied in dev, same-origin in prod).
// `credentials: 'include'` so the session cookie travels with each request.

let onUnauthenticated = null;

export function setUnauthenticatedHandler(fn) { onUnauthenticated = fn; }

async function request(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type'    : 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(opts.headers || {}),
    },
    ...opts,
  });
  if (res.status === 401 && onUnauthenticated && !path.startsWith('/api/auth/')) {
    onUnauthenticated();
  }
  if (!res.ok) {
    let err;
    try { err = await res.json(); } catch { err = { error: res.statusText }; }
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  // auth
  signup            : (body) => request('/api/auth/signup',  { method: 'POST', body: JSON.stringify(body) }),
  login             : (body) => request('/api/auth/login',   { method: 'POST', body: JSON.stringify(body) }),
  logout            : ()     => request('/api/auth/logout',  { method: 'POST', body: '{}' }),
  me                : ()     => request('/api/auth/me'),
  changePassword    : (body) => request('/api/auth/change-password', { method: 'POST', body: JSON.stringify(body) }),

  bootstrapOpen     : () => request('/api/auth/bootstrap'),

  // clients (per-company, owner+superadmin)
  listClients       : (companyId) => request(`/api/companies/${companyId}/clients`),
  createClient      : (companyId, body) => request(`/api/companies/${companyId}/clients`, { method: 'POST', body: JSON.stringify(body) }),
  deleteClient      : (companyId, userId) => request(`/api/companies/${companyId}/clients/${userId}`, { method: 'DELETE' }),

  // dashboard
  dashboard         : ({ period = 'today', companyId, from, to } = {}) => {
    const params = new URLSearchParams({ period });
    if (companyId) params.set('companyId', companyId);
    if (from)      params.set('from', from);
    if (to)        params.set('to', to);
    return request(`/api/dashboard?${params.toString()}`);
  },

  // conversations (chats + calls, unified)
  conversations     : ({
    period = 'all', type = 'all', status = 'all', outcome = 'all',
    search = '', companyId, page = 1, limit = 10,
  } = {}) => {
    const params = new URLSearchParams({
      period, type, status, outcome,
      page: String(page), limit: String(limit),
    });
    if (companyId) params.set('companyId', companyId);
    if (search)    params.set('search', search);
    return request(`/api/conversations?${params.toString()}`);
  },

  // companies
  listCompanies     : () => request('/api/companies'),
  getCompany        : (id) => request(`/api/companies/${id}`),
  createCompany     : (body) => request('/api/companies', { method: 'POST', body: JSON.stringify(body) }),
  updateCompany     : (id, body) => request(`/api/companies/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteCompany     : (id) => request(`/api/companies/${id}`, { method: 'DELETE' }),
  syncVapi          : (id) => request(`/api/companies/${id}/sync-vapi`, { method: 'POST', body: '{}' }),
  updateCompanySettings: (id, settings) => request(`/api/companies/${id}/settings`, { method: 'PATCH', body: JSON.stringify(settings) }),
  bindPhone         : (id) => request(`/api/companies/${id}/bind-phone`, { method: 'POST', body: '{}' }),

  // API keys (public Agent API)
  listApiKeys       : (id) => request(`/api/companies/${id}/api-keys`),
  createApiKey      : (id, name) => request(`/api/companies/${id}/api-keys`, { method: 'POST', body: JSON.stringify({ name }) }),
  revokeApiKey      : (id, keyId) => request(`/api/companies/${id}/api-keys/${keyId}`, { method: 'DELETE' }),

  // Campaigns (outbound dialer)
  listCampaigns     : (id) => request(`/api/companies/${id}/campaigns`),
  createCampaign    : (id, body) => request(`/api/companies/${id}/campaigns`, { method: 'POST', body: JSON.stringify(body) }),
  getCampaign       : (id, campaignId) => request(`/api/companies/${id}/campaigns/${campaignId}`),
  startCampaign     : (id, campaignId) => request(`/api/companies/${id}/campaigns/${campaignId}/start`, { method: 'POST', body: '{}' }),
  pauseCampaign     : (id, campaignId) => request(`/api/companies/${id}/campaigns/${campaignId}/pause`, { method: 'POST', body: '{}' }),
  cancelCampaign    : (id, campaignId) => request(`/api/companies/${id}/campaigns/${campaignId}/cancel`, { method: 'POST', body: '{}' }),

  // Evals (golden questions + runs)
  listEvalQuestions : (id) => request(`/api/companies/${id}/evals/questions`),
  addEvalQuestion   : (id, body) => request(`/api/companies/${id}/evals/questions`, { method: 'POST', body: JSON.stringify(body) }),
  deleteEvalQuestion: (id, qid) => request(`/api/companies/${id}/evals/questions/${qid}`, { method: 'DELETE' }),
  listEvalRuns      : (id) => request(`/api/companies/${id}/evals/runs`),
  getEvalRun        : (id, runId) => request(`/api/companies/${id}/evals/runs/${runId}`),
  runEval           : (id, body = {}) => request(`/api/companies/${id}/evals/runs`, { method: 'POST', body: JSON.stringify(body) }),

  // Audit log (superadmin)
  listAudit         : (limit = 100, action = '') => request(`/api/_admin/audit?limit=${limit}${action ? `&action=${encodeURIComponent(action)}` : ''}`),

  // sessions
  listSessions      : (companyId, limit = 50) => request(`/api/companies/${companyId}/sessions?limit=${limit}`),
  getSession        : (sessionId) => request(`/api/sessions/${sessionId}`),
  summarizeSession  : (sessionId) => request(`/api/sessions/${sessionId}/summarize`, { method: 'POST', body: '{}' }),

  // calls
  listCalls         : (companyId, limit = 50) => request(`/api/companies/${companyId}/calls?limit=${limit}`),
  getCall           : (id) => request(`/api/calls/${id}`),
  summarizeCall     : (id) => request(`/api/calls/${id}/summarize`, { method: 'POST', body: '{}' }),

  // chat (playground)
  chat              : (body) => request('/chat', { method: 'POST', body: JSON.stringify(body) }),

  // playground voice catalog (3 Saudi voices)
  listVoices        : () => request('/api/voices'),

  // currently-active scenario for a company (null if none) — used by playground
  // to render the input-data form.
  activeScenario    : (companyId) => request(`/api/companies/${companyId}/scenarios/active`),

  // Vapi calls the user's phone using the company's synced assistant.
  outboundCall      : (companyId, body) => request(`/api/companies/${companyId}/outbound-call`, {
    method: 'POST', body: JSON.stringify(body),
  }),
  // Text chat against the Vapi assistant — same prompt, no audio.
  assistantChat     : (companyId, body) => request(`/api/companies/${companyId}/assistant-chat`, {
    method: 'POST', body: JSON.stringify(body),
  }),

  // scenarios (per-company AI agents)
  listScenarios     : (companyId, tab = 'active') => request(`/api/companies/${companyId}/scenarios?tab=${tab}`),
  getScenario       : (id) => request(`/api/scenarios/${id}`),
  createScenario    : (companyId, body) => request(`/api/companies/${companyId}/scenarios`, {
    method: 'POST', body: JSON.stringify(body),
  }),
  updateScenario    : (id, body) => request(`/api/scenarios/${id}`, {
    method: 'PATCH', body: JSON.stringify(body),
  }),
  activateScenario  : (id, isActive) => request(`/api/scenarios/${id}/activate`, {
    method: 'POST', body: JSON.stringify({ isActive }),
  }),
  deleteScenario    : (id) => request(`/api/scenarios/${id}`, { method: 'DELETE' }),
  generateScenario  : (companyId, body) => request(`/api/companies/${companyId}/scenarios/generate`, {
    method: 'POST', body: JSON.stringify(body),
  }),
  // Live scenario linter — returns TTS/prompt warnings for the given text.
  lintScenario      : (text) => request('/api/scenarios/lint', {
    method: 'POST', body: JSON.stringify({ text }),
  }),
  // Test an unsaved draft scenario against the model (+ company KB).
  testDraftScenario : (companyId, body) => request(`/api/companies/${companyId}/scenarios/test-draft`, {
    method: 'POST', body: JSON.stringify(body),
  }),
  // Preview the exact composed system prompt (scenario + KB + endCall).
  previewPrompt     : (companyId, body) => request(`/api/companies/${companyId}/scenarios/preview-prompt`, {
    method: 'POST', body: JSON.stringify(body || {}),
  }),
  // Vetted starting templates.
  scenarioTemplates : () => request('/api/scenario-templates'),
  // Scenario version history + rollback.
  listScenarioVersions : (id) => request(`/api/scenarios/${id}/versions`),
  rollbackScenario     : (id, versionId) => request(`/api/scenarios/${id}/rollback/${versionId}`, {
    method: 'POST', body: '{}',
  }),

  // RAG: documents
  listDocuments     : (companyId) => request(`/api/companies/${companyId}/documents`),
  uploadDocument    : async (companyId, file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/companies/${companyId}/documents`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      body: form,
    });
    if (res.status === 401 && onUnauthenticated) onUnauthenticated();
    if (!res.ok) {
      let err; try { err = await res.json(); } catch { err = { error: res.statusText }; }
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  },
  deleteDocument    : (companyId, docId) => request(`/api/companies/${companyId}/documents/${docId}`, { method: 'DELETE' }),
  ragTest           : (companyId, query) => request(`/api/companies/${companyId}/rag-test`, {
    method: 'POST', body: JSON.stringify({ query }),
  }),
};
