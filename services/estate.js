// Estate integration service for sending attention/purchase requests
const fetch = require('node-fetch');

async function sendAttentionRequest(company, payload, deps) {
  const settings = company?.settings || {};
  const address = String(settings.estateAddress || '').trim().replace(/\/+$/, '');
  const token = deps?.decryptField ? deps.decryptField(settings.estateToken) : settings.estateToken;

  if (!address || !token) {
    return { ok: false, reason: 'Estate credentials not configured' };
  }

  const url = `${address}/api/v1/make/attention-request/attention-request-store`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      return { ok: true, data };
    } else {
      return { ok: false, reason: data?.message || `HTTP error ${res.status}` };
    }
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  sendAttentionRequest
};
