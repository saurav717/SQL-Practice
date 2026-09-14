// End-to-end check: boot the real page in Chromium, solve an exercise, and
// verify the grader, the linter and the results grid all work.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.wasm':'application/wasm', '.sql':'text/plain', '.json':'application/json' };

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  const file = p.endsWith('/') ? path.join(p, 'index.html') : p;
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise(r => server.listen(8099, r));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('console', m => { const t = `[${m.type()}] ${m.text()}`; console.log('  BROWSER', t); if (m.type()==='error') errors.push(t); });
page.on('pageerror', e => { console.log('  PAGEERROR', e.message); errors.push('PAGEERROR: ' + e.message); });
page.on('requestfailed', r => console.log('  REQFAIL', r.url().slice(0,110), r.failure()?.errorText));
page.on('response', r => { if (r.status() >= 400) console.log('  HTTP', r.status(), r.url().slice(0,110)); });

const t0 = Date.now();
await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
console.log('waiting for engine boot...');
try {
  await page.waitForSelector('#topbar:not([hidden])', { timeout: 90000 });
} catch (e) {
  console.log('BOOT STALLED. status text =', await page.textContent('#boot-status').catch(()=>'(gone)'));
  console.log('boot error box =', await page.textContent('.boot-error').catch(()=>'(none)'));
  await browser.close(); server.close(); process.exit(1);
}
console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

console.log('engine     :', await page.textContent('#engine-version'));
console.log('exercise   :', await page.textContent('#ex-title'));
console.log('progress   :', await page.textContent('#progress-label'));
const sidebarCount = await page.locator('.ex-item').count();
console.log('sidebar    :', sidebarCount, 'exercises listed');

// --- 1. run a plain query -------------------------------------------------
await page.fill('#editor', 'SELECT country, count(*) AS n FROM customers GROUP BY 1 ORDER BY n DESC LIMIT 5');
await page.click('#btn-run');
await page.waitForSelector('table.grid', { timeout: 30000 });
console.log('run status :', await page.textContent('#status-left'));
console.log('first row  :', (await page.locator('table.grid tbody tr').first().innerText()).replace(/\s+/g, ' '));

// --- 2. submit a WRONG answer --------------------------------------------
await page.fill('#editor', 'SELECT dept_name, count(*) AS employee_count FROM departments d JOIN employees e ON e.department_id=d.department_id GROUP BY 1 ORDER BY 1');
await page.click('#btn-check');
await page.waitForSelector('.verdict-bad', { timeout: 30000 });
console.log('wrong ans  :', (await page.textContent('.verdict-bad')).replace(/\s+/g, ' ').slice(0, 130));

// --- 3. submit the CORRECT answer ----------------------------------------
const solution = `SELECT d.dept_name, COUNT(e.employee_id) AS employee_count
FROM departments d
LEFT JOIN employees e ON e.department_id = d.department_id
GROUP BY d.dept_name
ORDER BY d.dept_name`;
await page.fill('#editor', solution);
await page.click('#btn-check');
await page.waitForSelector('.verdict-good', { timeout: 30000 });
console.log('right ans  :', (await page.textContent('.verdict-good')).replace(/\s+/g, ' ').slice(0, 90));
console.log('progress   :', await page.textContent('#progress-label'));

// --- 4. portability linter -----------------------------------------------
await page.selectOption('#engine-select', 'redshift');
await page.fill('#editor', "SELECT x FROM t QUALIFY row_number() OVER (ORDER BY x) = 1");
await page.waitForTimeout(500);
await page.click('[data-tab="portability"]');
await page.waitForSelector('.lint-item', { timeout: 10000 });
console.log('lint(rs)   :', (await page.textContent('.lint-item')).replace(/\s+/g, ' ').slice(0, 100));
await page.selectOption('#engine-select', 'snowflake');
await page.waitForTimeout(400);
const snowLint = await page.locator('.lint-item').count();
console.log('lint(snow) :', snowLint, 'findings (QUALIFY is native there)');

// --- 5. schema browser ----------------------------------------------------
await page.click('[data-tab="schema"]');
await page.waitForSelector('.schema-table', { timeout: 15000 });
console.log('schema     :', await page.locator('.schema-table').count(), 'tables');

// --- 6. dialect notes -----------------------------------------------------
await page.click('[data-tab="dialect"]');
await page.waitForSelector('.dialect-item', { timeout: 5000 });
console.log('dialect    :', await page.locator('.dialect-item').count(), 'engine notes');

// --- 7. hints -------------------------------------------------------------
await page.click('#btn-hint');
await page.waitForSelector('.hint', { timeout: 5000 });
console.log('hint       :', (await page.textContent('.hint')).replace(/\s+/g, ' ').slice(0, 80));

