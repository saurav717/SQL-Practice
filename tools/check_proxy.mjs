// Exercises proxy/worker.js against a stub upstream.
//
// The point of the Worker is the guards, not the forwarding, so that is what
// this checks: who it refuses, what it strips out of a body, and that a
// stream reaches the caller unbuffered. Nothing here touches the network --
// globalThis.fetch is replaced for the duration.
import worker from '../proxy/worker.js';

const ORIGIN = 'https://saurav717.github.io';
const URL_ = 'https://proxy.example.workers.dev/v1/messages';

let failures = 0;
const ok = (label, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};

// --- stub upstream --------------------------------------------------------
let seen = null;               // the body the Worker sent to Anthropic
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  seen = JSON.parse(init.body);
  if (seen.stream) {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start"}\n\n'));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  return new Response(JSON.stringify({ type: 'message', content: [] }),
                      { status: 200, headers: { 'content-type': 'application/json' } });
};

const env = { ALLOWED_ORIGINS: ORIGIN, ANTHROPIC_API_KEY: 'sk-ant-test' };

const post = (body, { origin = ORIGIN, url = URL_ } = {}) =>
  worker.fetch(new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  }), env);

const MSG = { model: 'claude-opus-5', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }] };

// --- origin ---------------------------------------------------------------
{
  const res = await post(MSG, { origin: 'https://evil.example' });
  ok('a foreign origin is refused', res.status === 403, `got ${res.status}`);
}
{
  const res = await post(MSG, { origin: ORIGIN });
  ok('the allowlisted origin is served', res.status === 200, `got ${res.status}`);
  ok('the response carries that origin back',
     res.headers.get('access-control-allow-origin') === ORIGIN);
}
{
  const res = await worker.fetch(new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
                                 { ...env, ALLOWED_ORIGINS: '' });
  ok('an unconfigured allowlist fails closed', res.status === 403, `got ${res.status}`);
}

// --- preflight ------------------------------------------------------------
{
  const res = await worker.fetch(new Request(URL_, { method: 'OPTIONS', headers: { origin: ORIGIN } }), env);
  const allow = (res.headers.get('access-control-allow-headers') || '').toLowerCase();
  ok('the preflight is answered', res.status === 204, `got ${res.status}`);
  // The SDK sends all four on a browser call; a missing one fails the preflight.
  for (const h of ['content-type', 'anthropic-version', 'x-api-key', 'anthropic-dangerous-direct-browser-access']) {
    ok(`the preflight allows ${h}`, allow.includes(h));
  }
}

// --- the body the Worker builds -------------------------------------------
{
  await post({ ...MSG, max_tokens: 200000 });
  ok('max_tokens is clamped', seen.max_tokens === 16000, `got ${seen.max_tokens}`);
}
{
  const res = await post({ ...MSG, model: 'claude-not-a-model' });
  ok('an unlisted model is refused', res.status === 400, `got ${res.status}`);
}
{
  await post({
    ...MSG,
    // Everything below must be dropped: a pass-through would forward it all.
    tools: [{ type: 'web_search_20260209', name: 'web_search' }],
    container: { skills: [] },
    metadata: { user_id: 'someone' },
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'medium', task_budget: { type: 'tokens', total: 500000 } },
  });
  ok('tools are dropped', seen.tools === undefined);
  ok('container is dropped', seen.container === undefined);
  ok('metadata is dropped', seen.metadata === undefined);
  ok('adaptive thinking is kept', seen.thinking?.type === 'adaptive');
  ok('effort is kept', seen.output_config?.effort === 'medium');
  ok('task_budget is dropped', seen.output_config?.task_budget === undefined);
}
{
  const res = await post({ model: 'claude-opus-5', max_tokens: 10, messages: [] });
  ok('an empty message list is refused', res.status === 400, `got ${res.status}`);
}
{
  const res = await worker.fetch(new Request('https://proxy.example.workers.dev/v1/models', {
    method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(MSG),
  }), env);
  ok('another API path is refused', res.status === 404, `got ${res.status}`);
}
{
  const res = await worker.fetch(new Request(URL_, {
    method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: 'not json',
  }), env);
  ok('a non-JSON body is refused', res.status === 400, `got ${res.status}`);
}

// --- the key never comes back ---------------------------------------------
{
  const res = await post(MSG);
  const headers = JSON.stringify([...res.headers]);
  ok('the API key is not echoed in the response headers', !headers.includes('sk-ant-test'));
}

// --- streaming ------------------------------------------------------------
{
  const res = await post({ ...MSG, stream: true });
  ok('a stream keeps its content type',
     res.headers.get('content-type') === 'text/event-stream',
     `got ${res.headers.get('content-type')}`);
  const text = await res.text();
  ok('the stream body reaches the caller', text.includes('message_start'));
}

// --- rate limiting --------------------------------------------------------
{
  const store = new Map();
  const rated = { ...env, RATE: {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, v); },
  } };
  const call = () => worker.fetch(new Request(URL_, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
    body: JSON.stringify(MSG),
  }), rated);

  let last;
  for (let i = 0; i < 21; i++) last = await call();
  ok('the 21st request in a window is rate limited', last.status === 429, `got ${last.status}`);
  ok('it says when to come back', !!last.headers.get('retry-after'));
}

globalThis.fetch = realFetch;
console.log();
console.log(failures ? `${failures} check(s) failed.` : 'proxy guards hold.');
process.exit(failures ? 1 : 0);
