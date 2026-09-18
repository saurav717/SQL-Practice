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

// --- 5b. table hover cards ------------------------------------------------
await page.locator('.ex-item').first().click();          // the LEFT JOIN drill
await page.waitForSelector('#ex-tables .tbl-chip', { timeout: 10000 });
const chipNames = await page.locator('#ex-tables .tbl-chip').allInnerTexts();
console.log('tables row :', chipNames.join(', '));
if (!chipNames.includes('departments') || !chipNames.includes('employees')) {
  errors.push('the Tables row does not name both tables of joins-1: ' + chipNames.join(', '));
}

// Hovering a chip opens the card, with the columns of that table in it.
await page.locator('#ex-tables .tbl-chip', { hasText: 'employees' }).hover();
await page.waitForSelector('#tbl-card:not([hidden])', { timeout: 5000 });
const cardName = await page.textContent('#tbl-card .tip-name');
const cardCols = await page.locator('#tbl-card .tip-cols th').allInnerTexts();
console.log('hover card :', cardName, '->', cardCols.join(', '));
if (cardName !== 'employees') errors.push('the card describes the wrong table: ' + cardName);
for (const want of ['employee_id', 'department_id', 'manager_id', 'salary']) {
  if (!cardCols.includes(want)) errors.push(`the employees card is missing ${want}`);
}
const cardText = (await page.textContent('#tbl-card')).replace(/\s+/g, ' ');
if (!/departments\.department_id/.test(cardText)) errors.push('the card does not show the join key');
if (!/DECIMAL\(12,2\)/.test(cardText)) errors.push('the card does not show column types: ' + cardText.slice(0, 160));
if (!/contractors/.test(cardText)) errors.push('the card does not carry the table purpose');
if (!/NULL for CEO/.test(cardText)) errors.push('the card does not carry the schema.sql column note');
const onScreen = await page.evaluate(() => {
  const r = document.querySelector('#tbl-card').getBoundingClientRect();
  return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
});
if (!onScreen) errors.push('the hover card is positioned off screen');

// Moving away closes it again.
await page.mouse.move(5, 5);
await page.waitForFunction(() => document.querySelector('#tbl-card').hidden, null, { timeout: 5000 });

// A table named in the prompt text is a trigger too, and a click pins the card
// open -- which is the only way in on a touch screen.
await page.locator('.ex-item', { hasText: 'The fan-out problem' }).click();
await page.waitForSelector('#ex-prompt code.tbl-ref', { timeout: 10000 });
const inline = await page.locator('#ex-prompt code.tbl-ref').allInnerTexts();
console.log('in prompt  :', inline.join(', '));
await page.locator('#ex-prompt code.tbl-ref').first().click();
await page.waitForSelector('#tbl-card.tbl-card-pinned', { timeout: 5000 });
const pinnedName = await page.textContent('#tbl-card .tip-name');
console.log('pinned     :', pinnedName);
if (pinnedName !== inline[0]) errors.push(`clicking \`${inline[0]}\` pinned ${pinnedName}`);
await page.mouse.move(5, 5);                      // a pinned card ignores hover
await page.waitForTimeout(300);
if (await page.locator('#tbl-card').isHidden()) errors.push('the pinned card closed on pointer-out');
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.querySelector('#tbl-card').hidden, null, { timeout: 5000 });
console.log('escape     : card closed');
await page.locator('.ex-item').first().click();

// --- 6. dialect notes -----------------------------------------------------
await page.click('[data-tab="dialect"]');
await page.waitForSelector('.dialect-item', { timeout: 5000 });
console.log('dialect    :', await page.locator('.dialect-item').count(), 'engine notes');

// --- 7. hints -------------------------------------------------------------
await page.click('#btn-hint');
await page.waitForSelector('.hint', { timeout: 5000 });
console.log('hint       :', (await page.textContent('.hint')).replace(/\s+/g, ' ').slice(0, 80));

