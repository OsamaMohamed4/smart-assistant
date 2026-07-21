// Durable background-job queue (Task #3 — BullMQ + Redis).
//
// Enabled when REDIS_URL is set. Without it, callers fall back to the legacy
// in-process timer so local dev / CI / the smoke suite keep working with no
// Redis. BullMQ buys: durability (jobs survive a crash/restart), retries with
// exponential backoff, a dead-letter queue for permanently-failed jobs,
// multi-worker distribution, and graceful shutdown that drains the active job.
const { logger } = require('./logger');
let metrics = null;
try { metrics = require('./metrics'); } catch { /* metrics optional */ }

const REDIS_URL = process.env.REDIS_URL || '';
const enabled = !!REDIS_URL;

let _conn = null;
const _queues = [];
const _workers = [];

function getConnection() {
  if (_conn) return _conn;
  const IORedis = require('ioredis');
  _conn = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  _conn.on('error', (e) => logger.error('redis error', { err: e.message }));
  return _conn;
}

// Prove Redis is actually reachable, with a hard timeout. The pooled
// connection uses maxRetriesPerRequest:null, so a broken Redis makes every
// command HANG rather than fail — which is how a "durable" worker can silently
// never run. A dedicated short-lived client with a bounded retry lets callers
// detect that and fall back. Returns true/false, never throws.
async function ping(timeoutMs = 3000) {
  if (!enabled) return false;
  const IORedis = require('ioredis');
  const probe = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: timeoutMs,
    retryStrategy: () => null,           // do not retry — fail fast
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  probe.on('error', () => {});           // swallow — we only care about the race result
  try {
    const pong = await Promise.race([
      probe.connect().then(() => probe.ping()),
      new Promise((_, rej) => setTimeout(() => rej(new Error('redis ping timeout')), timeoutMs)),
    ]);
    return pong === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

function makeQueue(name, jobOptions = {}) {
  const { Queue } = require('bullmq');
  const q = new Queue(name, {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: jobOptions.attempts ?? 3,
      backoff: { type: 'exponential', delay: jobOptions.backoffMs ?? 1000 },
      removeOnComplete: jobOptions.removeOnComplete ?? 1000,
      removeOnFail: false, // keep failed jobs for inspection
    },
  });
  _queues.push(q);
  return q;
}

// Worker with dead-letter handling: when a job exhausts its retries a copy is
// pushed to `<name>-dlq` instead of being silently dropped.
function makeWorker(name, processor, opts = {}) {
  const { Worker, Queue } = require('bullmq');
  const conn = getConnection();
  const dlq = new Queue(`${name}-dlq`, { connection: conn });
  _queues.push(dlq);
  const workerOpts = { connection: conn, concurrency: opts.concurrency ?? 5 };
  if (opts.lockDuration) workerOpts.lockDuration = opts.lockDuration;
  if (opts.stalledInterval) workerOpts.stalledInterval = opts.stalledInterval;
  if (opts.maxStalledCount != null) workerOpts.maxStalledCount = opts.maxStalledCount;

  const worker = new Worker(name, processor, workerOpts);
  worker.on('completed', () => metrics?.recordJob?.(name, 'completed'));
  worker.on('failed', async (job, err) => {
    metrics?.recordJob?.(name, 'failed');
    const attempts = job?.opts?.attempts ?? 1;
    if (job && job.attemptsMade >= attempts) {
      try {
        await dlq.add('dead', { originalId: job.id, name: job.name, data: job.data, reason: err?.message });
        metrics?.recordJob?.(name, 'dead');
        logger.warn('job dead-lettered', { queue: name, jobId: job.id, reason: err?.message });
      } catch (e) { logger.error('dlq add failed', { queue: name, err: e.message }); }
    }
  });
  worker.on('error', (e) => logger.error('worker error', { queue: name, err: e.message }));
  _workers.push(worker);
  return worker;
}

// Repeatable scheduler — the durable replacement for setInterval.
async function scheduleRepeatable(queue, jobName, everyMs, data = {}) {
  await queue.add(jobName, data, { repeat: { every: everyMs }, removeOnComplete: true, removeOnFail: true });
}

// Graceful shutdown: workers first (finishes the active job), then queues + conn.
async function shutdown() {
  await Promise.allSettled(_workers.map((w) => w.close()));
  await Promise.allSettled(_queues.map((q) => q.close()));
  if (_conn) { try { await _conn.quit(); } catch { /* ignore */ } _conn = null; }
}

module.exports = { enabled, REDIS_URL, getConnection, ping, makeQueue, makeWorker, scheduleRepeatable, shutdown };
