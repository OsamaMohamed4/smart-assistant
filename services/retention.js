// Scheduled data-retention purge (audit F-04a).
//
// lib/retention.js has existed since the PDPL pass but nothing ever called it
// — the module's own header said "schedule it via the BullMQ queue" and that
// never happened, so no record has ever been purged and webhook_events (raw
// payloads containing phone numbers) grew without bound.
//
// This is the missing scheduler. Same durability pattern as the campaign
// worker: a BullMQ repeatable job when REDIS_URL is set, an in-process timer
// otherwise, so dev/CI keep working with no Redis.
//
// FAIL-SAFE BY DESIGN: with no RETENTION_DAYS_* variables set, config() is
// empty and this deletes nothing. Retention must be opted into deliberately —
// silently deleting a customer's call history would be far worse than keeping
// it too long.
const queue = require('../lib/queue');
const { purge, config } = require('../lib/retention');
const { logger } = require('../lib/logger');
const data = require('../db');

// Whitelist of purgeable tables. The table name is interpolated into SQL, so
// it must never come from anywhere but this list.
const PURGEABLE = new Set(['calls', 'chats', 'audit_events', 'webhook_events']);

// Driver-agnostic deleter. Both engines store timestamps as
// 'YYYY-MM-DD HH:MM:SS' text, so a lexicographic comparison is chronological.
async function deleteOlderThan(table, dateCol, cutoffIso) {
  if (!PURGEABLE.has(table)) throw new Error(`refusing to purge unknown table: ${table}`);
  if (!/^[a-z_]+$/.test(dateCol)) throw new Error(`invalid date column: ${dateCol}`);
  const cutoff = cutoffIso.replace('T', ' ').slice(0, 19);
  const r = await data.run(`DELETE FROM ${table} WHERE ${dateCol} < ?`, [cutoff]);
  return r.changes || 0;
}

async function runPurge() {
  const cfg = config();
  if (!cfg.length) return { skipped: 'no retention windows configured' };
  const results = await purge(deleteOlderThan);
  const total = results.reduce((n, r) => n + (r.deleted || 0), 0);
  if (total) logger.info('retention purge complete', { total, tables: results.length });
  return { results, total };
}

// Daily by default — retention windows are measured in days, so anything more
// frequent is wasted work.
function startRetentionWorker() {
  const intervalMs = Number(process.env.RETENTION_TICK_MS) || 24 * 3600 * 1000;
  const windows = config();

  if (!windows.length) {
    logger.info('retention purge idle — set RETENTION_DAYS_CALLS / _CHATS / _AUDIT / _WEBHOOKS to enable');
    return null;
  }
  logger.info('retention purge enabled', {
    windows: windows.map((w) => `${w.table}=${w.days}d`).join(' '),
  });

  if (queue.enabled) {
    const q = queue.makeQueue('retention');
    queue.makeWorker('retention', async () => { await runPurge(); }, { concurrency: 1 });
    queue.scheduleRepeatable(q, 'purge', intervalMs)
      .catch((e) => logger.error('retention schedule failed', { err: e.message }));
    logger.info('retention worker started (BullMQ durable queue)', { intervalMs });
    return null;
  }

  // First run 60s after boot so it never competes with startup work.
  const kick = setTimeout(() => {
    runPurge().catch((e) => logger.error('retention purge failed', { err: e.message }));
  }, 60_000);
  kick.unref();
  const t = setInterval(() => {
    runPurge().catch((e) => logger.error('retention purge failed', { err: e.message }));
  }, intervalMs);
  t.unref();
  logger.info('retention worker started (in-process timer — set REDIS_URL for durability)', { intervalMs });
  return t;
}

module.exports = { startRetentionWorker, runPurge, deleteOlderThan, PURGEABLE };
