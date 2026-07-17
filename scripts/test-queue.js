// Proof suite for the durable job queue (Task #3 — BullMQ).
// Requires a Redis at REDIS_URL (default redis://localhost:6380).
// Run: REDIS_URL=redis://localhost:6380 node --test scripts/test-queue.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';
process.env.REDIS_URL = REDIS_URL;
const queue = require('../lib/queue');
const IORedis = require('ioredis');

let raw;
before(() => { raw = new IORedis(REDIS_URL, { maxRetriesPerRequest: null }); });
after(async () => { await queue.shutdown(); await raw.quit(); });

const uid = () => Math.random().toString(36).slice(2, 8);
async function waitFor(fn, timeoutMs = 10000, stepMs = 100) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

test('durability: jobs persist in Redis until a worker runs (survive a crash with no worker)', { timeout: 15000 }, async () => {
  const name = `dur-${uid()}`;
  const q = queue.makeQueue(name, { attempts: 1 });
  for (let i = 0; i < 5; i++) await q.add('t', { i });
  assert.equal(await q.getWaitingCount(), 5, '5 jobs waiting in Redis before any worker exists');
  let done = 0;
  queue.makeWorker(name, async () => { done += 1; }, { concurrency: 2 });
  assert.ok(await waitFor(() => done === 5, 10000), 'all 5 processed once a worker starts');
});

test('retry: a job that fails twice then succeeds completes on attempt 3', { timeout: 15000 }, async () => {
  const name = `retry-${uid()}`;
  const q = queue.makeQueue(name, { attempts: 3, backoffMs: 200 });
  let calls = 0; let completed = false;
  const w = queue.makeWorker(name, async () => { calls += 1; if (calls < 3) throw new Error(`boom ${calls}`); }, { concurrency: 1 });
  w.on('completed', () => { completed = true; });
  await q.add('t', {});
  assert.ok(await waitFor(() => completed, 12000), 'job eventually completed');
  assert.equal(calls, 3, 'handler ran 3 times (2 failures + 1 success)');
});

test('dead-letter: a job that always fails lands in <queue>-dlq after retries', { timeout: 15000 }, async () => {
  const name = `dlq-${uid()}`;
  const q = queue.makeQueue(name, { attempts: 2, backoffMs: 150 });
  const dlq = queue.makeQueue(`${name}-dlq`, { attempts: 1 });
  queue.makeWorker(name, async () => { throw new Error('always fails'); }, { concurrency: 1 });
  await q.add('t', { x: 1 });
  assert.ok(await waitFor(async () => (await dlq.getWaitingCount()) >= 1, 12000), 'exhausted job moved to DLQ');
});

test('multiple workers share the load', { timeout: 15000 }, async () => {
  const name = `multi-${uid()}`;
  const q = queue.makeQueue(name, { attempts: 1 });
  const byWorker = { A: 0, B: 0 };
  queue.makeWorker(name, async () => { byWorker.A += 1; await new Promise((r) => setTimeout(r, 20)); }, { concurrency: 3 });
  queue.makeWorker(name, async () => { byWorker.B += 1; await new Promise((r) => setTimeout(r, 20)); }, { concurrency: 3 });
  for (let i = 0; i < 12; i++) await q.add('t', { i });
  assert.ok(await waitFor(() => byWorker.A + byWorker.B === 12, 12000), 'all 12 processed');
  assert.ok(byWorker.A >= 1 && byWorker.B >= 1, `both workers did work (A=${byWorker.A}, B=${byWorker.B})`);
});

test('throughput: drains 200 jobs and reports jobs/sec', { timeout: 20000 }, async () => {
  const name = `thru-${uid()}`;
  const q = queue.makeQueue(name, { attempts: 1 });
  const N = 200; let done = 0;
  for (let i = 0; i < N; i++) await q.add('t', { i });
  const t0 = Date.now();
  queue.makeWorker(name, async () => { done += 1; }, { concurrency: 20 });
  assert.ok(await waitFor(() => done === N, 18000), 'all drained');
  const secs = (Date.now() - t0) / 1000;
  console.log(`    → ${N} jobs in ${secs.toFixed(2)}s = ${Math.round(N / secs)} jobs/sec (concurrency 20)`);
});

test('crash recovery: kill a worker mid-job → another worker resumes it', { timeout: 30000 }, async () => {
  const name = `crash-${uid()}`;
  const startsKey = `starts:${name}`;
  const doneKey = `done:${name}`;
  await raw.del(startsKey, doneKey);
  const q = queue.makeQueue(name, { attempts: 3 });
  await q.add('t', {});

  // Worker A (child process): takes the job, marks its start, then hangs so we
  // can SIGKILL it mid-job — simulating an API server crash while a job runs.
  const childCode = `
    const IORedis=require('ioredis');const {Worker}=require('bullmq');
    const url=${JSON.stringify(REDIS_URL)};
    const conn=new IORedis(url,{maxRetriesPerRequest:null});
    const r=new IORedis(url,{maxRetriesPerRequest:null});
    new Worker(${JSON.stringify(name)}, async()=>{ const n=await r.incr(${JSON.stringify(startsKey)}); if(n===1){ await new Promise(()=>{}); } },
      {connection:conn, lockDuration:3000, stalledInterval:1000, maxStalledCount:5, concurrency:1});
  `;
  const child = spawn(process.execPath, ['-e', childCode], { stdio: 'ignore' });
  assert.ok(await waitFor(async () => Number(await raw.get(startsKey)) >= 1, 12000), 'worker A picked up the job');
  child.kill('SIGKILL'); // crash mid-job

  // Worker B (this process): detects the stalled job (A's lock expires) and re-runs it.
  queue.makeWorker(name, async () => {
    const n = await raw.incr(startsKey);
    if (n === 1) { await new Promise(() => {}); } // guard: only if B somehow ran first
    await raw.set(doneKey, '1');
  }, { concurrency: 1, lockDuration: 3000, stalledInterval: 1000, maxStalledCount: 5 });

  assert.ok(await waitFor(async () => (await raw.get(doneKey)) === '1', 25000), 'job resumed and completed after the crash');
  try { child.kill('SIGKILL'); } catch { /* already dead */ }
});
