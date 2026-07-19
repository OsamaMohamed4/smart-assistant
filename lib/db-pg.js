// PostgreSQL connection layer — the target of the SQLite cutover (Phase 2.1
// stage B). Not wired into the app yet: scripts/migrate-to-pg.js copies the
// data, this module provides the pool + helpers the statement layer will use,
// and retrieveVec() replaces the in-memory JS cosine scan with pgvector.
//
// SSL: Railway's internal DATABASE_URL needs no TLS; the public proxy URL
// does but with a self-signed chain → rejectUnauthorized:false when sslmode
// is present or PGSSL=1.
const { Pool, types } = require('pg');
const { logger } = require('./logger');
const { currentContext } = require('./tenant-context');

// node-postgres returns BIGINT (int8) and NUMERIC as strings by default to
// avoid precision loss. Our ids/counters never approach 2^53, and the whole
// codebase compares them as numbers (`row.n === 0`, `duration_sec >= 30`),
// so parse them — this keeps behavior identical to better-sqlite3.
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));    // int8
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));    // numeric

let pool = null;

function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const needsSsl = /sslmode=require/.test(url) || process.env.PGSSL === '1';
  pool = new Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  pool.on('error', (e) => logger.error('pg pool error', { err: e.message }));
  return pool;
}

// Staged-rollout gate. The tenant-context path (and its per-query transaction)
// only engages when RLS_ENABLED=1, so deploying this code is a behavioural AND
// performance no-op until you enable the policies. Flip it in the same window
// you run scripts/rls-migrate.js; see scripts/rls-rollback.js to undo.
const rlsEnabled = () => process.env.RLS_ENABLED === '1';

// Applies the RLS settings on an OPEN transaction. set_config(..., true) is
// SET LOCAL semantics: discarded at COMMIT/ROLLBACK, so a tenant context can
// never leak to the next borrower of the pooled connection.
async function applyRlsContext(client, ctx) {
  if (!ctx) return;
  if (ctx.bypass) { await client.query("SELECT set_config('app.bypass_rls','on',true)"); return; }
  if (ctx.companyId) await client.query("SELECT set_config('app.current_company',$1,true)", [String(ctx.companyId)]);
}

// With a tenant context in scope each query runs inside its own short
// transaction carrying the RLS settings. The connection is held only for that
// query — never across an external API call — so the pool can't be starved.
async function q(text, params) {
  const ctx = rlsEnabled() ? currentContext() : null;
  if (!ctx || (!ctx.bypass && !ctx.companyId)) return getPool().query(text, params);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await applyRlsContext(client, ctx);
    const r = await client.query(text, params);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}
async function one(text, params) { return (await q(text, params)).rows[0] || null; }
async function many(text, params) { return (await q(text, params)).rows; }

// Async transaction helper (replaces better-sqlite3's sync db.transaction).
async function withTransaction(fn) {
  const ctx = rlsEnabled() ? currentContext() : null;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await applyRlsContext(client, ctx);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// Run fn inside a transaction with the RLS tenant context set (Task #2). All
// queries on the passed client are then filtered by Row-Level Security to
// companyId — even a query with no `WHERE company_id`. set_config(..., true)
// is transaction-scoped (SET LOCAL), so the context can't leak to the next
// borrower of the pooled connection.
async function withTenant(companyId, fn) {
  if (!companyId) throw new Error('withTenant requires a companyId');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_company', $1, true)", [String(companyId)]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// Vector search via pgvector (cosine). Drop-in result shape for
// lib/rag.js retrieve(): [{ id, documentId, text, score }].
// `<=>` is cosine DISTANCE; score = 1 - distance matches the JS cosine.
async function retrieveVec(companyId, queryVec, { topK = 4, minScore = 0.2 } = {}) {
  // Round to 6 decimals when building the literal. Default float32→string
  // printing emits full float64 expansions and scientific notation
  // ("4.1425228e-05"), producing a ~28.8KB literal that Postgres spends ~50ms
  // PARSING — measured as the dominant cost of this query, dwarfing the
  // search itself. 6 decimals is inside float32 representational error:
  // verified identical top-24 ranking across 15 query×corpus combinations,
  // max score delta 7.8e-7 (the score threshold works at 0.01 granularity).
  const literal = '[' + Array.from(queryVec, (x) => x.toFixed(6)).join(',') + ']';
  const rows = await many(
    `SELECT id, document_id, text, 1 - (embedding <=> $2::vector) AS score
       FROM kb_chunks
      WHERE company_id = $1
      ORDER BY embedding <=> $2::vector, id
      LIMIT $3`,
    [companyId, literal, topK],
  );
  return rows
    .map((r) => ({ id: Number(r.id), documentId: Number(r.document_id), text: r.text, score: Number(r.score) }))
    .filter((r) => r.score >= minScore);
}

async function healthCheck() {
  await q('SELECT 1');
  return true;
}

async function close() { if (pool) { await pool.end(); pool = null; } }

module.exports = { getPool, q, one, many, withTransaction, withTenant, applyRlsContext, retrieveVec, healthCheck, close };
