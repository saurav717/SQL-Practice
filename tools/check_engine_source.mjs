// Exercises BOTH engine-source paths.
//  - vendor mode: plain Worker from a same-origin file
//  - cdn mode:    blob-wrapped Worker importScripts()ing an ABSOLUTE url, which
//                 is the only way a classic worker can come from another origin
// The CDN path is tested against a local absolute base rather than jsDelivr, so
// it runs in CI/offline; the code path taken is identical.
import { chromium } from 'playwright';
import http from 'http'; import fs from 'fs'; import path from 'path';

const ROOT = process.cwd(), PORT = 8095, ORIGIN = `http://localhost:${PORT}`;
const T={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm','.sql':'text/plain'};

const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/tagged.html') {                    // synthetic: index.html + the attribute
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
      .replace('<script type="module" src="assets/js/app.js">',
               '<script type="module" data-engine-source="cdn" src="assets/js/app.js">');
    r.writeHead(200, { 'Content-Type': 'text/html' });
    r.end(html);
    return;
  }
  const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); r.end(); return; }
    let body = d;
    if (u.endsWith('assets/js/engine.js')) {
      // point "the CDN" at this server so the cdn code path is exercisable
      body = Buffer.from(String(d).replace(
        /const CDN_BASE = '[^']*';/,
        `const CDN_BASE = '${ORIGIN}/engine/duckdb/';`));
    }
    r.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream' });
    r.end(body);
  });
});
await new Promise(r => srv.listen(PORT, r));

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
let failures = 0;

async function check(label, url, expectSource) {
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('response', r => { if (r.status() >= 400) errs.push(`${r.status()} ${r.url()}`); });
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#topbar:not([hidden])', { timeout: 120000 });
  await p.fill('#editor', 'SELECT count(*) AS n FROM transactions');
  await p.click('#btn-run');
  await p.waitForSelector('table.grid', { timeout: 30000 });
  const rows = (await p.locator('table.grid tbody tr').first().innerText()).trim();
  const src = await p.evaluate(() => import('./assets/js/engine.js').then(m => m.engineSource));
  const ok = src === expectSource && rows === '13191' && errs.length === 0;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(34)} source=${src} rows=${rows}` +
              (errs.length ? ` errors=${JSON.stringify(errs.slice(0,2))}` : ''));
  await p.close();
}

await check('default on localhost',        `${ORIGIN}/`,                      'vendor');
await check('?engine=cdn (blob worker)',   `${ORIGIN}/?engine=cdn`,           'cdn');
await check('?engine=vendor override',     `${ORIGIN}/?engine=vendor`,        'vendor');
await check('data-engine-source="cdn" tag',`${ORIGIN}/tagged.html`,           'cdn');

await b.close(); srv.close();
console.log(failures ? `\n${failures} failing` : '\nboth engine sources boot and query correctly');
process.exit(failures ? 1 : 0);