// --- 7b. solution box: opens, closes, and leaves the draft alone ----------
const myDraft = 'SELECT my_own_attempt;';
await page.fill('#editor', myDraft);
await page.click('#btn-solution');            // already solved above, so no confirm
await page.waitForSelector('#solution:not([hidden])', { timeout: 5000 });
if ((await page.inputValue('#editor')) !== myDraft) errors.push('Show solution overwrote the editor');
await page.click('#btn-solution-hide');
if (await page.isVisible('#solution')) errors.push('the box\'s Hide button did not close the solution');
await page.click('#btn-solution');
await page.click('#btn-solution');
if (await page.isVisible('#solution')) errors.push('the toolbar button did not close the solution');

await page.click('#btn-solution');
page.once('dialog', d => d.accept());         // "replace what is in the editor?"
await page.click('#btn-solution-copy');
const copied = await page.inputValue('#editor');
if (copied === myDraft || !/COUNT/i.test(copied)) errors.push('Copy to editor did not load the reference solution');
console.log('solution   : toggles, draft survives, copy is opt-in');
await page.click('#btn-solution');            // closed again for the steps below
await page.fill('#editor', solution);

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

// --- 9. draggable splitters ----------------------------------------------
const rect = (sel) => page.evaluate(
  (q) => { const r = document.querySelector(q).getBoundingClientRect(); return { w: r.width, h: r.height }; }, sel);

/** Drag a splitter by (dx, dy) from its middle. */
async function dragBy(sel, dx, dy) {
  const b = await page.locator(sel).boundingBox();
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(80);
}
const near = (got, want, slack = 3) => Math.abs(got - want) <= slack;

const sideBefore = (await rect('.sidebar')).w;
await dragBy('#split-sidebar', 130, 0);
const sideAfter = (await rect('.sidebar')).w;
console.log('sidebar    :', `${sideBefore}px -> ${sideAfter}px (dragged +130)`);
if (!near(sideAfter, sideBefore + 130)) errors.push(`sidebar did not follow the drag: ${sideBefore} -> ${sideAfter}`);

// Dragging past the minimum must stop at it, not collapse or invert the pane.
await dragBy('#split-sidebar', -900, 0);
const sideMin = (await rect('.sidebar')).w;
console.log('min clamp  :', `${sideMin}px after dragging 900px left`);
if (sideMin < 150 || sideMin > 230) errors.push(`sidebar min clamp is wrong: ${sideMin}`);
await dragBy('#split-sidebar', 96, 0);

// The lower pane: dragging the seam up grows the results panel.
const outBefore = (await rect('.output-pane')).h;
const edBefore  = (await rect('.editor-pane')).h;
await dragBy('#split-editor', 0, -90);
const outAfter = (await rect('.output-pane')).h;
const edAfter  = (await rect('.editor-pane')).h;
console.log('output pane:', `${outBefore}px -> ${outAfter}px, editor ${edBefore}px -> ${edAfter}px`);
if (!near(outAfter, outBefore + 90)) errors.push(`output pane did not grow: ${outBefore} -> ${outAfter}`);
if (!near(edAfter, edBefore - 90)) errors.push(`editor pane did not shrink: ${edBefore} -> ${edAfter}`);

// Until its seam is dragged, the prompt pane sizes itself to the exercise text.
const promptFit = () => page.evaluate(() => {
  const p = document.querySelector('.prompt-pane');
  return { shown: Math.round(p.clientHeight), text: Math.round(p.scrollHeight),
           cap: Math.round(window.innerHeight * 0.42) };
});
const fits = (f) => f.text <= f.shown + 2 || f.shown >= f.cap - 2;
await page.locator('.ex-item').nth(12).click();
await page.waitForTimeout(120);
const fitA = await promptFit();
console.log('auto-fit   :', JSON.stringify(fitA));
if (!fits(fitA)) errors.push(`prompt pane does not fit its text: ${JSON.stringify(fitA)}`);

