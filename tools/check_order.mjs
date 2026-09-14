// The grader wraps every query in a projection:
//     SELECT CAST(col AS VARCHAR) ... FROM ( <your query> ) AS _practice_q
// so that DECIMAL / DATE / TIMESTAMP values arrive as plain strings.
//
// That is only safe if DuckDB preserves the inner ORDER BY through the wrap --
// otherwise every `ordered: true` exercise would grade against a scrambled
// reference. This asserts it, on the real data, for every ordered exercise.
//
// Comparison is done on the first column only, and exercises whose first column
// is floating-point are skipped, because raw-vs-VARCHAR rendering of decimals
// differs (25.5 vs 25.50) and that is a formatting difference, not an ordering
// one.
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'fs';
import { EXERCISES } from '../assets/js/curriculum.js';

const inst = await DuckDBInstance.create(':memory:');
const c = await inst.connect();
for (const f of ['schema', 'compat', 'seed']) {
  await c.run(fs.readFileSync(`assets/data/${f}.sql`, 'utf8'));
}

const strip = (s) => s.trim().replace(/;\s*$/, '');
const FLOATY = /^(DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL)/i;

let checked = 0, skipped = 0, failed = 0;
for (const ex of EXERCISES.filter(e => e.ordered)) {
  const sql = strip(ex.solution);
  const raw = await c.runAndReadAll(sql);
  const firstType = String(raw.columnTypes()[0]);
  const firstName = raw.columnNames()[0];

  if (FLOATY.test(firstType)) { skipped++; continue; }

  const wrapped = await c.runAndReadAll(
    `SELECT CAST("${firstName}" AS VARCHAR) AS k FROM (${sql}) AS _practice_q`);

  const a = raw.getRows().map(r => r[0] === null ? '' : String(r[0]));
  const b = wrapped.getRows().map(r => r[0] === null ? '' : String(r[0]));

  const same = a.length === b.length && a.every((v, i) => v === b[i]);
  checked++;
  if (!same) {
    failed++;
    const at = a.findIndex((v, i) => v !== b[i]);
    console.log(`FAIL ${ex.id}: order changed at row ${at + 1} (${a[at]} -> ${b[at]})`);
  }
}

console.log(`order preserved through the grading wrapper: ${checked - failed}/${checked} ordered exercises`
  + ` (${skipped} skipped: floating-point first column)`);
process.exit(failed ? 1 : 0);
