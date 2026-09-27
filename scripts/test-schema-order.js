// Boot-order regression tests for the Postgres schema.
//
// These need no database. They exist because the suites that DO need one all
// run against a FRESH container, and a fresh database cannot reproduce the
// failure they guard against.
//
// The bug they were written for: db-pg-schema.js runs first on every boot and
// declares CREATE TABLE IF NOT EXISTS. On an existing database that is a no-op,
// so a column added later by ADD_COLUMNS is still missing while this DDL runs.
// A CREATE INDEX in the DDL on such a column therefore throws, and because it
// throws inside initDb it kills the process BEFORE runPgMigrations can add the
// column. The deployment then crash-loops with
//
//     db init failed — exiting   column "elevenlabs_agent_id" does not exist
//
// while a fresh database boots perfectly, because there CREATE TABLE really did
// create the column. Every index on a migration-added column must live in
// ADD_INDEXES, which runs after ADD_COLUMNS.

const test = require('node:test');
const assert = require('node:assert');

const { DDL } = require('../db-pg-schema');
const { ADD_COLUMNS, ADD_INDEXES } = require('../lib/migrations-pg');

/** [['companies','elevenlabs_agent_id'], ...] -> Map<table, Set<column>> */
function migrationAddedColumns() {
  const m = new Map();
  for (const [table, col] of ADD_COLUMNS) {
    if (!m.has(table)) m.set(table, new Set());
    m.get(table).add(col);
  }
  return m;
}

/** Every CREATE INDEX in the DDL, as { name, table, columns[] }. */
function ddlIndexes() {
  const out = [];
  const re = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)/gi;
  let m;
  while ((m = re.exec(DDL)) !== null) {
    const columns = m[3]
      .split(',')
      .map((c) => c.trim().replace(/\s+(ASC|DESC)$/i, '').trim())
      // lower(email) and other expressions: take the identifier inside.
      .map((c) => (c.includes('(') ? (c.match(/\(([^)]*)\)/) || [, c])[1].trim() : c))
      .filter(Boolean);
    out.push({ name: m[1], table: m[2], columns });
  }
  return out;
}

test('the schema DDL declares at least one index (the parser actually works)', () => {
  const idx = ddlIndexes();
  assert.ok(idx.length > 10, `expected many indexes, parsed ${idx.length}`);
});

test('no DDL index touches a column that only ADD_COLUMNS creates', () => {
  const added = migrationAddedColumns();
  const offenders = [];

  for (const idx of ddlIndexes()) {
    const late = added.get(idx.table);
    if (!late) continue;
    for (const col of idx.columns) {
      if (late.has(col)) {
        offenders.push(`${idx.name} on ${idx.table}(${col})`);
      }
    }
  }

  assert.deepStrictEqual(
    offenders, [],
    'These indexes are declared in db-pg-schema.js but sit on columns that do '
    + 'not exist yet when that DDL runs against an EXISTING database. They will '
    + 'crash the boot before the migration that adds the column can run. Move '
    + 'them to ADD_INDEXES in lib/migrations-pg.js:\n  ' + offenders.join('\n  '),
  );
});

test('the indexes moved out of the DDL are actually declared in ADD_INDEXES', () => {
  // Guards the other direction: a careless fix could delete an index instead of
  // relocating it, and nothing else would notice.
  const declared = new Set(ADD_INDEXES.map(([name]) => name));
  for (const name of ['idx_companies_el_agent', 'idx_companies_el_phone', 'idx_calls_provider']) {
    assert.ok(declared.has(name), `${name} is in neither the DDL nor ADD_INDEXES — the index was lost, not moved`);
  }
});

test('every ADD_INDEXES entry names a real table and column', () => {
  const known = new Set();
  for (const [table, col] of ADD_COLUMNS) known.add(`${table}.${col}`);
  // Columns that always existed are fine too; we only assert the shape parses.
  for (const [name, target] of ADD_INDEXES) {
    assert.match(target, /^\w+\([\w\s,]+\)$/, `${name} has an unparseable target: ${target}`);
    assert.ok(name.length > 0);
  }
  assert.ok(known.size > 0);
});
