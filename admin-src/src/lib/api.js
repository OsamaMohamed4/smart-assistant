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
  // The other companies a client account may also work in (superadmin only).
  setClientCompanies: (companyId, userId, companyIds) => request(`/api/companies/${companyId}/clients/${userId}/companies`, {
    method: 'PUT', body: JSON.stringify({ companyIds }),
  }),
  // Invoices: contracts and sending are superadmin-only; a company lists its own.
  billingProfile    : () => request('/api/billing/profile'),
  saveBillingProfile: (body) => request('/api/billing/profile', { method: 'PUT', body: JSON.stringify(body) }),
  testMail          : (to) => request('/api/mail/test', { method: 'POST', body: JSON.stringify({ to }) }),
  companyContract   : (companyId) => request(`/api/companies/${companyId}/contract`),
  saveCompanyContract: (companyId, body) => request(`/api/companies/${companyId}/contract`, { method: 'PUT', body: JSON.stringify(body) }),
  listInvoices      : (companyId) => request(`/api/companies/${companyId}/invoices`),
  invoicePreview    : (companyId, month) => request(`/api/companies/${companyId}/invoices/preview?month=${encodeURIComponent(month)}`),
  issueInvoice      : (companyId, month) => request(`/api/companies/${companyId}/invoices`, { method: 'POST', body: JSON.stringify({ month }) }),
  resendInvoice     : (invoiceId) => request(`/api/invoices/${invoiceId}/send`, { method: 'POST', body: '{}' }),
  // WhatsApp (superadmin): the company's LoopChat account as it stands, its
  // settings, and its own LoopChat token (write-only).
  whatsappOverview  : (companyId) => request(`/api/whatsapp/overview?companyId=${encodeURIComponent(companyId || '')}`),
  companyWhatsapp   : (companyId) => request(`/api/companies/${companyId}/whatsapp`),
  saveCompanyWhatsapp: (companyId, body) => request(`/api/companies/${companyId}/whatsapp`, { method: 'PUT', body: JSON.stringify(body) }),
  saveCompanyWhatsappToken: (companyId, token) => request(`/api/companies/${companyId}/whatsapp/token`, { method: 'PUT', body: JSON.stringify({ token }) }),
  // Forgotten password: request a link, check it, set the new password.
  forgotPassword    : (email) => request('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),
  checkResetLink    : (token) => request(`/api/auth/reset-password?token=${encodeURIComponent(token)}`),
  resetPassword     : (token, password) => request('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) }),
  // E-mail a client their sign-in link (superadmin).
  sendClientAccess  : (companyId, userId) => request(`/api/companies/${companyId}/clients/${userId}/send-access`, { method: 'POST', body: '{}' }),
  // Move this session to another company granted to the account.
  switchCompany     : (companyId) => request('/api/auth/switch-company', { method: 'POST', body: JSON.stringify({ companyId }) }),
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

  // consumption per company for one Saudi month (YYYY-MM), inbound/outbound apart
  usage             : ({ month, companyId } = {}) => {
    const params = new URLSearchParams();
    if (month)     params.set('month', month);
    if (companyId) params.set('companyId', companyId);
    return request(`/api/usage?${params.toString()}`);
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
  // Publish the company's active scenario to its voice agent. Provider-neutral
  // name: which provider runs the call is a backend detail.
  syncVoice         : (id) => request(`/api/companies/${id}/sync-voice`, { method: 'POST', body: '{}' }),
  updateCompanySettings: (id, settings) => request(`/api/companies/${id}/settings`, { method: 'PATCH', body: JSON.stringify(settings) }),
  // Point the company's own number at its own agent (which agent answers when
  // someone dials the company's 3CX line).
  bindPhone         : (id) => request(`/api/companies/${id}/bind-phone`, { method: 'POST', body: '{}' }),
  // What a company that has chosen nothing is published with (the reference
  // agent's settings), plus the LLMs a company may pick.
  agentDefaults     : () => request('/api/agent-defaults'),
  // Register the company's EXISTING 3CX number with the voice provider. No
  // number is ever purchased: this hands the provider the DID the company
  // already owns plus the address of their own PBX, so the provider knows how
  // to reach it. Superadmin-only server-side — it writes the tenant↔phone-line
  // binding and accepts SIP credentials.
  importPhone       : (id, body) => request(`/api/companies/${id}/import-phone`, { method: 'POST', body: JSON.stringify(body) }),

  // API keys (public Agent API)
  listApiKeys       : (id) => request(`/api/companies/${id}/api-keys`),
  createApiKey      : (id, name) => request(`/api/companies/${id}/api-keys`, { method: 'POST', body: JSON.stringify({ name }) }),
  revokeApiKey      : (id, keyId) => request(`/api/companies/${id}/api-keys/${keyId}`, { method: 'DELETE' }),
  // Issue a client a new password. Returns it once; the server keeps only the
  // hash, so a closed dialog means it is gone for good.
  resetClientPassword: (id, userId) => request(`/api/companies/${id}/clients/${userId}/reset-password`, { method: 'POST', body: '{}' }),

  // Campaigns (outbound dialer)
  listCampaigns     : (id) => request(`/api/companies/${id}/campaigns`),
  createCampaign    : (id, body) => request(`/api/companies/${id}/campaigns`, { method: 'POST', body: JSON.stringify(body) }),
  getCampaign       : (id, campaignId) => request(`/api/companies/${id}/campaigns/${campaignId}`),
  startCampaign     : (id, campaignId) => request(`/api/companies/${id}/campaigns/${campaignId}/start`, { method: 'POST', body: '{}' }),
  pauseCampaign     : (id, campaignId) => request(`/api/companies/${id}/campaigns/${campaignId}/pause`, { method: 'POST', body: '{}' }),
  cancelCampaign    : (id, campaignId) => request(`/api/companies/${id}/campaigns/${campaignId}/cancel`, { method: 'POST', body: '{}' }),
  // Diagnostics: why is a campaign (not) dialing, and force one tick now.
  campaignDiagnose  : (id, campaignId) => request(`/api/companies/${id}/campaigns/${campaignId}/diagnose`),
  campaignRunNow    : (id, campaignId) => request(`/api/companies/${id}/campaigns/${campaignId}/run-now`, { method: 'POST', body: '{}' }),
  // Campaign report. `filters` mirrors the server's query params exactly, so
  // the CSV export below returns the same rows the table is showing.
  campaignReport    : (id, campaignId, filters = {}) => {
    const qs = new URLSearchParams(
      Object.entries(filters).filter(([, v]) => v !== '' && v !== null && v !== undefined && v !== 'all'),
    ).toString();
    return request(`/api/companies/${id}/campaigns/${campaignId}/report${qs ? `?${qs}` : ''}`);
  },
  campaignReportCsvUrl: (id, campaignId, filters = {}) => {
    const qs = new URLSearchParams(
      Object.entries(filters).filter(([, v]) => v !== '' && v !== null && v !== undefined && v !== 'all'),
    ).toString();
    return `/api/companies/${id}/campaigns/${campaignId}/report.csv${qs ? `?${qs}` : ''}`;
  },

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

  // voice catalogue (منى، ناصر); the platform default carries isDefault
  listVoices        : () => request('/api/voices'),

  // currently-active scenario for a company (null if none) — used by playground
  // to render the input-data form.
  activeScenario    : (companyId) => request(`/api/companies/${companyId}/scenarios/active`),

  // Rings the given phone from the company's OWN number, using its own agent.
  outboundCall      : (companyId, body) => request(`/api/companies/${companyId}/outbound-call`, {
    method: 'POST', body: JSON.stringify(body),
  }),
  // Text chat against the same scenario + knowledge base — same prompt, no audio.
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

  // Company facts (business profile). Saving does NOT change the live agent —
  // publishing does — so the save response carries `needsPublish`.
  getBusinessProfile: (companyId) => request(`/api/companies/${companyId}/business-profile`),
  saveBusinessProfile: (companyId, businessProfile) =>
    request(`/api/companies/${companyId}/business-profile`, {
      method: 'PATCH', body: JSON.stringify({ businessProfile }),
    }),
  // Render an UNSAVED draft. Server-side on purpose: a preview re-implemented
  // in the browser would drift from what publishing actually sends.
  previewBusinessProfile: (companyId, businessProfile) =>
    request(`/api/companies/${companyId}/business-profile/preview`, {
      method: 'POST', body: JSON.stringify({ businessProfile }),
    }),
  // Exactly what a publish would send to the provider, without sending it.
  publishPreview    : (companyId) => request(`/api/companies/${companyId}/publish-preview`),

  // Capabilities: what this company's agent is allowed to do.
  listFeatures      : (companyId) => request(`/api/companies/${companyId}/features`),
  // `config` is optional; omitted, the server keeps whatever is stored.
  setFeature        : (companyId, key, enabled, config) =>
    request(`/api/companies/${companyId}/features/${key}`, {
      method: 'PATCH',
      body: JSON.stringify(config === undefined ? { enabled } : { enabled, config }),
    }),
  // Requests the agent filed, for the sales team to follow up.
  listRequests      : (companyId, { status, type } = {}) => {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (type) q.set('type', type);
    const qs = q.toString();
    return request(`/api/companies/${companyId}/requests${qs ? `?${qs}` : ''}`);
  },
  updateRequest     : (companyId, requestId, body) =>
    request(`/api/companies/${companyId}/requests/${requestId}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
  // The company's own Estate (superadmin): settings, its key (write-only), a
  // check of both, and sending one request by hand.
  companyEstate     : (companyId) => request(`/api/companies/${companyId}/estate`),
  saveCompanyEstate : (companyId, body) => request(`/api/companies/${companyId}/estate`, { method: 'PUT', body: JSON.stringify(body) }),
  saveCompanyEstateToken: (companyId, token) => request(`/api/companies/${companyId}/estate/token`, { method: 'PUT', body: JSON.stringify({ token }) }),
  checkCompanyEstate: (companyId, url) => request(`/api/companies/${companyId}/estate/check`, { method: 'POST', body: JSON.stringify({ url }) }),
  sendRequestToEstate: (companyId, requestId) => request(`/api/companies/${companyId}/requests/${requestId}/estate`, { method: 'POST', body: '{}' }),
};
