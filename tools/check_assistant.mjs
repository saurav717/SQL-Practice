// End-to-end check of the Ask Claude panel, against a fake Anthropic.
//
// Nothing here talks to api.anthropic.com -- the page is served with
// <meta name="claude-endpoint"> pointing at this script's own server, which
// answers /v1/messages with a canned SSE stream. That exercises the real
// path: the vendored SDK bundle loads, streams, and the panel renders what
// comes back. It also checks the other half, which is that a build with no
// endpoint and no key asks for a key instead of calling anything.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd(), PORT = 8097, ORIGIN = `http://localhost:${PORT}`;
const T = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.wasm':'application/wasm', '.sql':'text/plain' };

const ANSWER = 'Use a frame, not the default. Here is the running total:\n\n'
  + '```sql\nSELECT txn_id, sum(amount) OVER (ORDER BY txn_id ROWS UNBOUNDED PRECEDING) AS running\nFROM transactions\n```\n\n'
  + 'The default frame is `RANGE`, which ties rows with equal values together.';

/** The Messages API streaming shape, as the SDK expects to parse it. */
function sse(text) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  let out = ev('message_start', { type: 'message_start', message: {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 1 } } });
  out += ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  // Deliberately chopped mid-token: the panel must cope with fences arriving
  // across several deltas, which is what actually happens.
  for (let i = 0; i < text.length; i += 17) {
    out += ev('content_block_delta', { type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: text.slice(i, i + 17) } });
  }
  out += ev('content_block_stop', { type: 'content_block_stop', index: 0 });
  out += ev('message_delta', { type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 64 } });
  out += ev('message_stop', { type: 'message_stop' });
  return out;
}

let lastRequest = null;

const srv = http.createServer((q, r) => {
  const url = decodeURIComponent(q.url.split('?')[0]);

  // The fake API. The SDK appends /v1/messages to the base URL it is given.
  if (url === '/claude/v1/messages') {
    if (q.method === 'OPTIONS') {
      r.writeHead(204, cors(q)); r.end(); return;
    }
    let body = '';
    q.on('data', c => { body += c; });
    q.on('end', () => {
      lastRequest = { headers: q.headers, body: JSON.parse(body) };
      r.writeHead(200, { ...cors(q), 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      r.end(sse(ANSWER));
    });
    return;
  }

  // index.html, with the endpoint injected the way deploy_pages.sh does it.
  if (url === '/wired.html') {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
      .replace('<meta name="claude-endpoint" content="">',
               `<meta name="claude-endpoint" content="${ORIGIN}/claude">`);
    r.writeHead(200, { 'Content-Type': 'text/html' });
    r.end(html);
    return;
  }

  const f = path.join(ROOT, url === '/' ? 'index.html' : url);
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream' });
    r.end(d);
  });
});

const cors = (q) => ({
  'access-control-allow-origin': q.headers.origin || '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, anthropic-version, anthropic-beta, x-api-key, anthropic-dangerous-direct-browser-access',
});

await new Promise(r => srv.listen(PORT, r));

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
let failures = 0;
const ok = (label, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};

async function boot(url) {
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#topbar:not([hidden])', { timeout: 120000 });
  return { p, errs };
}

// --- 1. no endpoint, no key: the panel asks for a key ---------------------
{
  const { p, errs } = await boot(`${ORIGIN}/`);
  ok('the Claude panel starts closed', !(await p.locator('[data-tile="assistant"]').isVisible()));
  await p.click('#btn-assistant');
  await p.waitForSelector('.chat-card', { timeout: 5000 });
  ok('opening it shows the key card', await p.locator('#chat-key-input').isVisible());
  // The card is taller than the panel, so where it opens matters: scrolled to
  // the bottom, the heading saying what the key is for is off-screen.
  ok('the key card opens at its top', await p.evaluate(() => document.querySelector('#chat-body').scrollTop === 0));
  ok('the composer is disabled until there is a key', await p.locator('#chat-input').isDisabled());
  ok('no page errors on the key path', errs.length === 0, JSON.stringify(errs.slice(0, 2)));

  // Closing it gives the editor its width back.
  const wide = await p.locator('#editor').boundingBox();
  await p.click('#btn-assistant');
  const wider = await p.locator('#editor').boundingBox();
  ok('closing it returns the room to the editor', wider.width > wide.width,
     `${wide.width.toFixed(0)} -> ${wider.width.toFixed(0)}`);
  await p.close();
}

