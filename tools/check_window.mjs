// The Claude panel as a floating window: does it behave like one?
//
// Everything here is geometry and input, not conversation -- check_assistant
// covers the streaming half. What this asserts is the bargain the window
// makes: it costs the layout nothing, it goes where you drag it, it resizes
// from any edge without the opposite edge wandering, it cannot be lost off
// the page, and it is still where you left it after a reload.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 8094;
const ORIGIN = `http://localhost:${PORT}`;
const VIEW = { width: 1600, height: 950 };
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

// Playwright's own download when there is one; the browser this container
// ships with otherwise. CHROME_PATH wins over both.
const VENDORED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = process.env.CHROME_PATH
  || (fs.existsSync(VENDORED) ? VENDORED : undefined);

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: VIEW })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#topbar:not([hidden])', { timeout: 120000 });

const box = () => page.evaluate(() => {
  const r = document.querySelector('[data-tile="assistant"]').getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
});
const editorWidth = async () => (await page.locator('.editor-pane').boundingBox()).width;

// --- it opens as a window, and the layout does not notice -----------------
const alone = await editorWidth();
await page.click('#btn-assistant');
await page.waitForTimeout(250);
ok('opens as a floating window', await page.locator('[data-tile="assistant"].tile-float').count() === 1);
ok('costs the editor no width', Math.abs(alone - await editorWidth()) < 2);

// --- dragged by its title bar ---------------------------------------------
const before = await box();
const bar = await page.locator('[data-tile="assistant"] .tile-bar').boundingBox();
await page.mouse.move(bar.x + 60, bar.y + 14);
await page.mouse.down();
await page.mouse.move(bar.x - 340, bar.y + 40, { steps: 12 });
await page.mouse.up();
const moved = await box();
ok('drags by its title bar',
   Math.abs(moved.x - (before.x - 400)) < 12 && Math.abs(moved.y - (before.y + 26)) < 12,
   `${before.x},${before.y} -> ${moved.x},${moved.y}`);
ok('keeps its size while moving', moved.w === before.w && moved.h === before.h);

// --- resized from a corner and from an edge -------------------------------
const se = await page.locator('.win-grip-se').boundingBox();
await page.mouse.move(se.x + 7, se.y + 7);
await page.mouse.down();
await page.mouse.move(se.x + 137, se.y - 63, { steps: 10 });
await page.mouse.up();
const sized = await box();
ok('resizes from the corner',
   Math.abs(sized.w - (moved.w + 130)) < 12 && Math.abs(sized.h - (moved.h - 70)) < 12,
   `${moved.w}x${moved.h} -> ${sized.w}x${sized.h}`);
ok('the corner drag leaves the top-left alone', sized.x === moved.x && sized.y === moved.y);

const w = await page.locator('.win-grip-w').boundingBox();
await page.mouse.move(w.x + 4, w.y + 60);
await page.mouse.down();
await page.mouse.move(w.x - 66, w.y + 60, { steps: 8 });
await page.mouse.up();
const west = await box();
ok('the west edge moves and the east edge does not',
   west.w > sized.w && Math.abs((west.x + west.w) - (sized.x + sized.w)) < 3,
   `right edge ${sized.x + sized.w} -> ${west.x + west.w}`);

// --- it cannot be thrown away ---------------------------------------------
const bar2 = await page.locator('[data-tile="assistant"] .tile-bar').boundingBox();
await page.mouse.move(bar2.x + 60, bar2.y + 14);
await page.mouse.down();
await page.mouse.move(bar2.x - 4000, bar2.y - 4000, { steps: 10 });
await page.mouse.up();
const off = await box();
ok('a window cannot be dragged off the page',
   off.x >= 8 && off.y >= 52 && off.x + off.w <= VIEW.width - 8 && off.y + off.h <= VIEW.height - 8,
   JSON.stringify(off));