// The prompt seam, and the editor growing with its pane.
const promptBefore = (await rect('.prompt-pane')).h;
const wrapBefore   = (await rect('.editor-wrap')).h;
await dragBy('#split-prompt', 0, -60);
const promptAfter = (await rect('.prompt-pane')).h;
console.log('prompt pane:', `${promptBefore}px -> ${promptAfter}px (dragged -60)`);
if (!near(promptAfter, promptBefore - 60)) errors.push(`prompt pane did not follow the drag: ${promptBefore} -> ${promptAfter}`);

// Once dragged, it stays put -- auto-fit must not overrule the user.
await page.locator('.ex-item').nth(3).click();
await page.waitForTimeout(120);
const promptHeld = (await rect('.prompt-pane')).h;
console.log('stays put  :', `${promptHeld}px after switching exercise`);
if (!near(promptHeld, promptAfter)) errors.push(`auto-fit overruled a dragged prompt pane: ${promptAfter} -> ${promptHeld}`);

// Double-click resets one seam -- for the prompt, back to following its text.
await page.locator('#split-prompt').dblclick();
await page.waitForTimeout(80);
const fitB = await promptFit();
console.log('dbl-click  :', `prompt back to ${fitB.shown}px, text ${fitB.text}px`);
if (!fits(fitB)) errors.push(`double-click did not restore auto-fit: ${JSON.stringify(fitB)}`);

// A focused splitter answers the arrow keys.
const keyBefore = (await rect('.output-pane')).h;
await page.locator('#split-editor').focus();
await page.keyboard.press('ArrowUp');
const keyAfter = (await rect('.output-pane')).h;
console.log('arrow keys :', `${keyBefore}px -> ${keyAfter}px`);
if (keyAfter <= keyBefore) errors.push('ArrowUp on the results splitter did not resize it');

// Sizes must survive a reload -- a layout you have to re-drag is not a layout.
const wantSide = (await rect('.sidebar')).w;
const wantOut  = (await rect('.output-pane')).h;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#topbar:not([hidden])', { timeout: 90000 });
const gotSide = (await rect('.sidebar')).w;
const gotOut  = (await rect('.output-pane')).h;
console.log('persisted  :', `sidebar ${gotSide}px, output ${gotOut}px`);
if (!near(gotSide, wantSide)) errors.push(`sidebar width lost on reload: ${wantSide} -> ${gotSide}`);
if (!near(gotOut, wantOut, 6)) errors.push(`output height lost on reload: ${wantOut} -> ${gotOut}`);
if (wrapBefore <= 0) errors.push('editor-wrap has no height');

// Sandbox drops the prompt pane, so the remaining panes have to re-share the
// room rather than leave a gap behind.
await page.click('#btn-sandbox');
await page.waitForTimeout(120);
const sandboxHidden = await page.locator('#split-prompt').isHidden();
const sandboxOut = (await rect('.output-pane')).h;
console.log('sandbox    :', `prompt seam ${sandboxHidden ? 'hidden' : 'STILL SHOWN'}, output ${sandboxOut}px`);
if (!sandboxHidden) errors.push('the prompt splitter is still visible in Sandbox mode');
if (sandboxOut < 100) errors.push(`output pane collapsed in Sandbox mode: ${sandboxOut}`);
await page.click('#btn-sandbox');
await page.waitForTimeout(120);

// --- 9b. rearranging the tiles -------------------------------------------
const tileBox = () => page.evaluate(() => {
  const out = {};
  for (const el of document.querySelectorAll('[data-tile]')) {
    const r = el.getBoundingClientRect();
    out[el.dataset.tile] = { x: Math.round(r.left), y: Math.round(r.top),
                             w: Math.round(r.width), h: Math.round(r.height) };
  }
  return out;
});
const order = (boxes, axis) => Object.keys(boxes).sort((a, b) => boxes[a][axis] - boxes[b][axis]).join(' ');

// The four arrows on a tile bar send that tile to an edge of the window.
await page.click('[data-tile="sidebar"] .tile-move[data-move="right"]');
await page.waitForTimeout(120);
let tb = await tileBox();
console.log('to right   :', order(tb, 'x'), `(exercise list at x=${tb.sidebar.x})`);
if (tb.sidebar.x < tb.output.x) errors.push('the exercise list did not move to the right edge');

