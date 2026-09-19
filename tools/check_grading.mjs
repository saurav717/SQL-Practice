// Grading, at the two places it used to lie to you.
//
// 1. COLUMN ORDER. Rows are compared position by position, so an answer that
//    returns the right data with its SELECT list in a different order graded as
//    "Wrong values" -- which is technically true and useless to read. It now
//    passes with a note. This runs the real grader, against the real dataset,
//    with every exercise's own reference solution wrapped so its columns come
//    back reversed, and asserts that each one comes back `column-order`.
//
// 2. THE SANDBOX BUTTON. Sandbox is a mode, and the button was lit from the
//    click handler alone -- so picking an exercise dropped you out of the mode
//    but left the button looking on, and .btn-ghost (declared after
//    .btn-primary) flattened the accent fill anyway. This asserts the button
//    actually changes when the mode does, in both directions.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 8095;
const ORIGIN = `http://localhost:${PORT}`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.sql': 'text/plain', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  const file = p.endsWith('/') ? path.join(p, 'index.html') : p;
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(PORT, r));

let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};

const VENDORED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = process.env.CHROME_PATH
  || (fs.existsSync(VENDORED) ? VENDORED : undefined);

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#topbar:not([hidden])', { timeout: 120000 });
await page.waitForTimeout(300);

// ---------------------------------------------------------------------------
// 1. Every reference solution, with its columns reversed, grades as a pass
//    carrying the column-order note -- and the unreversed one still just passes.
// ---------------------------------------------------------------------------
// The page's own module instance, already booted: same URL, same registry
// entry, so this is the connection the app is using, not a second one.
const results = await page.evaluate(async () => {
  const engine = await import('/assets/js/engine.js');
  const { EXERCISES } = await import('/assets/js/curriculum.js');
  const strip = (s) => s.trim().replace(/;+\s*$/, '');
  const out = [];
  for (const ex of EXERCISES) {
    let cols;
    try {
      cols = (await engine.run(strip(ex.solution), { limit: 1 })).columns;
    } catch (e) {
      out.push({ id: ex.id, skip: 'solution failed: ' + (e.message ?? e) });
      continue;
    }
    if (cols.length < 2) { out.push({ id: ex.id, skip: 'single column' }); continue; }

    // Reverse the SELECT list without touching the query: the wrap preserves
    // the inner ORDER BY (tools/check_order.mjs is what asserts that).
    const reversed = [...cols].reverse().map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
    const swapped = `SELECT ${reversed} FROM (${strip(ex.solution)}) AS _swapped`;

    const v = await engine.grade(swapped, ex);
    const clean = await engine.grade(ex.solution, ex);
    out.push({
      id: ex.id,
      pass: v.pass, reason: v.reason ?? null, detail: v.detail,
      cleanPass: clean.pass, cleanReason: clean.reason ?? null,
    });
  }
  return out;
});

const graded = results.filter((r) => !r.skip);
const skipped = results.filter((r) => r.skip);
const broken = skipped.filter((r) => r.skip.startsWith('solution failed'));

ok('every multi-column exercise was gradable', broken.length === 0,
   broken.map((r) => r.id).join(', '));
ok('there are multi-column exercises to test', graded.length > 10,
   `${graded.length} graded, ${skipped.length} single-column`);

const notNoted = graded.filter((r) => !(r.pass && r.reason === 'column-order'));
ok('reversed columns pass with the column-order note', notNoted.length === 0,
   notNoted.slice(0, 5).map((r) => `${r.id}: pass=${r.pass} reason=${r.reason}`).join(' | '));

const regressed = graded.filter((r) => !r.cleanPass || r.cleanReason);
ok('the reference solution itself still passes clean', regressed.length === 0,
   regressed.slice(0, 5).map((r) => `${r.id}: pass=${r.cleanPass} reason=${r.cleanReason}`).join(' | '));

const sample = graded[0];
ok('the note names both column orders',
   /brief asks for/.test(sample.detail) && /your query returns/.test(sample.detail),
   JSON.stringify(sample.detail.slice(0, 90)));

// A genuinely wrong answer must still be wrong -- the permutation search is
// not allowed to launder one.
const wrong = await page.evaluate(async () => {
  const engine = await import('/assets/js/engine.js');
  const { EXERCISES } = await import('/assets/js/curriculum.js');
  const ex = EXERCISES.find((e) => e.id === EXERCISES[0].id);
  const strip = (s) => s.trim().replace(/;+\s*$/, '');
  const cols = (await engine.run(strip(ex.solution), { limit: 1 })).columns;
  const q = (c) => `"${c.replace(/"/g, '""')}"`;
  // Right shape, right column names, one column replaced by a constant.
  const sql = `SELECT ${cols.map((c, i) => i === cols.length - 1 ? `NULL AS ${q(c)}` : q(c)).join(', ')}`
            + ` FROM (${strip(ex.solution)}) AS _mangled`;
  const v = await engine.grade(sql, ex);
  return { pass: v.pass, reason: v.reason };
});
ok('a wrong answer is still wrong', wrong.pass === false, JSON.stringify(wrong));

