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

  // companies
  listCompanies     : () => request('/api/companies'),
  getCompany        : (id) => request(`/api/companies/${id}`),
  createCompany     : (body) => request('/api/companies', { method: 'POST', body: JSON.stringify(body) }),
  updateCompany     : (id, body) => request(`/api/companies/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteCompany     : (id) => request(`/api/companies/${id}`, { method: 'DELETE' }),
  syncVapi          : (id) => request(`/api/companies/${id}/sync-vapi`, { method: 'POST', body: '{}' }),
  bindPhone         : (id) => request(`/api/companies/${id}/bind-phone`, { method: 'POST', body: '{}' }),

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
