// Filing a customer request -- what the request tool does, on a call
// (routes/webhook.js) or in a WhatsApp conversation (services/whatsapp).
//
// Every outcome is a sentence for the model, never an error: there is a
// customer waiting, and a sentence telling it what to do lets it recover --
// ask for the confirmation it skipped, or pick a real request type.
const { REQUEST_TYPES, pickFields } = require('../lib/request-types');

/**
 * The company's own closing line for a filed request, e.g. "تم رفع طلبك وسيتم
 * التواصل معك خلال 72 ساعة عمل". Configured per company, because the promise
 * belongs to the company; with none set the model is told only that the
 * request was recorded, and no service-level commitment is invented for it.
 */
async function confirmationMessage(companyId, sql) {
  try {
    const row = await sql.getCompanyFeature.get(companyId, 'request_creation');
    const cfg = row?.config ? JSON.parse(row.config) : null;
    const msg = String(cfg?.confirmationMessage || '').trim();
    return msg || null;
  } catch {
    return null;
  }
}

/**
 * File (or update) one request from the tool's arguments.
 *
 * `conversationId` groups what belongs together: the same call (or WhatsApp
 * conversation) filing the same type again -- a provider retry, or the model
 * correcting an answer -- updates that request instead of filing a duplicate
 * lead. Null (a browser test) is never deduplicated.
 *
 * `contactPhone` is for a channel with no call record to join: the number the
 * customer wrote from, never one the model supplied. Stored as given, so the
 * caller passes it encrypted.
 *
 * Returns { result } for the model, plus { requestId, updated } when filed.
 */
async function fileRequest({ companyId, conversationId = null, body, channel = null, contactPhone = null }, { sql, logger }) {
  const b = body || {};
  const type = String(b.request_type || '').trim();
  if (!REQUEST_TYPES[type]) {
    const options = Object.entries(REQUEST_TYPES).map(([k, v]) => `${k} (${v.labelAr})`).join('، ');
    return { result: `نوع الطلب غير معروف. اختر واحداً من: ${options}` };
  }

  // Question 31: the customer confirms before anything is filed. The flag is
  // the model's own assertion, so it is a nudge rather than proof — but it
  // makes skipping the confirmation an explicit act instead of an oversight.
  const confirmed = b.customer_confirmed === true || String(b.customer_confirmed) === 'true';
  if (!confirmed) {
    return { result: 'لم يُسجَّل الطلب بعد. اقرأ البيانات على العميل واطلب تأكيده الصريح، ثم أعد المحاولة.' };
  }

  const fields = pickFields(type, b);
  try {
    const existing = conversationId
      ? await sql.getCustomerRequestByConversation.get(companyId, conversationId, type)
      : null;
    let requestId;
    if (existing) {
      // Merge so a second call that re-sends fewer fields cannot erase what
      // the first one captured.
      let prior = {};
      try { prior = existing.fields ? JSON.parse(existing.fields) : {}; } catch {}
      const merged = { ...prior, ...fields };
      await sql.updateCustomerRequestFields.run({
        id: existing.id, company_id: companyId,
        customer_name: merged.customer_name || null,
        fields: JSON.stringify(merged),
      });
      requestId = existing.id;
    } else {
      const r = await sql.insertCustomerRequest.run({
        company_id: companyId, conversation_id: conversationId,
        request_type: type, customer_name: fields.customer_name || null,
        fields: JSON.stringify(fields),
        channel, contact_phone: contactPhone,
      });
      requestId = r.lastInsertRowid;
    }
    logger.info('request tool: filed', {
      companyId, requestId, type, channel: channel || 'call', updated: !!existing, fieldCount: Object.keys(fields).length,
    });

    const closing = await confirmationMessage(companyId, sql);
    return {
      requestId, updated: !!existing,
      result: closing
        ? `تم تسجيل الطلب. أخبر العميل بهذا بأسلوبك: ${closing}`
        : 'تم تسجيل الطلب بنجاح.',
    };
  } catch (e) {
    logger.error('request tool: insert failed', { err: e.message, companyId, type });
    return { result: 'تعذّر تسجيل الطلب تقنياً. اعتذر للعميل وأخبره أن فريق المبيعات سيتواصل معه.' };
  }
}

module.exports = { fileRequest, confirmationMessage };
