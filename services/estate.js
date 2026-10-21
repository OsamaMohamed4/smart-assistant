// Estate integration: send the agent's purchase/rental leads on to the company's own Estate instance.
// Map internal request_type to Estate's label expected by their API.
const ESTATE_TYPES = {
  buy_villa     : 'فيلا',
  buy_duplex    : 'دوبلكس',
  buy_apartment : 'شقة',
  buy_land      : 'أرض',
  buy_floor     : 'دور',
  buy_building  : 'عمارة',
  rent_villa    : 'فيلا',
  rent_apartment: 'شقة',
  rent_floor    : 'دور',
  rent_commercial: 'تجاري',
};

function isRentType(type) {
  return String(type || '').startsWith('rent_');
}

function estateHost(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!u.hostname.endsWith('.e-statee.com') && u.hostname !== 'e-statee.com') return null;
    return u.origin;
  } catch (e) {
    return null;
  }
}

async function forwardRequestToEstate(company, req, deps) {
  const { sql, logger, decryptField } = deps;
  if (!company?.id || !req?.id) return { skipped: 'no req' };

  const host = estateHost(company.estate_address);
  const token = decryptField(company.estate_token);
  if (!company.estate_enabled || !host || !token) {
    return { skipped: 'not configured' };
  }

  // Claim the lead once so parallel triggers or retries won't double-send.
  const claim = sql.claimEstateRequest.run(company.id, req.id);
  if (!claim.changes) return { skipped: 'already processed' };

  const isRent = isRentType(req.request_type);
  const path = isRent ? '/api/v1/make/renter-request/renter-request-store' : '/api/v1/make/attention-request/attention-request-store';
  const url = `${host}${path}`;

  const payload = {
    name    : req.customer_name || 'عميل محتمل',
    phone   : req.customer_phone || '',
    platform: 'فحص الاتصال',
    notes   : req.notes || req.summary || '',
  };
  const typeLabel = ESTATE_TYPES[req.request_type];
  if (typeLabel) payload.type = typeLabel;

  try {
    const res = await fetch(url, {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'Authorization': `Bearer ${token}`,
        'Accept'       : 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const ok = res.status >= 200 && res.status < 300;
    let detail = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.message) detail = String(data.message).slice(0, 500);
    } catch (e) {}

    sql.finishEstateRequest.run(company.id, req.id, ok ? 'sent' : 'failed', detail);
    if (!ok) logger.warn('estate: POST failed', { companyId: company.id, reqId: req.id, status: res.status, detail });
    return ok ? { sent: true } : { failed: detail };
  } catch (err) {
    const detail = String(err.message || 'network error').slice(0, 500);
    sql.finishEstateRequest.run(company.id, req.id, 'failed', detail);
    logger.error('estate: request failed', { companyId: company.id, reqId: req.id, err: err.message });
    return { failed: detail };
  }
}

module.exports = { estateHost, forwardRequestToEstate };
