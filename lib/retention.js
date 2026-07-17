// Data retention (Task #5, PDPL): purge records older than a configured window,
// per record kind. PDPL expects personal data not be kept longer than needed.
//
// Config via env (days); a kind with no window (0/unset) is skipped, so nothing
// is ever deleted unless the operator opts in. Deletion is driver-agnostic: the
// caller supplies a deleteOlderThan(table, dateCol, cutoffIso) callback (so this
// works on sqlite or postgres, and stays testable). Schedule it via the BullMQ
// queue (Task #3) as a daily repeatable job.
const { logger } = require('./logger');

const KINDS = [
  { kind: 'calls', table: 'calls', dateCol: 'created_at', env: 'RETENTION_DAYS_CALLS' },
  { kind: 'chats', table: 'chats', dateCol: 'created_at', env: 'RETENTION_DAYS_CHATS' },
  { kind: 'audit', table: 'audit_events', dateCol: 'created_at', env: 'RETENTION_DAYS_AUDIT' },
  { kind: 'webhooks', table: 'webhook_events', dateCol: 'created_at', env: 'RETENTION_DAYS_WEBHOOKS' },
];

function config(env = process.env) {
  return KINDS.map((k) => ({ ...k, days: Number(env[k.env]) || 0 })).filter((k) => k.days > 0);
}

async function purge(deleteOlderThan, env = process.env) {
  const results = [];
  for (const k of config(env)) {
    const cutoff = new Date(Date.now() - k.days * 86_400_000).toISOString();
    const deleted = await deleteOlderThan(k.table, k.dateCol, cutoff);
    results.push({ kind: k.kind, table: k.table, days: k.days, cutoff, deleted });
    logger.info('retention purge', { table: k.table, days: k.days, deleted });
  }
  return results;
}

module.exports = { KINDS, config, purge };
