// Word wrap in the editor: does a long line fold, and does everything that
// sits on top of the text fold with it?
//
// The editor is two layers -- a transparent textarea over a highlighted <pre>
// -- with a line-number gutter beside them. Wrapping is the one setting that
// can put those three out of step: if the layers break in different places
// the colours slide out from under the caret, and if the gutter keeps
// numbering rows instead of lines every number below the first wrap is wrong.
// So this checks alignment, not just that the scrollbar went away.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 8097;
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
const ctx = await browser.newContext({ viewport: VIEW });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#topbar:not([hidden])', { timeout: 120000 });
await page.waitForTimeout(400);

// A single statement far wider than any pane it could be given.
const LONG = 'SELECT customer_id, sum(amount) AS total_spend, count(*) AS txns, '
  + 'min(txn_ts) AS first_seen, max(txn_ts) AS last_seen FROM transactions '
  + 'WHERE status = \'settled\' GROUP BY customer_id ORDER BY total_spend DESC LIMIT 10';

/** What the three layers report about their own size and scroll position. */
const metrics = () => page.evaluate(() => {
  const ta = document.querySelector('#editor');
  const hl = document.querySelector('#editor-highlight');
  const gl = document.querySelector('#editor-gutter-lines');
  return {
    taScrollW: ta.scrollWidth, taClientW: ta.clientWidth,
    taScrollH: ta.scrollHeight, hlScrollH: hl.scrollHeight,
    gutterRows: gl.textContent.replace(/\n$/, '').split('\n').length,
    wrapped: document.querySelector('.editor-wrap').classList.contains('wrapped'),
  };
});

await page.fill('#editor', LONG);
await page.waitForTimeout(200);

// --- off by default: the line runs off the edge --------------------------
{
  const m = await metrics();
  ok('wrap is off until asked for', !m.wrapped);
  ok('off, the toggle reads unpressed',
     await page.getAttribute('#btn-wrap', 'aria-pressed') === 'false');
  ok('off, a long line scrolls sideways', m.taScrollW > m.taClientW + 40,
     `${m.taScrollW} vs ${m.taClientW}`);
}

// --- on: the line folds, and both layers fold the same way ---------------
{
  await page.locator('#btn-wrap').click();
  await page.waitForTimeout(200);
  const m = await metrics();
  ok('on, the toggle reads pressed',
     await page.getAttribute('#btn-wrap', 'aria-pressed') === 'true');
  ok('on, the toggle lights up', await page.evaluate(() =>
     document.querySelector('#btn-wrap').classList.contains('btn-on')));
  ok('on, nothing is left off the right edge', m.taScrollW <= m.taClientW + 1,
     `${m.taScrollW} vs ${m.taClientW}`);
  ok('on, the line took more than one row', m.taScrollH > 40, `${m.taScrollH}px`);
  // The whole point of the overlay: same text, same width, same breaks. A
  // difference of one row here is coloured text sliding under the caret.
  ok('on, the text and the highlight break in the same places',
     Math.abs(m.taScrollH - m.hlScrollH) <= 1, `${m.taScrollH} vs ${m.hlScrollH}`);
}

// --- the gutter still numbers lines, and they line up --------------------
{
  await page.fill('#editor', `-- three lines, the middle one long\n${LONG}\nSELECT 1`);
  await page.locator('#btn-lines').click();   // numbers on
  await page.waitForTimeout(300);

  const g = await page.evaluate(() => {
    const gl = document.querySelector('#editor-gutter-lines');
    const rows = gl.textContent.replace(/\n$/, '').split('\n');
    return { rows, numbers: rows.filter((r) => r.trim()) };
  });
  ok('wrapped, the gutter numbers lines, not rows',
     g.numbers.join(',') === '1,2,3', g.numbers.join(','));
  ok('wrapped, a folded line reserves a blank row for each extra row it took',
     g.rows.length > g.numbers.length, `${g.rows.length} rows, ${g.numbers.length} numbers`);

  // Where each number actually sits, against where its line actually starts.
  // The line's position comes from the browser itself -- a Range around the
  // first character of the last line, measured after the wrap -- so this is
  // not the page's own arithmetic checking itself.
  const aligned = await page.evaluate(() => {
    const ta = document.querySelector('#editor');
    const hl = document.querySelector('#editor-highlight');
    const gl = document.querySelector('#editor-gutter-lines');
    const lh = parseFloat(getComputedStyle(ta).lineHeight);
    const rows = gl.textContent.replace(/\n$/, '').split('\n');
    const lastNumberRow = rows.reduce((acc, r, i) => (r.trim() ? i : acc), 0);

    const target = ta.value.lastIndexOf('\n') + 1;   // start of the last line
    const walk = document.createTreeWalker(hl, NodeFilter.SHOW_TEXT);
    let seen = 0, node, charTop = null;
    while ((node = walk.nextNode())) {
      const len = node.nodeValue.length;
      if (seen + len > target) {
        const r = document.createRange();
        r.setStart(node, target - seen);
        r.setEnd(node, target - seen + 1);
        charTop = r.getBoundingClientRect().top;
        break;
      }
      seen += len;
    }
    return { charTop, numberTop: gl.getBoundingClientRect().top + lastNumberRow * lh };
  });
  ok('wrapped, the last number sits level with the line it belongs to',
     aligned.charTop !== null && Math.abs(aligned.charTop - aligned.numberTop) <= 2,
     `number at ${Math.round(aligned.numberTop)}px, line at ${Math.round(aligned.charTop)}px`);
}

// --- the preference is remembered, and it comes back off again -----------
{
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#topbar:not([hidden])', { timeout: 120000 });
  await page.waitForTimeout(400);
  ok('the setting survives a reload',
     await page.getAttribute('#btn-wrap', 'aria-pressed') === 'true');

  await page.fill('#editor', LONG);
  await page.waitForTimeout(200);
  await page.locator('#btn-wrap').click();
  await page.waitForTimeout(200);
  const m = await metrics();
  ok('off again, the long line scrolls sideways once more',
     !m.wrapped && m.taScrollW > m.taClientW + 40, `${m.taScrollW} vs ${m.taClientW}`);
}

ok('no page errors', errs.length === 0, JSON.stringify(errs.slice(0, 2)));

await browser.close();
server.close();
console.log('');
if (failed) { console.log(`${failed} check(s) failed.`); process.exit(1); }
console.log('the editor wraps, and the gutter and highlight wrap with it.');
