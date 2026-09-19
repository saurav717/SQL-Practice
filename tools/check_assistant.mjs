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
  const editorAlone = await p.locator('#editor').boundingBox();
  await p.click('#btn-assistant');
  ok('it opens as a window over the workspace',
     await p.locator('[data-tile="assistant"].tile-float').count() === 1);
  await p.waitForSelector('.chat-card', { timeout: 5000 });
  ok('opening it shows the key card', await p.locator('#chat-key-input').isVisible());
  // The card is taller than the panel, so where it opens matters: scrolled to
  // the bottom, the heading saying what the key is for is off-screen.
  ok('the key card opens at its top', await p.evaluate(() => document.querySelector('#chat-body').scrollTop === 0));
  ok('the composer is disabled until there is a key', await p.locator('#chat-input').isDisabled());
  ok('no page errors on the key path', errs.length === 0, JSON.stringify(errs.slice(0, 2)));

  // The panel opens as a window over the workspace, so it takes no room from
  // the editor at all -- that is the point of it. Docked, it is a tile again
  // and the old bargain is back: it costs the editor width, and closing it
  // gives the width back.
  const floated = await p.locator('#editor').boundingBox();
  ok('floating, it costs the editor nothing',
     Math.abs(floated.width - editorAlone.width) < 2,
     `${editorAlone.width.toFixed(0)} -> ${floated.width.toFixed(0)}`);

  await p.click('#chat-float');
  const docked = await p.locator('#editor').boundingBox();
  ok('docked, it takes the room back', docked.width < floated.width - 100,
     `${floated.width.toFixed(0)} -> ${docked.width.toFixed(0)}`);
  await p.click('#btn-assistant');
  const closed = await p.locator('#editor').boundingBox();
  ok('closing it returns the room to the editor', closed.width > docked.width,
     `${docked.width.toFixed(0)} -> ${closed.width.toFixed(0)}`);
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
  ok('the screen rode along', first.includes('<screen>'));
  ok('the schema rode along', first.includes('<schema') && first.includes('transactions'));
  ok('the editor contents rode along', first.includes('<editor '));
  ok('the caret came with it', /<editor [^>]*caret="line \d+, column \d+"/.test(first));
  ok('the results tab rode along', first.includes('<results_tab'));
  // Not just the summary line -- the grid itself, which is what the learner
  // is looking at and the whole reason they no longer have to paste it.
  ok('the rows rode along', first.includes('txn_id') && first.includes('running'));
  ok('the feedback tab rode along', first.includes('<feedback_tab'));
  ok('the portability tab rode along', first.includes('<portability_tab'));
  ok('the recent runs rode along', first.includes('<recent_runs>'));
  ok('the exercise rode along', first.includes('<exercise'));
  ok('the question is last', first.trimEnd().endsWith('Why is my running total wrong?'));
  // The hints and the solution are the learner's to reveal. Nothing has been
  // revealed in this run, so neither may appear.
  ok('an unrevealed hint stays out', !first.includes('<hints_already_revealed'));
  ok('an unrevealed solution stays out', !first.includes('<reference_solution'));

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

  // The screen is re-read for every message, not captured once at the top of
  // the conversation. Run something different, ask a second question, and the
  // block that goes with it must describe the query on screen NOW -- this is
  // the whole point of the panel, and the easiest thing to regress.
  await p.fill('#editor', 'SELECT 42 AS the_answer');
  await p.click('#btn-run');
  await p.waitForSelector('table.grid', { timeout: 30000 });
  await p.fill('#chat-input', 'And now?');
  await p.press('#chat-input', 'Enter');
  await p.waitForFunction(() => (document.querySelectorAll('.chat-claude').length >= 2),
                          null, { timeout: 30000 });
  const msgs = lastRequest.body.messages;
  const latest = msgs[msgs.length - 1].content;
  ok('the second question carries a screen of its own', latest.includes('<screen>'));
  // The editor section specifically, not the whole block: <recent_runs> holds
  // the earlier query on purpose, so "the old text appears somewhere" proves
  // nothing either way.
  const editorBlock = latest.match(/<editor [^>]*>([\s\S]*?)<\/editor>/)?.[1] ?? '';
  ok('and it is the current screen',
     editorBlock.includes('the_answer') && !editorBlock.includes('sum(amount)'),
     editorBlock.trim().slice(0, 60));
  ok('the stale screen is gone from the first turn', !msgs[0].content.includes('<screen>'));
  ok('the first question itself is still there',
     msgs[0].content.includes('Why is my running total wrong?'));

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

