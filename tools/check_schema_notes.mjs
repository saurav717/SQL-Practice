// The hover cards in the exercise prompts are assembled from three sources:
// the live database, the comments in schema.sql, and the prose in
// schema-doc.js. This checks that the three still agree -- a card that names a
// column the warehouse does not have is worse than no card at all.
//
//   * every table in the database has a one-line purpose
//   * every column parsed out of schema.sql exists in the database, with the
//     same spelling, and every database column was parsed
//   * both ends of every documented join key exist
//   * every exercise resolves to at least one table
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'fs';
import { PURPOSE, LINKS, parseSchemaSql, tablesFor } from '../assets/js/schema-doc.js';
import { EXERCISES } from '../assets/js/curriculum.js';

const inst = await DuckDBInstance.create(':memory:');
const c = await inst.connect();
const ddl = fs.readFileSync('assets/data/schema.sql', 'utf8');
await c.run(ddl);

// what the database actually has
const live = new Map();
for (const [table, column] of (await c.runAndReadAll(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'main' ORDER BY table_name, ordinal_position`)).getRows()) {
  if (!live.has(String(table))) live.set(String(table), []);
  live.get(String(table)).push(String(column));
}

const parsed = parseSchemaSql(ddl);
const bad = [];
const fail = (msg) => { bad.push(msg); console.log('BAD  ' + msg); };

// --- tables --------------------------------------------------------------
for (const table of live.keys()) {
  if (!PURPOSE[table]) fail(`${table}: no one-line purpose in schema-doc.js PURPOSE`);
  if (!parsed[table]) fail(`${table}: schema.sql parser found no columns for it`);
}
for (const table of Object.keys(PURPOSE)) {
  if (!live.has(table)) fail(`PURPOSE documents ${table}, which the database does not have`);
}

// --- columns -------------------------------------------------------------
let noted = 0, total = 0;
for (const [table, columns] of live) {
  const got = parsed[table] ?? {};
  for (const col of columns) {
    total++;
    if (!(col in got)) { fail(`${table}.${col}: in the database, missed by the schema.sql parser`); continue; }
    if (got[col].note) noted++;
  }
  for (const col of Object.keys(got)) {
    if (!columns.includes(col)) fail(`${table}.${col}: parsed out of schema.sql, not in the database`);
  }
}

// --- join keys -----------------------------------------------------------
let links = 0;
for (const [table, cols] of Object.entries(LINKS)) {
  if (!live.has(table)) { fail(`LINKS documents ${table}, which the database does not have`); continue; }
  for (const [col, targetRef] of Object.entries(cols)) {
    links++;
    const [target, targetCol] = targetRef.split('.');
    if (!live.get(table).includes(col)) fail(`LINKS ${table}.${col}: no such column`);
    if (!live.get(target)?.includes(targetCol)) fail(`LINKS ${table}.${col} -> ${targetRef}: no such target column`);
  }
}

// --- exercises -----------------------------------------------------------
const known = new Set(live.keys());
let chips = 0;
for (const ex of EXERCISES) {
  const names = tablesFor(ex, known);
  if (!names.length) fail(`${ex.id}: no tables could be derived from its prompt or solution`);
  chips += names.length;
}

console.log(`\ntables      ${live.size} documented`);
console.log(`columns     ${total} live, ${noted} carrying a note from schema.sql`);
console.log(`join keys   ${links} documented, both ends verified`);
console.log(`exercises   ${EXERCISES.length}, ${(chips / EXERCISES.length).toFixed(1)} tables each on average`);
console.log(bad.length ? `\n${bad.length} problems` : '\nSchema notes agree with the database.');
process.exit(bad.length ? 1 : 0);
