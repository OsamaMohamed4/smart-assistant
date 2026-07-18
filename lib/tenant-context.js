// Request-scoped tenant context for Postgres Row-Level Security (Task #2).
//
// Deliberately driver-agnostic and connection-free: we do NOT pin a pooled
// connection (or an open transaction) to the request, because routes call
// OpenAI/Vapi/ElevenLabs mid-request and would exhaust PG_POOL_MAX while
// waiting on those. Instead the pg layer reads this context and applies
// `SET LOCAL` inside each query's own short transaction.
//
// Shape: { bypass: boolean, companyId: string|null }
//   bypass=true  → system/superadmin: sees every tenant (RLS bypass clause)
//   companyId    → pinned tenant: Postgres filters every row to this company
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

function runWithContext(ctx, fn) { return als.run(ctx, fn); }
function currentContext() { return als.getStore() || null; }

module.exports = { runWithContext, currentContext };