// --- 3. history: the chats are still there tomorrow -----------------------
//
// Two conversations, then a reload. The reload is the whole point -- history
// that only lasts as long as the tab is just the thread -- so it happens in
// this page rather than a fresh one: browser.newPage() opens its own context,
// and a new context has nobody's localStorage in it.
{
  const { p, errs } = await boot(`${ORIGIN}/wired.html`);
  p.on('dialog', d => d.accept());
  await p.click('#btn-assistant');

  const answered = (n) => p.waitForFunction(
    (want) => document.querySelectorAll('.chat-claude').length >= want
              && !document.querySelector('.chat-wait'),
    n, { timeout: 30000 });
  const ask = async (q, n) => {
    await p.fill('#chat-input', q);
    await p.press('#chat-input', 'Enter');
    await answered(n);
  };

  await ask('Why is my running total wrong?', 1);
  await ask('And now?', 2);
  await p.click('#chat-reset');
  await ask('Second question', 1);

  await p.goto(`${ORIGIN}/wired.html`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#topbar:not([hidden])', { timeout: 120000 });
  // The panel remembers it was open, so it is usually back on its own.
  if (!(await p.locator('[data-tile="assistant"]').isVisible())) await p.click('#btn-assistant');

  ok('the chats survived the reload',
     Number(await p.locator('#chat-history-count').innerText()) === 2,
     await p.locator('#chat-history-count').innerText());
  ok('the count rides on the History button', await p.locator('#chat-history-count').isVisible());
  ok('the drawer starts closed', !(await p.locator('#chat-history').isVisible()));

  await p.click('#chat-history-btn');
  ok('History opens a drawer', await p.locator('#chat-history').isVisible());
  const titles = await p.locator('.chat-hist-title').allInnerTexts();
  ok('both chats are listed', titles.length === 2, JSON.stringify(titles));
  ok('newest first', titles[0] === 'Second question', titles[0]);
  ok('a chat is named after the question that started it',
     titles[1] === 'Why is my running total wrong?', titles[1]);
  ok('the row says how much is in it',
     (await p.locator('.chat-hist-meta').first().innerText()).startsWith('1 question'),
     await p.locator('.chat-hist-meta').first().innerText());

  // The drawers share one slot: opening ⚙ must put History away, not stack.
  await p.click('#chat-gear');
  ok('⚙ closes History rather than stacking on it',
     await p.locator('#chat-settings').isVisible() && !(await p.locator('#chat-history').isVisible()));
  await p.click('#chat-history-btn');

  // Reopening an old chat is the reason the list exists. By title, not by
  // position: filing a chat promotes it, so the row order moves under you.
  const reopen = (title) => p.locator('.chat-hist-open', { hasText: title }).click();
  await reopen('running total');
  const thread = await p.locator('#chat-body').innerText();
  ok('opening a chat restores the question', thread.includes('Why is my running total wrong?'));
  ok('and the answer that went with it', thread.includes('Use a frame'));
  ok('and the follow-up in the same thread', thread.includes('And now?'));
  ok('the open chat is marked in the list',
     await p.locator('.chat-hist-row.chat-hist-on .chat-hist-title').innerText()
       === 'Why is my running total wrong?');
  // Reopening must not fork a copy: two chats went in, two chats come out.
  ok('reopening does not duplicate the chat',
     (await p.locator('.chat-hist-row').count()) === 2);

  // What is stored is the conversation, not the screen it was asked against:
  // a stale copy of somebody's editor is the one thing not worth keeping.
  const stored = await p.evaluate(() =>
    localStorage.getItem('sqlpractice.assistant.history.v1'));
  ok('the stored chats carry no captured screen', !stored.includes('<screen>'));
  ok('and no API key rode along with them', !/sk-ant-/.test(stored));

  // New chat files the thread rather than dropping it.
  await p.click('#chat-reset');
  ok('New chat empties the thread', await p.locator('.chat-empty').isVisible());
  ok('and keeps both chats in the list', (await p.locator('.chat-hist-row').count()) === 2);

  // Sending from a reopened thread appends to that chat, it does not fork one.
  await reopen('running total');
  await p.fill('#chat-input', 'One more thing');
  await p.press('#chat-input', 'Enter');
  await p.waitForFunction(() => document.querySelectorAll('.chat-claude').length >= 3
                                && !document.querySelector('.chat-wait'),
                          null, { timeout: 30000 });
  ok('a reply to a reopened chat stays in that chat',
     (await p.locator('.chat-hist-row').count()) === 2);
  ok('and promotes it to the top',
     (await p.locator('.chat-hist-title').first().innerText()) === 'Why is my running total wrong?');

  // Deleting. The second row is the chat that is not open, so the thread on
  // screen survives it -- which the assertion after the clear-all checks.
  await p.locator('.chat-hist-del').nth(1).click();
  ok('the ✕ deletes one chat', (await p.locator('.chat-hist-row').count()) === 1);
  ok('the count follows it down',
     (await p.locator('#chat-history-count').innerText()) === '1');
  await p.click('#chat-history-clear');
  ok('Delete all empties the list', (await p.locator('.chat-hist-row').count()) === 0);
  ok('and hides the count', !(await p.locator('#chat-history-count').isVisible()));
  ok('the empty drawer says what the list is for',
     (await p.locator('#chat-history').innerText()).includes('No chats yet'));
  ok('deleting the history does not clear the thread on screen',
     (await p.locator('#chat-body').innerText()).includes('Why is my running total wrong?'));
  ok('and it is gone from storage too',
     await p.evaluate(() => !localStorage.getItem('sqlpractice.assistant.history.v1')));

  ok('no page errors on the history path', errs.length === 0, JSON.stringify(errs.slice(0, 2)));
  await p.close();
}

// --- 4. the Ask Claude button is lit, but quietly -------------------------
//
// The panel is the one thing on the page nobody finds by accident, so the
// button carries a standing highlight. It must not be the Sandbox treatment,
// though: Sandbox announces a mode and is allowed the accent fill, and two
// accent-filled buttons side by side is what "not too distracting" rules out.
{
  const { p } = await boot(`${ORIGIN}/`);
  const style = (sel, prop) => p.evaluate(
    ([s, k]) => getComputedStyle(document.querySelector(s)).getPropertyValue(k), [sel, prop]);

  ok('the button says whether the panel is open',
     await p.getAttribute('#btn-assistant', 'aria-pressed') === 'false');
  ok('it stands out from a plain toolbar button',
     (await style('#btn-assistant', 'box-shadow')) !== 'none'
       && (await style('#btn-sandbox', 'box-shadow')) === 'none');
  ok('it is glass, not a colour fill',
     (await style('#btn-assistant', 'background-image')).includes('rgba(255, 255, 255'),
     await style('#btn-assistant', 'background-image'));

  // The accent fill belongs to Sandbox. Whichever way this button is drawn,
  // it must not be wearing that one -- pressed or not.
  const accentFilled = async () => {
    const img = await style('#btn-assistant', 'background-image');
    const col = await style('#btn-assistant', 'background-color');
    return /rgb\(99, 179, 255\)|rgb\(168, 214, 255\)/.test(`${img} ${col}`);
  };
  ok('closed, it does not wear the accent fill', !(await accentFilled()));

  await p.click('#btn-assistant');
  ok('opening it presses the button',
     await p.getAttribute('#btn-assistant', 'aria-pressed') === 'true');
  ok('open, it still does not wear the accent fill', !(await accentFilled()));
  ok('open, it is not the primary button either',
     !(await p.evaluate(() => document.querySelector('#btn-assistant').classList.contains('btn-primary'))));
  // Not by colour alone: pressed, the button grows the same quiet dot the
  // Sandbox button uses -- minus the pulse.
  ok('open, it shows a state dot',
     await p.evaluate(() => getComputedStyle(document.querySelector('#btn-assistant'), '::before').content !== 'none'));

  await p.click('#btn-assistant');
  ok('closing it releases the button',
     await p.getAttribute('#btn-assistant', 'aria-pressed') === 'false');
  await p.close();
}

await b.close();
srv.close();
console.log();
console.log(failures ? `${failures} check(s) failed.` : 'the Claude panel works end to end.');
process.exit(failures ? 1 : 0);
