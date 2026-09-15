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

// Sections 1-8 click buttons, tabs and the exercise list, so pin the style
// that shows them; section 9 covers the default Zen surface, which has none.
await page.addInitScript(() => localStorage.setItem('sqlpractice.v1',
  JSON.stringify({ skin: 'studio', theme: 'dark' })));

const t0 = Date.now();
await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
console.log('waiting for engine boot...');
try {
  await page.waitForSelector('#boot', { state: 'detached', timeout: 90000 });
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

// --- 8. Zen: the default surface, driven entirely from the keyboard -------
// switch through the palette, the way you would from inside Zen
await page.keyboard.press('Control+k');
await page.waitForSelector('#palette:not([hidden])', { timeout: 5000 });
await page.fill('#palette-input', 'style zen');
await page.keyboard.press('Enter');
await page.waitForTimeout(250);
const gone = await Promise.all(['.topbar', '.sidebar', '.toolbar', '.tabs']
  .map(sel => page.isHidden(sel)));
console.log('zen chrome :', gone.every(Boolean) ? 'top bar, list, toolbar and tabs all hidden' : 'STILL VISIBLE');

await page.fill('#editor', 'SELECT country, count(*) AS n FROM customers GROUP BY 1 ORDER BY n DESC LIMIT 3');
await page.keyboard.press('Control+Enter');
await page.waitForSelector('table.grid', { timeout: 30000 });
await page.waitForFunction(() => !/Running/.test(document.querySelector('#status-left').textContent), null, { timeout: 15000 });
console.log('zen run    :', await page.textContent('#status-left'));

const wrapH = await page.evaluate(() => document.querySelector('.editor-wrap').getBoundingClientRect().height);
await page.fill('#editor', 'SELECT 1\n'.repeat(18));
await page.waitForTimeout(150);
const wrapH2 = await page.evaluate(() => document.querySelector('.editor-wrap').getBoundingClientRect().height);
console.log('zen editor :', wrapH2 > wrapH ? `grows with the query (${wrapH.toFixed(0)} -> ${wrapH2.toFixed(0)}px)` : 'DID NOT GROW');

await page.keyboard.press('Control+k');
await page.waitForSelector('#palette:not([hidden])', { timeout: 5000 });
await page.fill('#palette-input', 'rollz');
await page.waitForTimeout(150);
console.log('palette    :', await page.textContent('.palette-item-on .palette-label'), '(fuzzy "rollz")');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
console.log('palette go :', (await page.textContent('#ex-title')).trim(),
            '| closed:', await page.isHidden('#palette'));

await page.keyboard.press('Control+k');
await page.fill('#palette-input', 'show schema');
await page.keyboard.press('Enter');
await page.waitForSelector('.schema-table', { timeout: 15000 });
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
console.log('esc        :', await page.isVisible('#tab-results.tab-panel-on') ? 'returns to results' : 'DID NOT RETURN');

await page.keyboard.press('Control+p');
await page.waitForTimeout(150);
const folded = await page.isHidden('#ex-prompt');
await page.keyboard.press('Control+p');
await page.waitForTimeout(150);
console.log('prompt     :', folded && await page.isVisible('#ex-prompt') ? 'folds and unfolds on Ctrl+P' : 'FOLD BROKEN');

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
