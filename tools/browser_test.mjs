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
// A fixed fake position, so the activity-log test below can assert on it
// without depending on where CI happens to be running.
const context = await browser.newContext({
  permissions: ['geolocation'],
  geolocation: { latitude: 17.5954, longitude: 78.1229, accuracy: 25 },
});
const page = await context.newPage();
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

// --- 8. activity log ------------------------------------------------------
await page.click('[data-tab="activity"]');
await page.waitForSelector('#act-logging', { timeout: 5000 });
const logged = await page.locator('.act-table tbody tr').count();
console.log('activity   :', logged, 'entries recorded (1 run + 2 checks expected)');
if (logged < 3) { errors.push(`activity log recorded ${logged} entries, expected >= 3`); }

const devId = (await page.textContent('.act-ident code')).trim();
console.log('device id  :', devId);
if (!/^[0-9a-f-]{36}$/.test(devId)) errors.push('device id is not a UUID: ' + devId);

// The log must survive a reload -- it is the whole point of storing it.
const beforeReload = logged;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#topbar:not([hidden])', { timeout: 90000 });
await page.click('[data-tab="activity"]');
await page.waitForSelector('.act-table', { timeout: 5000 });
const afterReload = await page.locator('.act-table tbody tr').count();
console.log('persisted  :', afterReload, 'entries after reload');
if (afterReload !== beforeReload) errors.push(`log did not persist: ${beforeReload} -> ${afterReload}`);
const idAfter = (await page.textContent('.act-ident code')).trim();
if (idAfter !== devId) errors.push(`device id changed across reload: ${devId} -> ${idAfter}`);

// Opt in to location, then run a query and check the fix rides along.
await page.click('#act-location');  // click, not check(): the handler re-renders the panel
await page.waitForFunction(() => {
  const el = document.querySelector('#act-location');
  return el && el.checked && !el.disabled;
}, null, { timeout: 15000 });
console.log('location   :', (await page.textContent('.act-ident')).match(/17\.\d+, 78\.\d+/)?.[0] ?? 'NO FIX');

await page.fill('#editor', 'SELECT count(*) AS n FROM orders');
await page.click('#btn-run');
await page.waitForSelector('table.grid', { timeout: 30000 });
await page.click('[data-tab="activity"]');
await page.waitForSelector('.act-table', { timeout: 5000 });
const newestLoc = (await page.locator('.act-table tbody tr td').nth(4).innerText()).trim();
console.log('geo-tagged :', newestLoc);
if (!/^17\.\d+, 78\.\d+$/.test(newestLoc)) errors.push('newest entry carries no location: ' + newestLoc);

// Turning recording off must actually stop it.
await page.click('#act-logging');   // now unchecked
const countBefore = await page.locator('.act-table tbody tr').count();
await page.fill('#editor', 'SELECT 1 AS one');
await page.click('#btn-run');
await page.waitForSelector('table.grid', { timeout: 30000 });
await page.click('[data-tab="activity"]');
const countAfter = await page.locator('.act-table tbody tr').count();
console.log('opt-out    :', countBefore, '->', countAfter, '(must not grow)');
if (countAfter !== countBefore) errors.push('logging continued after opt-out');
await page.click('#act-logging');   // back on

// Clear the log, so the screenshots below do not ship a recorded position.
page.once('dialog', d => d.accept());
await page.click('#act-clear');
await page.waitForSelector('.act-table', { state: 'detached', timeout: 5000 });
console.log('cleared    :', (await page.locator('#activity-count').isHidden()) ? 'badge hidden' : 'BADGE STILL SHOWN');

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
await context.close();
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
