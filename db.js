// Database driver selector. Every module keeps requiring './db' — this file
// decides which engine backs it:
//   DB_DRIVER=sqlite    (default) → db-sqlite.js  (better-sqlite3, sync)
//   DB_DRIVER=postgres            → db-postgres.js (pg + pgvector, async)
//
// Both drivers expose the identical surface:
//   sql.*            — the named statement catalog (86+ statements)
//   get/all/run      — dynamic SQL with '?' placeholders
//   withTransaction  — async transaction wrapper
//   initDb/healthCheck/close, isPg, db (raw sqlite handle or null)
//
// CALL CONVENTION: always `await` statement results. Under sqlite the values
// are plain (await is a no-op); under postgres they are Promises. Code that
// forgets an await works on sqlite and breaks on postgres — the CI smoke
// suite runs on BOTH drivers to catch exactly that.
const DRIVER = (process.env.DB_DRIVER || 'sqlite').toLowerCase();

if (DRIVER !== 'sqlite' && DRIVER !== 'postgres') {
  throw new Error(`Unknown DB_DRIVER "${DRIVER}" — use sqlite or postgres`);
}
if (DRIVER === 'postgres' && !process.env.DATABASE_URL) {
  throw new Error('DB_DRIVER=postgres requires DATABASE_URL');
}

module.exports = DRIVER === 'postgres'
  ? require('./db-postgres')
  : require('./db-sqlite');
module.exports.DRIVER = DRIVER;
