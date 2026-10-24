// A customer who tells the WhatsApp assistant they want to buy files a request
// the way a caller does: the reply model gets the voice agent's request tool --
// the same types and fields, the company's project list, the same explicit
// confirmation -- when the company has «استقبال الطلبات» on. The request lands
// on the requests page and, like a call's, goes on to the company's Estate.
//
// What differs from a call is where the customer's number comes from: the
// WhatsApp conversation itself (the number LoopChat delivered the message
// from), never the model. And there is no "call ended" to wait for, so the
// request goes to Estate as soon as the reply that confirms it has gone out.
const estate = require('../estate');
const { getFeature, requestToolDescription } = require('../features/registry');
const { fileRequest } = require('../requests');

const FEATURE = 'request_creation';
const TOOL = () => getFeature(FEATURE);

// Saudi time, as companies.js keeps it (TZ_OFFSET_HOURS), for the day below.
const TZ_OFFSET_MS = (Number(process.env.TZ_OFFSET_HOURS) || 3) * 3600 * 1000;

// What one request groups by: the customer's conversation on that number, per
// day. The model correcting an answer, or confirming twice, updates the same
// request; the same customer asking again another day files a new one.
function conversationKey(channelId, phone, now = Date.now()) {
  const day = new Date(now + TZ_OFFSET_MS).toISOString().slice(0, 10);
  return `wa:${channelId}:${phone}:${day}`;
}

// The request tool in OpenAI's function form, with this company's projects.
function toolFor(company) {
  const f = TOOL();
  return {
    type: 'function',
    function: {
      name: f.toolName,
      description: requestToolDescription('محادثة واتساب'),
      parameters: { type: 'object', properties: f.bodyPropertiesFor(company), required: f.bodyRequired },
    },
  };
}

// Offered only while the capability is on for the company.
async function toolsFor(company, deps) {
  return (await deps.featureEnabled(company.id, FEATURE)) ? [toolFor(company)] : null;
}

/**
 * One tool call from the reply model. Returns { result } for the model, plus
 * { requestId } when a request was filed or updated.
 */
async function runTool(name, argsJson, { company, channelId, phone }, deps) {
  if (name !== TOOL().toolName) return { result: 'أداة غير معروفة.' };
  let body;
  try { body = JSON.parse(argsJson || '{}'); } catch { body = null; }
  if (!body || typeof body !== 'object') return { result: 'تعذّرت قراءة بيانات الطلب. أعد المحاولة.' };
  // Asked again at the moment of filing, as the call tool's endpoint does.
  if (!(await deps.featureEnabled(company.id, FEATURE))) return { result: 'تسجيل الطلبات غير مفعّل لهذه الشركة.' };
  // The call tool's daily ceiling, for the same reason: a model stuck in a
  // loop would otherwise file a lead per message.
  const cap = deps.dailyCap(company, 'dailyRequestToolCap', 'DAILY_REQUEST_TOOL_CAP', 500);
  if (!(await deps.checkAndBumpUsage(company.id, 'request_tool', cap))) {
    deps.logger.warn('whatsapp: request tool daily cap reached', { companyId: company.id, cap });
    return { result: 'تعذّر تسجيل الطلب حالياً. أخبر العميل أن فريق المبيعات سيتواصل معه.' };
  }
  return fileRequest({
    companyId: company.id,
    conversationId: conversationKey(channelId, phone),
    body,
    channel: 'whatsapp',
    contactPhone: deps.encryptField(`+${phone}`),
  }, deps);
}

// On to Estate. `retry`: a correction to a request Estate refused, or one
// skipped for a missing name, goes again; one already sent never does.
async function toEstate(company, requestId, deps) {
  try {
    const row = await deps.sql.getRequestForEstate.get(requestId, company.id);
    return row ? await estate.pushRequest(company, row, deps, { retry: true }) : null;
  } catch (e) {
    deps.logger.error('whatsapp: request not sent to Estate', { err: e.message, companyId: company.id, requestId });
    return null;
  }
}

module.exports = { toolsFor, toolFor, runTool, toEstate, conversationKey };
