// LoopChat WhatsApp templates client.
// Wraps the public /api/v1/whatsapp/templates/deliver endpoint so we can
// send an approved WhatsApp template (e.g. a post-call notification) to a
// customer's phone without keeping a logged-in session.
//
// Authentication: the PDF spec shipped without an auth header, suggesting
// the template_uuid itself functions as the credential. We still attach
// `Authorization: Bearer <LOOPCHAT_API_KEY>` if the env var is set so the
// integration keeps working if LoopChat later enforces it.

const axios = require('axios');
const { logger } = require('./logger');

const LOOPCHAT_BASE     = process.env.LOOPCHAT_API_BASE_URL || 'https://api.loopchat.sa';
const LOOPCHAT_TIMEOUT  = 15_000;

async function sendTemplate({
  recipient,
  templateUuid,
  bodyVariables,
  headerVariables,
  uploadedImageUrl,
}) {
  if (!templateUuid) throw new Error('LOOPCHAT: templateUuid required');
  if (!recipient)    throw new Error('LOOPCHAT: recipient required');

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.LOOPCHAT_API_KEY) {
    headers.Authorization = `Bearer ${process.env.LOOPCHAT_API_KEY}`;
  }

  const body = { template_uuid: templateUuid, recipient };
  if (bodyVariables)    body.body_variables    = bodyVariables;
  if (headerVariables)  body.header_variables  = headerVariables;
  if (uploadedImageUrl) body.uploaded_image_url = uploadedImageUrl;

  const r = await axios.post(
    `${LOOPCHAT_BASE}/api/v1/whatsapp/templates/deliver`,
    body,
    { headers, timeout: LOOPCHAT_TIMEOUT },
  );
  return r.data;
}

// Fire-and-forget wrapper: logs success/failure but never throws, so it
// can't take down the caller (typically the Vapi webhook handler).
function sendTemplateBestEffort(args, context = {}) {
  sendTemplate(args).then(
    (r) => logger.info('loopchat: template sent', {
      ...context,
      recipient : args.recipient,
      messageId : r?.data?.message_id,
    }),
    (e) => logger.error('loopchat: send failed', {
      ...context,
      recipient: args.recipient,
      err      : e.response?.data || e.message,
      status   : e.response?.status,
    }),
  );
}

module.exports = { sendTemplate, sendTemplateBestEffort };
