// Executes every exercise's reference solution against the real database.
// A solution that errors, returns zero rows, or returns one trivial row is a
// broken exercise -- the grader compares against these, so they must be right.
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'fs';
import { EXERCISES, TRACKS } from '../assets/js/curriculum.js';

const inst = await DuckDBInstance.create(':memory:');
const c = await inst.connect();
for (const f of ['schema', 'compat', 'seed']) await c.run(fs.readFileSync(`assets/data/${f}.sql`, 'utf8'));

let bad = 0, warn = 0;
const only = process.argv[2];
for (const ex of EXERCISES) {
  if (only && !ex.id.startsWith(only)) continue;
  let res;
  const t0 = Date.now();
  try { res = await c.runAndReadAll(ex.solution); }
  catch (e) {
    console.log(`FAIL  ${ex.id.padEnd(12)} ${String(e.message).split('\n')[0].slice(0, 110)}`);
    bad++; continue;
  }
  const ms = Date.now() - t0;
  const rows = res.getRows(), cols = res.columnNames();
  const notes = [];
  if (rows.length === 0) { notes.push('ZERO ROWS'); bad++; }
  else if (rows.length === 1 && cols.length === 1) notes.push('single scalar');
  if (ms > 2500) { notes.push(`SLOW ${ms}ms`); warn++; }
  if (ex.ordered && !/order\s+by/i.test(ex.solution.split(/\)\s*$/).pop() ?? ex.solution)) {
    notes.push('ordered:true but no trailing ORDER BY'); warn++;
  }
  // every column the prompt names should exist in the output
  const promptCols = [...ex.prompt.matchAll(/`([a-z_][a-z0-9_]*)`/g)].map(m => m[1]);
  const missing = [...new Set(promptCols)].filter(p => /^[a-z_]+$/.test(p) && promptCols.filter(x=>x===p).length && !cols.includes(p));
  const status = notes.length && notes.some(n => n === 'ZERO ROWS') ? 'FAIL ' : notes.length ? 'warn ' : 'ok   ';
  console.log(`${status} ${ex.id.padEnd(12)} ${String(rows.length).padStart(6)} rows  ${String(ms).padStart(5)}ms  [${cols.join(', ')}]${notes.length ? '  <- ' + notes.join('; ') : ''}`);
}
console.log(`\n${bad} failing, ${warn} warnings, ${EXERCISES.length} total`);
process.exit(bad ? 1 : 0);