// --- 2. endpoint configured: a real streamed round trip -------------------
{
  const { p, errs } = await boot(`${ORIGIN}/wired.html`);
  await p.click('#btn-assistant');
  ok('with an endpoint set there is no key card', !(await p.locator('.chat-card').isVisible()));

  await p.fill('#editor', 'SELECT txn_id, sum(amount) OVER (ORDER BY txn_id) AS running FROM transactions LIMIT 5');
  await p.click('#btn-run');
  await p.waitForSelector('table.grid', { timeout: 30000 });

  await p.fill('#chat-input', 'Why is my running total wrong?');
  await p.press('#chat-input', 'Enter');
  // Wait for the last words of the answer, not for the send button: the
  // button is visible again between turns too, so waiting on it can catch a
  // half-streamed reply.
  await p.waitForFunction(() => document.querySelector('#chat-body')?.innerText.includes('equal values together'),
                          null, { timeout: 30000 });

  const reply = await p.locator('.chat-claude .chat-text').innerText();
  ok('the streamed answer is rendered', reply.includes('Use a frame'));

  // Visibility, not the `hidden` property: an author rule that sets `display`
  // beats the browser's own [hidden] rule, so Stop sat next to Send while
  // every property-level assertion read exactly right.
  ok('Stop is gone once the answer is in', !(await p.locator('#chat-stop').isVisible()));
  ok('Send is back', await p.locator('#chat-send').isVisible());
  ok('its SQL is rendered as a code block', (await p.locator('.chat-claude pre code').count()) === 1);
  ok('the answer keeps its inline code', (await p.locator('.chat-claude .chat-text code').count()) >= 1);

  // What actually went over the wire.
  const sent = lastRequest.body;
  ok('the request streamed', sent.stream === true);
  ok('it asked for the default model', sent.model === 'claude-opus-5', sent.model);
  ok('adaptive thinking was requested', sent.thinking?.type === 'adaptive');
  ok('the browser header is set', lastRequest.headers['anthropic-dangerous-direct-browser-access'] === 'true');
  const first = sent.messages[0].content;
  ok('the schema rode along', first.includes('<schema') && first.includes('transactions'));
  ok('the editor contents rode along', first.includes('<editor>'));
  ok('the last result rode along', first.includes('<last_result>'));
  ok('the exercise rode along', first.includes('<exercise'));
  ok('the question is last', first.trimEnd().endsWith('Why is my running total wrong?'));

  // The Insert button is the reason the answers are worth anything. The
  // editor already holds a draft, so it must ask before overwriting it --
  // if that confirm ever stops appearing, this wait is what notices.
  let asked = false;
  p.on('dialog', d => { asked = true; d.accept(); });
  await p.hover('.chat-claude pre');
  await p.click('.chat-insert');
  await p.waitForFunction(() => document.querySelector('#editor').value.includes('ROWS UNBOUNDED PRECEDING'),
                          null, { timeout: 5000 });
  ok('Insert puts the query in the editor',
     (await p.inputValue('#editor')).includes('ROWS UNBOUNDED PRECEDING'));
  ok('Insert asks before it overwrites a draft', asked);

  // Turning a context switch off must actually drop it from the request.
  await p.click('#chat-gear');
  await p.uncheck('[data-ctx="editor"]');
  await p.uncheck('[data-ctx="schema"]');
  await p.click('#chat-reset');
  await p.fill('#chat-input', 'Second question');
  await p.press('#chat-input', 'Enter');
  await p.waitForFunction(() => document.querySelector('#chat-body')?.innerText.includes('equal values together'),
                          null, { timeout: 30000 });
  const second = lastRequest.body.messages[0].content;
  ok('an unchecked switch drops the editor from the request', !second.includes('<editor>'));
  ok('an unchecked switch drops the schema from the request', !second.includes('<schema'));

  ok('no page errors on the streaming path', errs.length === 0, JSON.stringify(errs.slice(0, 2)));
  await p.close();
}

await b.close();
srv.close();
console.log();
console.log(failures ? `${failures} check(s) failed.` : 'the Claude panel works end to end.');
process.exit(failures ? 1 : 0);
