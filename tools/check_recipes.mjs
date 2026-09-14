// Executes every Explore-mode recipe against the real database.
//
// A recipe is a promise that you can click it and see something. So each one
// must parse, run, and -- unless it is a DDL/DML script -- come back with rows.
// A recipe returning zero rows is a broken promise, not a minor blemish, so it
// fails the build.
//
// Multi-statement recipes are split the same way the browser splits them, so
// this also exercises the splitter itself.
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'fs';
import { RECIPES, RECIPE_CATEGORIES } from '../assets/js/recipes.js';
import { splitStatements, isReadOnlyQuery } from '../assets/js/sqltext.js';

const inst = await DuckDBInstance.create(':memory:');
const c = await inst.connect();
for (const f of ['schema', 'compat', 'seed']) {
  await c.run(fs.readFileSync(`assets/data/${f}.sql`, 'utf8'));
}

// Every recipe must belong to a declared category, or it is unreachable in the UI.
const catIds = new Set(RECIPE_CATEGORIES.map(k => k.id));
const ids = new Set();
let bad = 0, warn = 0;

for (const r of RECIPES) {
  if (!catIds.has(r.cat)) { console.log(`FAIL  ${r.id.padEnd(16)} unknown category '${r.cat}'`); bad++; continue; }
  if (ids.has(r.id))      { console.log(`FAIL  ${r.id.padEnd(16)} duplicate recipe id`); bad++; continue; }
  ids.add(r.id);
  if (!r.title || !r.note) { console.log(`FAIL  ${r.id.padEnd(16)} missing title or note`); bad++; continue; }

  const stmts = splitStatements(r.sql);
  if (!stmts.length) { console.log(`FAIL  ${r.id.padEnd(16)} no statements`); bad++; continue; }

  const t0 = Date.now();
  let last = null, failed = false;
  for (const s of stmts) {
    try { last = await c.runAndReadAll(s); }
    catch (e) {
      console.log(`FAIL  ${r.id.padEnd(16)} ${String(e.message).split('\n')[0].slice(0, 110)}`);
      bad++; failed = true; break;
    }
  }
  if (failed) continue;
  const ms = Date.now() - t0;

  const rows = last.getRows();
  const tail = stmts[stmts.length - 1];
  const notes = [];
  // A recipe whose final statement reads data has to return some.
  if (isReadOnlyQuery(tail) && rows.length === 0) { notes.push('ZERO ROWS'); bad++; }
  if (ms > 4000) { notes.push(`SLOW ${ms}ms`); warn++; }

  const status = notes.includes('ZERO ROWS') ? 'FAIL ' : notes.length ? 'warn ' : 'ok   ';
  console.log(`${status} ${r.id.padEnd(16)} ${r.cat.padEnd(9)} ${String(rows.length).padStart(6)} rows ${String(ms).padStart(5)}ms` +
              (notes.length ? `  <- ${notes.join('; ')}` : ''));
}

// Every category must have at least one recipe, or the UI renders an empty section.
for (const k of RECIPE_CATEGORIES) {
  const n = RECIPES.filter(r => r.cat === k.id).length;
  if (n === 0) { console.log(`FAIL  category '${k.id}' has no recipes`); bad++; }
}

console.log(`\n${bad} failing, ${warn} warnings, ${RECIPES.length} recipes across ${RECIPE_CATEGORIES.length} categories`);
process.exit(bad ? 1 : 0);