// ---------------------------------------------------------------------------
// 1b. Checking by column NAME.
//
// When your column names are the brief's names, the pairing between your
// columns and the expected ones is unambiguous, so values are checked under
// each name and position becomes a remark. These are the cases that pairing
// gets right and a positional comparison does not -- most importantly the
// third one, which a positional grader PASSES.
// ---------------------------------------------------------------------------
const named = await page.evaluate(async () => {
  const engine = await import('/assets/js/engine.js');
  const { EXERCISES } = await import('/assets/js/curriculum.js');
  const strip = (s) => s.trim().replace(/;+\s*$/, '');
  const q = (c) => `"${c.replace(/"/g, '""')}"`;

  // A multi-column exercise with a fixed row order, which is nearly all of them.
  const ex = EXERCISES.find((e) => e.ordered);
  const sol = strip(ex.solution);
  const cols = (await engine.run(sol, { limit: 1 })).columns;
  const [c1, c2] = cols;
  const rest = cols.slice(2).map(q);
  const all = cols.map(q).join(', ');

  const cases = {
    // Right data, labels on the wrong columns. Position-only grading passed
    // this: the values line up once you ignore what they are called.
    labels: [ex, `SELECT ${q(c2)} AS ${q(c1)}, ${q(c1)} AS ${q(c2)}`
                 + `${rest.length ? ', ' + rest.join(', ') : ''} FROM (${sol}) t`],
    // Right names, right order, one column's values wrong.
    values: [ex, `SELECT ${q(c1)}, CAST(NULL AS VARCHAR) AS ${q(c2)}`
                 + `${rest.length ? ', ' + rest.join(', ') : ''} FROM (${sol}) t`],
    // Names are advisory: rename everything and a correct answer still passes.
    renamed: [ex, `SELECT ${cols.map((c, i) => `${q(c)} AS c${i}`).join(', ')} FROM (${sol}) t`],
    // Reordered AND renamed -- two remarks about one answer.
    both: [ex, `SELECT ${[...cols].reverse().map((c, i) => `${q(c)} AS c${i}`).join(', ')} FROM (${sol}) t`],
    // Shape problems name the column rather than only counting.
    missing: [ex, `SELECT ${cols.slice(0, -1).map(q).join(', ')} FROM (${sol}) t`],
    extra: [ex, `SELECT ${all}, 1 AS surplus FROM (${sol}) t`],
    // The regression guard: a shifted row order makes EVERY column look wrong,
    // so the ORDER BY diagnosis has to win over the per-column one.
    order: [ex, `SELECT ${all} FROM (${sol}) t ORDER BY ${q(c1)} DESC, ${q(c2)} DESC`],
    // Synthetic: every column right on its own, values paired into other rows.
    // Unreachable through the curriculum -- all five unordered exercises return
    // a single row -- so it is built here rather than borrowed.
    pairing: [{ solution: `SELECT * FROM (VALUES ('a',1),('b',2),('c',3)) t(k,v)`, ordered: false },
              `SELECT * FROM (VALUES ('a',2),('b',3),('c',1)) t(k,v)`],
    // Duplicate names cannot be paired, so this falls back to position.
    dupes: [{ solution: `SELECT 1 AS n, 1 AS n`, ordered: false }, `SELECT 1 AS n, 1 AS n`],
  };

  const out = { expected: cols, first: c1, second: c2, exercise: ex.id };
  for (const [k, [exercise, sql]] of Object.entries(cases)) {
    const v = await engine.grade(sql, exercise);
    out[k] = { pass: v.pass, reason: v.reason ?? null, detail: v.detail,
               badColumns: v.badColumns ?? null };
  }
  return out;
});

const has = (k, ...bits) => bits.every((b) => named[k].detail.includes(b));

ok('labels on the wrong columns FAIL (a positional grader passes this)',
   named.labels.pass === false && named.labels.reason === 'column-labels',
   `pass=${named.labels.pass} reason=${named.labels.reason}`);
ok('...and it says which name holds which values',
   has('labels', named.first) && has('labels', named.second)
   && has('labels', 'under the wrong names'));

ok('a wrong column is named, not dumped as a row',
   named.values.reason === 'column-values'
   && (named.values.badColumns ?? []).join() === named.second,
   `reason=${named.values.reason} bad=${named.values.badColumns}`);
ok('...and the columns that are right are listed as right',
   has('values', 'correct: ' + named.first));

ok('renamed columns still PASS -- names stay advisory',
   named.renamed.pass === true && !named.renamed.reason,
   `pass=${named.renamed.pass} reason=${named.renamed.reason}`);
ok('...with the name advisory attached',
   has('renamed', 'column names differ'));

ok('reordered AND renamed passes with both remarks',
   named.both.pass === true && named.both.reason === 'column-order'
   && has('both', 'different order') && has('both', 'column names differ'),
   `pass=${named.both.pass} reason=${named.both.reason}`);