await page.click('[data-tile="sidebar"] .tile-move[data-move="bottom"]');
await page.waitForTimeout(120);
tb = await tileBox();
console.log('to bottom  :', order(tb, 'y'), `(exercise list at y=${tb.sidebar.y})`);
if (tb.sidebar.y < tb.output.y) errors.push('the exercise list did not move to the bottom edge');
if (Math.abs(tb.sidebar.w - tb.editor.w) > 2) errors.push('a tile at the bottom edge does not span the width');

/**
 * Pick a tile up by its bar and drop it at (fx, fy) of another tile, where
 * both are fractions of that tile's box. Returns the drop hint that was on
 * screen at the moment of the drop.
 */
async function dragTile(pane, onto, fx, fy, { cancel = false } = {}) {
  const bar = await page.locator(`[data-tile="${pane}"] .tile-bar`).boundingBox();
  const t = await page.locator(`[data-tile="${onto}"]`).boundingBox();
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width / 2 + 24, bar.y + bar.height / 2 + 24, { steps: 4 });
  await page.mouse.move(t.x + t.width * fx, t.y + t.height * fy, { steps: 10 });
  const hint = await page.textContent('#dock-drop .dock-drop-label').catch(() => '(none)');
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(120);
  return hint;
}

// Dropped against an edge, a tile splits the tile it landed on.
console.log('drop hint  :', await dragTile('editor', 'output', 0.08, 0.5));
tb = await tileBox();
console.log('side by side:', `editor ${tb.editor.w}px at x=${tb.editor.x}, results ${tb.output.w}px at x=${tb.output.x}`);
if (tb.editor.x >= tb.output.x) errors.push('the editor did not land to the left of the results panel');
if (Math.abs(tb.editor.y - tb.output.y) > 2) errors.push('the editor and the results panel are not side by side');

// Dropped in the middle, the two tiles trade places.
const beforeSwap = await tileBox();
console.log('swap hint  :', await dragTile('prompt', 'output', 0.5, 0.5));
tb = await tileBox();
console.log('swapped    :', `prompt at (${tb.prompt.x},${tb.prompt.y}), results at (${tb.output.x},${tb.output.y})`);
// Each ends up in the other's slot. Only the elastic tile's own size changes
// with it, so the slot a swap lands in can be a little taller or shorter.
if (!near(tb.prompt.x, beforeSwap.output.x, 2) || !near(tb.output.x, beforeSwap.prompt.x, 2) ||
    !near(tb.output.y, beforeSwap.prompt.y, 2) || tb.prompt.y <= beforeSwap.prompt.y) {
  errors.push('a centre drop did not swap the two tiles: ' + JSON.stringify(tb));
}

// An arrangement you have to rebuild every visit is not an arrangement.
const wantTiles = await tileBox();
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#topbar:not([hidden])', { timeout: 90000 });
await page.waitForTimeout(150);
const gotTiles = await tileBox();
console.log('persisted  :', JSON.stringify(gotTiles) === JSON.stringify(wantTiles) ? 'same arrangement' : 'CHANGED');
for (const pane of Object.keys(wantTiles)) {
  if (!near(gotTiles[pane].x, wantTiles[pane].x, 2) || !near(gotTiles[pane].y, wantTiles[pane].y, 2)) {
    errors.push(`${pane} moved across a reload: ${JSON.stringify(wantTiles[pane])} -> ${JSON.stringify(gotTiles[pane])}`);
  }
}

// Escape during a drag must leave the layout exactly as it was.
const beforeCancel = await tileBox();
await dragTile('editor', 'sidebar', 0.5, 0.9, { cancel: true });
if (JSON.stringify(await tileBox()) !== JSON.stringify(beforeCancel)) {
  errors.push('Escape did not cancel the drag');
}
console.log('escape     : drag cancelled, layout untouched');