// --- the frame and the tint -----------------------------------------------
const styles = [];
for (let i = 0; i < 5; i++) {
  styles.push(await page.getAttribute('.tile-float', 'data-win-style'));
  await page.click('#chat-style');
  await page.waitForTimeout(60);
}
ok('the style button cycles the four frames and wraps',
   styles.join(',') === 'frosted,clear,terminal,aurora,frosted', styles.join(','));

await page.fill('#chat-tint', '40');
await page.dispatchEvent('#chat-tint', 'input');
const tint = await page.evaluate(() =>
  document.querySelector('.tile-float').style.getPropertyValue('--win-tint'));
ok('the slider drives the tint', Number(tint) === 0.4, `--win-tint: ${tint}`);

// --- docked, it is a tile again -------------------------------------------
await page.click('#chat-float');
await page.waitForTimeout(250);
ok('docks back into the layout', await page.locator('.tile-float').count() === 0);
ok('docked, it does take width from the editor', await editorWidth() < alone - 100);
await page.click('#chat-float');
await page.waitForTimeout(200);
const kept = await box();

// --- the keyboard ---------------------------------------------------------
await page.keyboard.press('Control+Backslash');
await page.waitForTimeout(150);
ok('ctrl/cmd+\\ dismisses it', await page.isHidden('[data-tile="assistant"]'));
await page.keyboard.press('Control+Backslash');
await page.waitForTimeout(150);
ok('ctrl/cmd+\\ summons it', await page.isVisible('[data-tile="assistant"]'));
// Shift is not the same chord: ⇧\ is `|`, and it must not toggle anything.
await page.keyboard.press('Control+Shift+Backslash');
await page.waitForTimeout(150);
ok('ctrl/cmd+shift+\\ leaves it alone', await page.isVisible('[data-tile="assistant"]'));
// The original binding still works.
await page.keyboard.press('Control+j');
await page.waitForTimeout(150);
ok('ctrl/cmd+J dismisses it', await page.isHidden('[data-tile="assistant"]'));
await page.keyboard.press('Control+j');
await page.waitForTimeout(150);
ok('ctrl/cmd+J summons it', await page.isVisible('[data-tile="assistant"]'));
await page.click('#chat-body');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
ok('Escape from inside closes it', await page.isHidden('[data-tile="assistant"]'));
await page.click('#btn-assistant');
await page.waitForTimeout(150);

// --- and it is still there after a reload ---------------------------------
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#topbar:not([hidden])', { timeout: 120000 });
await page.waitForTimeout(400);
const after = await box();
ok('remembers where it was and how big',
   Math.abs(after.x - kept.x) < 3 && Math.abs(after.y - kept.y) < 3 &&
   Math.abs(after.w - kept.w) < 3 && Math.abs(after.h - kept.h) < 3,
   `${JSON.stringify(kept)} -> ${JSON.stringify(after)}`);
ok('remembers the frame', await page.getAttribute('.tile-float', 'data-win-style') === 'clear');
ok('remembers the tint', Number(await page.evaluate(() =>
   document.querySelector('.tile-float').style.getPropertyValue('--win-tint'))) === 0.4);

// --- narrow: there is no workspace to float over, so it is a tile ---------
await page.setViewportSize({ width: 820, height: 900 });
await page.waitForTimeout(350);
ok('a stacked layout un-floats it', await page.evaluate(() =>
   getComputedStyle(document.querySelector('[data-tile="assistant"]')).position) === 'static');
await page.setViewportSize(VIEW);
await page.waitForTimeout(300);
ok('and it floats again once there is room', await page.evaluate(() =>
   getComputedStyle(document.querySelector('[data-tile="assistant"]')).position) === 'fixed');

ok('no page errors', errs.length === 0, JSON.stringify(errs.slice(0, 2)));

await browser.close();
server.close();
console.log('');
if (failed) { console.log(`${failed} check(s) failed.`); process.exit(1); }
console.log('the Claude window behaves like a window.');