ok('a missing column is named', named.missing.reason === 'shape'
   && has('missing', 'missing: '), named.missing.detail.replace(/\s+/g, ' ').slice(0, 90));
ok('an extra column is named', named.extra.reason === 'shape'
   && has('extra', 'not asked for: surplus'),
   named.extra.detail.replace(/\s+/g, ' ').slice(0, 90));

ok('a wrong ORDER BY still reads as an ordering problem, not N wrong columns',
   named.order.reason === 'order' && has('order', 'add or fix the ORDER BY'),
   `reason=${named.order.reason}`);

ok('right columns paired into the wrong rows reads as a join/grouping problem',
   named.pairing.reason === 'row-pairing' && has('pairing', 'join or grouping'),
   `reason=${named.pairing.reason}`);

ok('duplicate column names fall back to position and still pass',
   named.dupes.pass === true && !named.dupes.reason,
   `pass=${named.dupes.pass} reason=${named.dupes.reason}`);

// ---------------------------------------------------------------------------
// 2. The column-order note reaches the feedback pane as an amber card.
// ---------------------------------------------------------------------------
await page.evaluate(async () => {
  const engine = await import('/assets/js/engine.js');
  const { EXERCISES } = await import('/assets/js/curriculum.js');
  const strip = (s) => s.trim().replace(/;+\s*$/, '');
  for (const ex of EXERCISES) {
    const cols = (await engine.run(strip(ex.solution), { limit: 1 })).columns;
    if (cols.length < 2) continue;
    const rev = [...cols].reverse().map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
    window.__swapped = { id: ex.id, sql: `SELECT ${rev} FROM (${strip(ex.solution)}) AS _swapped` };
    return;
  }
});
const swapped = await page.evaluate(() => window.__swapped);
await page.click(`.ex-item[data-id="${swapped.id}"]`);
await page.waitForTimeout(200);
await page.fill('#editor', swapped.sql);
await page.click('#btn-check');
await page.waitForSelector('.verdict-warn, .verdict-good, .verdict-bad', { timeout: 60000 });

ok('the feedback pane shows the amber note, not a failure',
   await page.locator('.verdict-warn').count() === 1,
   (await page.textContent('#tab-feedback')).replace(/\s+/g, ' ').slice(0, 120));
ok('the feedback dot is amber', await page.locator('#feedback-dot.dot-warn').count() === 1);
ok('a column-order pass still counts as solved',
   await page.evaluate(() => /solved/.test(document.querySelector('#ex-status').textContent)));

// ---------------------------------------------------------------------------
// 3. The Sandbox button says whether you are in the sandbox.
// ---------------------------------------------------------------------------
const btnState = () => page.evaluate(() => {
  const b = document.querySelector('#btn-sandbox');
  const cs = getComputedStyle(b);
  const dot = getComputedStyle(b, '::before');
  return {
    pressed: b.getAttribute('aria-pressed'),
    primary: b.classList.contains('btn-primary'),
    ghost: b.classList.contains('btn-ghost'),
    body: document.body.classList.contains('sandbox'),
    bg: cs.backgroundImage,
    shadow: cs.boxShadow,
    dot: dot.content,
    title: b.title,
  };
});

const off0 = await btnState();
ok('the button starts unpressed', off0.pressed === 'false' && !off0.primary && !off0.body);

await page.click('#btn-sandbox');
await page.waitForTimeout(200);
const on = await btnState();
ok('clicking it turns the mode on', on.pressed === 'true' && on.primary && on.body);
ok('and it is actually filled, not flattened by .btn-ghost',
   on.ghost === false && on.bg.includes('gradient'), on.bg.slice(0, 60));
ok('it gains a ring the other toolbar buttons do not have',
   on.shadow !== off0.shadow, on.shadow.slice(0, 70));
ok('it carries a live dot, so the state is not colour alone',
   on.dot !== 'none' && on.dot !== off0.dot, JSON.stringify(on.dot));
ok('its tooltip says the mode is on', /Sandbox is ON/.test(on.title), on.title);

// Leaving the sandbox by picking an exercise -- the path that used to leave the
// button lit while the mode was already off.
await page.evaluate(() => document.querySelector('.ex-item').click());
await page.waitForTimeout(200);
const off1 = await btnState();
ok('picking an exercise turns the button back off',
   off1.pressed === 'false' && !off1.primary && !off1.body && off1.ghost,
   JSON.stringify({ pressed: off1.pressed, primary: off1.primary, body: off1.body }));
ok('and the fill goes with it', off1.bg === off0.bg, off1.bg.slice(0, 60));

// And back on, then off by the button itself, so the toggle is not one-way.
await page.click('#btn-sandbox');
await page.waitForTimeout(150);
await page.click('#btn-sandbox');
await page.waitForTimeout(150);
const off2 = await btnState();
ok('toggling twice lands back where it started',
   off2.pressed === 'false' && !off2.primary && !off2.body);

ok('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll grading checks passed.');
process.exit(failed ? 1 : 0);