// --- 8. Explore mode ------------------------------------------------------
await page.click('#btn-explore');
await page.waitForSelector('#explore-pane:not([hidden])', { timeout: 10000 });
const exploreChecks = {
  'prompt pane hidden': !(await page.isVisible('.prompt-pane')),
  'exercise list hidden': !(await page.isVisible('#exercise-list')),
  'check button hidden': !(await page.isVisible('#btn-check')),
};
for (const [k, v] of Object.entries(exploreChecks)) {
  console.log(`explore    : ${k} = ${v}`);
  if (!v) errors.push(`explore mode: ${k} failed`);
}

// table browser: every table listed, and peek runs a preview
await page.waitForSelector('.tbl-head', { timeout: 20000 });
const tableCount = await page.locator('.tbl-head').count();
console.log('tables     :', tableCount, 'tables in the browser');
if (tableCount < 24) errors.push(`explore: expected >= 24 tables, saw ${tableCount}`);

await page.locator('.tbl-head').filter({ hasText: 'api_events' }).locator('.tbl-peek').click();
await page.waitForFunction(() => !/Running/.test(document.querySelector('#status-left').textContent), null, { timeout: 30000 });
console.log('peek       :', await page.textContent('#status-left'));

// expanding a table lists its columns
await page.locator('.tbl-head').filter({ hasText: 'fx_rates' }).locator('.tbl-toggle').click();
await page.waitForSelector('.tbl-col', { timeout: 5000 });
console.log('columns    :', await page.locator('.tbl-col').count(), 'columns shown for fx_rates');

// recipes: all listed, searchable, and one runs end to end
await page.click('[data-browser="recipes"]');
await page.waitForSelector('#recipe-list .ex-item', { timeout: 10000 });
console.log('recipes    :', await page.locator('#recipe-list .ex-item').count(), 'recipes listed');
await page.fill('#search', 'fan-out');
await page.waitForTimeout(250);
console.log('search     :', await page.locator('#recipe-list .ex-item').count(), 'match "fan-out"');
await page.fill('#search', '');
await page.waitForTimeout(250);
await page.locator('#recipe-list .ex-item').first().click();
await page.waitForFunction(() => !/Running/.test(document.querySelector('#status-left').textContent), null, { timeout: 30000 });
console.log('recipe run :', await page.textContent('#status-left'));

// a multi-statement script: DDL then DML then a SELECT, last grid wins
await page.fill('#editor', 'CREATE OR REPLACE TABLE t_probe AS SELECT 1 AS a; INSERT INTO t_probe VALUES (2); SELECT sum(a) AS total FROM t_probe;');
await page.click('#btn-run');
await page.waitForFunction(() => /rows in/.test(document.querySelector('#status-left').textContent), null, { timeout: 30000 });
const scriptTotal = (await page.locator('table.grid tbody tr').first().innerText()).trim();
console.log('script     :', await page.textContent('#status-right'), '-> total =', scriptTotal);
if (scriptTotal !== '3') errors.push(`explore: multi-statement script returned ${scriptTotal}, expected 3`);

// an error must name which statement failed
await page.fill('#editor', 'SELECT 1; SELECT * FROM no_such_table;');
await page.click('#btn-run');
await page.waitForSelector('.verdict-bad', { timeout: 15000 });
const errText = (await page.textContent('#tab-results')).replace(/\s+/g, ' ');
console.log('stmt error :', errText.slice(0, 110));
if (!/statement 2 of 2/.test(errText)) errors.push('explore: error did not name the failing statement');
if (/DESCRIBE/.test(errText)) errors.push('explore: internal DESCRIBE wrapper leaked into the error message');

// history records what was run
await page.click('[data-browser="history"]');
await page.waitForSelector('.hist-item', { timeout: 5000 });
console.log('history    :', await page.locator('.hist-item').count(), 'entries');

// leaving Explore restores practice mode intact
await page.click('#btn-explore');
await page.waitForTimeout(300);
const restored = (await page.isVisible('.prompt-pane')) && (await page.isVisible('#btn-check'))
              && !(await page.isVisible('#explore-pane'));
console.log('restored   :', restored);
if (!restored) errors.push('explore: practice mode did not come back cleanly');
await page.click('#btn-explore');
await page.waitForTimeout(300);

// --- 9. responsive --------------------------------------------------------
await page.setViewportSize({ width: 390, height: 780 });
await page.waitForTimeout(300);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
console.log('mobile 390 :', overflow ? 'HORIZONTAL OVERFLOW' : 'no horizontal overflow');

await page.screenshot({ path: '/tmp/shot-mobile.png', fullPage: false });
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/shot-desktop.png' });

console.log('\nconsole errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