// --- 9c. rearranging the output tabs -------------------------------------
const tabNames = () => page.evaluate(() => [...document.querySelectorAll('.tab')].map(t => t.dataset.tab));
const activeTab = () => page.evaluate(() => document.querySelector('.tab-on')?.dataset.tab);
console.log('tabs       :', (await tabNames()).join(', '));

await page.click('[data-tab="results"]');
const schemaTab = await page.locator('.tab[data-tab="schema"]').boundingBox();
const firstTab  = await page.locator('.tab[data-tab="results"]').boundingBox();
await page.mouse.move(schemaTab.x + schemaTab.width / 2, schemaTab.y + schemaTab.height / 2);
await page.mouse.down();
await page.mouse.move(firstTab.x + 4, firstTab.y + firstTab.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(120);
const dragged = await tabNames();
console.log('reordered  :', dragged.join(', '));
if (dragged[0] !== 'schema') errors.push('dragging the Schema tab did not move it to the front: ' + dragged.join(','));
// Rearranging is not selecting: the panel you were reading stays open.
if (await activeTab() !== 'results') errors.push('dragging a tab also switched to it');

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#topbar:not([hidden])', { timeout: 90000 });
const keptTabs = await tabNames();
console.log('tabs kept  :', keptTabs.join(', '));
if (keptTabs.join() !== dragged.join()) errors.push(`tab order lost on reload: ${dragged.join()} -> ${keptTabs.join()}`);

// Shift + arrow does the same thing from the keyboard.
await page.locator('.tab[data-tab="schema"]').focus();
await page.keyboard.press('Shift+ArrowRight');
const nudged = await tabNames();
console.log('shift+right:', nudged.join(', '));
if (nudged[0] === 'schema') errors.push('shift+ArrowRight did not move the focused tab');

// One button puts every tile and every tab back.
await page.click('#btn-reset-layout');
await page.waitForTimeout(150);
tb = await tileBox();
const resetTabs = await tabNames();
console.log('reset      :', order(tb, 'x'), '|', resetTabs.join(', '));
if (tb.sidebar.x >= tb.prompt.x || tb.prompt.y >= tb.editor.y || tb.editor.y >= tb.output.y) {
  errors.push('Reset layout did not restore the default arrangement: ' + JSON.stringify(tb));
}
if (resetTabs.join() !== 'results,feedback,portability,dialect,schema,activity') {
  errors.push('Reset layout did not restore the tab order: ' + resetTabs.join());
}

// --- 10. comment toggle (Cmd/Ctrl + /) -----------------------------------
await page.fill('#editor', 'SELECT 1\n  SELECT 2');
await page.click('#editor');
await page.keyboard.press('Control+a');
await page.keyboard.press('Control+Slash');
const commented = await page.inputValue('#editor');
console.log('comment    :', JSON.stringify(commented));
if (commented !== '-- SELECT 1\n--   SELECT 2') errors.push('Ctrl+/ did not comment the block: ' + JSON.stringify(commented));
await page.keyboard.press('Control+Slash');
const uncommented = await page.inputValue('#editor');
console.log('uncomment  :', JSON.stringify(uncommented));
if (uncommented !== 'SELECT 1\n  SELECT 2') errors.push('Ctrl+/ did not uncomment: ' + JSON.stringify(uncommented));

// One line, no selection: the caret's line only.
await page.fill('#editor', 'SELECT 1\nSELECT 2');
await page.evaluate(() => {
  const e = document.querySelector('#editor');
  e.focus(); e.setSelectionRange(2, 2);
});
await page.keyboard.press('Control+Slash');
const oneLine = await page.inputValue('#editor');
console.log('one line   :', JSON.stringify(oneLine));
if (oneLine !== '-- SELECT 1\nSELECT 2') errors.push('Ctrl+/ on a caret did not comment just that line: ' + JSON.stringify(oneLine));

// --- 11. run the statement at the cursor ---------------------------------
const script = 'SELECT 111 AS a;\n\nSELECT 222 AS b;\n';
const caretTo = (pos) => page.evaluate((p) => {
  const e = document.querySelector('#editor');
  e.focus(); e.setSelectionRange(p, p);
  document.dispatchEvent(new Event('selectionchange'));
}, pos);
const firstCell = () => page.locator('table.grid tbody tr td').first().innerText();

await page.fill('#editor', script);
await caretTo(4);                                     // inside statement 1
await page.waitForTimeout(60);
console.log('indicator  :', await page.textContent('#stmt-indicator'));
if (!(await page.locator('.stmt-active').count())) errors.push('the statement at the cursor is not marked in the editor');
await page.click('#btn-run');
await page.waitForSelector('table.grid', { timeout: 30000 });
console.log('stmt 1     :', await firstCell(), '|', await page.textContent('#status-right'));
if ((await firstCell()).trim() !== '111') errors.push('Run did not run the statement at the cursor (expected 111)');

await caretTo(script.indexOf('SELECT 222') + 3);      // inside statement 2
await page.click('#btn-run');
await page.waitForFunction(() => document.querySelector('table.grid tbody td')?.innerText.trim() === '222', null, { timeout: 30000 });
console.log('stmt 2     :', await firstCell(), '|', await page.textContent('#status-right'));

// A selection wins over the cursor's statement, as in a worksheet.
await page.evaluate(() => {
  const e = document.querySelector('#editor');
  const a = e.value.indexOf('SELECT 111');
  e.focus(); e.setSelectionRange(a, a + 'SELECT 111 AS a'.length);
});
await page.click('#btn-run');
await page.waitForFunction(() => document.querySelector('table.grid tbody td')?.innerText.trim() === '111', null, { timeout: 30000 });
console.log('selection  :', await firstCell(), '|', await page.textContent('#status-right'));

// Run all walks the whole script and reports on it.
await caretTo(0);
await page.click('#btn-run-all');
await page.waitForFunction(() => /Ran 2 statements/.test(document.querySelector('#status-left').textContent), null, { timeout: 30000 });
console.log('run all    :', await page.textContent('#status-left'), '|', await page.textContent('#status-right'));
if ((await firstCell()).trim() !== '222') errors.push('Run all did not leave the last statement on screen');

// Grading uses the same target, so scratch work above an answer is ignored.
await page.locator('.ex-item').first().click();   // back to the LEFT JOIN drill
await page.fill('#editor', 'SELECT 1 AS scratch;\n\n' + solution);
await caretTo(30);
await page.click('#btn-check');
await page.waitForSelector('.verdict-good', { timeout: 30000 });
console.log('check stmt :', (await page.textContent('.verdict-good')).replace(/\s+/g, ' ').slice(0, 60));

// Leave no recorded positions behind for the screenshots below.
await page.click('[data-tab="activity"]');
await page.waitForSelector('#act-clear', { timeout: 5000 });
page.once('dialog', d => d.accept());
await page.click('#act-clear');
await page.click('[data-tab="results"]');

// --- 12. responsive -------------------------------------------------------
await page.setViewportSize({ width: 390, height: 780 });
await page.waitForTimeout(300);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
console.log('mobile 390 :', overflow ? 'HORIZONTAL OVERFLOW' : 'no horizontal overflow');
// Sideways scroll on a phone is a bug, not a note: a topbar one button too
// wide is exactly how it gets introduced, and it was only logged before.
if (overflow) errors.push('the page scrolls sideways at 390px');

// The Claude panel is the one tile that is closed to begin with, so it has to
// be opened to be checked at this width.
await page.click('#btn-assistant');
await page.waitForTimeout(200);
const chatOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
console.log('chat 390   :', chatOverflow ? 'HORIZONTAL OVERFLOW' : 'no horizontal overflow');
if (chatOverflow) errors.push('the Claude panel scrolls sideways at 390px');
await page.click('#btn-assistant');

await page.screenshot({ path: '/tmp/shot-mobile.png', fullPage: false });
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/shot-desktop.png' });

console.log('\nconsole errors:', errors.length ? errors.slice(0, 5) : 'none');
await context.close();
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
