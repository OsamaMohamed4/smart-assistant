// Audit log writer for security/compliance-relevant actions (company CRUD,
// key management, phone binding, backups...). Never throws — an audit
// failure must not break the action it documents.
const { sql } = require('../db');
const { logger } = require('./logger');

function audit(req, action, resource, metadata) {
  try {
    sql.logAuditEvent.run({
      actor_id    : req.user?.id || null,
      actor_email : req.user?.email || null,
      action,
      resource    : resource || null,
      metadata    : metadata ? JSON.stringify(metadata) : null,
      ip          : req.ip || req.socket?.remoteAddress || null,
      user_agent  : (req.get('user-agent') || '').slice(0, 255),
    });
  } catch (e) {
    logger.error('audit log error', { err: e.message });
  }
}

module.exports = { audit };
