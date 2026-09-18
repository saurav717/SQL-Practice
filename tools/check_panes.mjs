// Every pane, and whether it actually does what its frame promises.
//
// check_window covers the Claude panel once it has been lifted into a window
// of its own. This covers the other half: the tiles still in the layout, the
// seams between them, and the expand control that gives one tile the whole
// workspace.
//
// The question it exists to answer is the one that is easy to get wrong by
// hand -- "can I make THIS pane bigger?" -- for each pane in turn, in the
// tiled layout and in the stacked one, with the Claude window both out of the
// way and sitting over the top.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 8096;
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
await page.waitForTimeout(400);

const PANES = ['sidebar', 'prompt', 'editor', 'output'];

/** Every tile's rectangle, with a tile taking no room reported as null. */
const boxes = () => page.evaluate(() =>
  Object.fromEntries(['sidebar', 'prompt', 'editor', 'output', 'assistant'].map((n) => {
    const r = document.querySelector(`[data-tile="${n}"]`).getBoundingClientRect();
    return [n, r.width < 2 || r.height < 2
      ? null
      : { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }];
  })));

/** Drag a seam by (dx, dy) from its middle. */
async function dragSeam(id, dx, dy) {
  const s = await page.locator(`#${id}`).boundingBox();
  if (!s) return false;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 + dx, s.y + s.height / 2 + dy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  return true;
}

// --- every pane is on screen to begin with --------------------------------
{
  const b = await boxes();
  ok('the four tiles all have room', PANES.every((p) => b[p] && b[p].w > 100 && b[p].h > 40),
     JSON.stringify(b));
}

// --- every seam resizes the tile it names ---------------------------------
//
// The seam ids follow the tile each one actually resizes, so a seam that
// stopped moving its own tile is the bug this is looking for.
for (const [id, axis, by] of [['split-sidebar', 'w', 120], ['split-prompt', 'h', 80],
                              ['split-editor', 'h', -110]]) {
  const pane = id.replace('split-', '');
  const before = (await boxes())[pane];
  await dragSeam(id, axis === 'w' ? by : 0, axis === 'w' ? 0 : by);
  const after = (await boxes())[pane];
  ok(`${id} resizes ${pane}`, Math.abs((after[axis] - before[axis]) - by) < 14,
     `${before[axis]} -> ${after[axis]} (wanted ${before[axis] + by})`);
}

// Dragging the editor's seam up is how the results pane grows: it is the
// elastic tile, so it takes whatever the editor gives back.
{
  // From a clean layout: the seam checks above already pushed the editor most
  // of the way to its floor, and a tile at its floor has nothing left to give.
  await page.click('#btn-reset-layout');
  await page.waitForTimeout(250);
  const before = (await boxes()).output;
  await dragSeam('split-editor', 0, -120);
  const after = (await boxes()).output;
  ok('the results pane grows when the editor gives room back',
     after.h > before.h + 100, `${before.h} -> ${after.h}`);
  await page.click('#btn-reset-layout');
  await page.waitForTimeout(200);
}

// --- expand gives one tile the whole workspace ----------------------------
//
// The editor has a floor, so dragging alone can only make the results pane so
// tall. Expand is the answer to "I want to read this one thing": every tile
// has the control, it is not hidden behind a hover, and it comes back.
const host = await page.locator('#layout').boundingBox();
for (const pane of PANES) {
  ok(`${pane} has an expand control you can see without hovering`,
     await page.isVisible(`[data-tile="${pane}"] [data-zoom]`));

  await page.locator(`[data-tile="${pane}"] [data-zoom]`).dispatchEvent('click');
  await page.waitForTimeout(200);
  const b = await boxes();
  ok(`${pane} expands to fill the workspace`,
     b[pane] && b[pane].w > host.width - 24 && b[pane].h > host.height - 24,
     JSON.stringify(b[pane]));
  ok(`nothing else is in the way while ${pane} is expanded`,
     PANES.filter((o) => o !== pane).every((o) => b[o] === null));

  await page.locator(`[data-tile="${pane}"] [data-zoom]`).dispatchEvent('click');
  await page.waitForTimeout(200);
  const back = await boxes();
  ok(`the layout comes back when ${pane} is put down`,
     PANES.every((o) => back[o] !== null), JSON.stringify(back));
}

// The sizes you set by hand must survive a round trip through expand.
{
  await dragSeam('split-sidebar', 90, 0);
  const before = (await boxes()).sidebar;
  await page.locator('[data-tile="output"] [data-zoom]').dispatchEvent('click');
  await page.waitForTimeout(180);
  await page.locator('[data-tile="output"] [data-zoom]').dispatchEvent('click');
  await page.waitForTimeout(180);
  const after = (await boxes()).sidebar;
  ok('expanding and coming back keeps the sizes you set',
     Math.abs(after.w - before.w) < 3, `${before.w} -> ${after.w}`);
}

// Escape hands the workspace back, so an expanded pane is never a trap.
{
  await page.locator('[data-tile="output"] [data-zoom]').dispatchEvent('click');
  await page.waitForTimeout(180);
  await page.locator('#layout').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  ok('Escape gives the workspace back', (await boxes()).editor !== null);
}

// --- the Claude window is not swallowed by an expanded tile ---------------
//
// It is a window over the workspace, not a tile in it, so expanding a tile
// must leave it exactly where it was -- including when it lives in a branch
// of the tree that expanding hides entirely.
{
  await page.click('#btn-assistant');
  await page.waitForTimeout(250);
  const before = (await boxes()).assistant;
  await page.locator('[data-tile="output"] [data-zoom]').dispatchEvent('click');
  await page.waitForTimeout(220);
  const b = await boxes();
  ok('the Claude window survives an expanded tile', b.assistant !== null,
     JSON.stringify(b.assistant));
  ok('and it has not moved', JSON.stringify(b.assistant) === JSON.stringify(before),
     `${JSON.stringify(before)} -> ${JSON.stringify(b.assistant)}`);
  ok('the tile underneath still got the whole workspace',
     b.output.h > host.height - 24, JSON.stringify(b.output));
  ok('a floating window has no expand control of its own',
     !(await page.isVisible('[data-tile="assistant"] [data-zoom]')));
  await page.locator('[data-tile="output"] [data-zoom]').dispatchEvent('click');
  await page.waitForTimeout(200);
}

// --- stacked: no seams, so expand is the only way ------------------------
{
  await page.setViewportSize({ width: 860, height: 900 });
  await page.waitForTimeout(400);
  ok('stacked, the expand control is still there',
     await page.isVisible('[data-tile="output"] [data-zoom]'));
  await page.locator('[data-tile="output"] [data-zoom]').dispatchEvent('click');
  await page.waitForTimeout(300);
  const b = await boxes();
  ok('stacked, expanding hides the other tiles',
     PANES.filter((p) => p !== 'output').every((p) => b[p] === null), JSON.stringify(b));
  ok('stacked, the Claude panel is a tile and hides with the rest',
     b.assistant === null);
  await page.locator('[data-tile="output"] [data-zoom]').dispatchEvent('click');
  await page.waitForTimeout(300);
  const back = await boxes();
  ok('stacked, every tile comes back',
     [...PANES, 'assistant'].every((p) => back[p] !== null), JSON.stringify(back));
  await page.setViewportSize(VIEW);
  await page.waitForTimeout(300);
}

ok('no page errors', errs.length === 0, JSON.stringify(errs.slice(0, 2)));

await browser.close();
server.close();
console.log('');
if (failed) { console.log(`${failed} check(s) failed.`); process.exit(1); }
console.log('every pane resizes, expands and comes back.');
