// ===========================================================================
//  Claude proxy.
//
//  Optional. Without it the Ask Claude panel asks each visitor for their own
//  Anthropic API key and calls api.anthropic.com straight from the browser --
//  which is fine, and costs the site's owner nothing. This Worker is for the
//  other arrangement: the owner holds one key here, visitors hold none, and
//  the owner pays for what visitors ask.
//
//  DEPLOY THIS ONLY IF YOU MEAN TO PAY FOR STRANGERS' QUESTIONS. It is an
//  open endpoint spending your money. The guards below are the bare minimum
//  that makes that survivable -- an origin allowlist, a per-address rate
//  limit, a model allowlist and a token ceiling -- and they are not a
//  substitute for a spend limit set on the API key itself in the Anthropic
//  console. Set one.
//
//  See proxy/README.md.
// ===========================================================================

/** Only these models may be requested, whatever the browser asks for. */
const MODELS = new Set(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);

/** Hard ceiling on max_tokens, whatever the browser asks for. */
const MAX_TOKENS = 16000;

/** Requests per address per window. Tuned for a person typing, not a script. */
const RATE_LIMIT = 20;
const RATE_WINDOW_S = 300;

const json = (body, status, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** The shape the SDK already knows how to report, so errors read properly. */
const apiError = (status, message, headers = {}) =>
  json({ type: 'error', error: { type: 'invalid_request_error', message } }, status, headers);

function corsFor(request, env) {
  const origin = request.headers.get('Origin');
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  // No allowlist configured: fail closed rather than proxy for anyone.
  if (!list.length || !origin || !list.includes(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    // The SDK sends these on every call; anthropic-version and the browser
    // header in particular, or the preflight fails.
    'access-control-allow-headers': 'content-type, anthropic-version, anthropic-beta, x-api-key, anthropic-dangerous-direct-browser-access',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

/**
 * Fixed-window counter in KV, keyed by the edge-supplied address. Not exact
 * under concurrency -- two requests can read the same count -- and it does
 * not need to be: it is here to stop a loop, not to bill anyone.
 */
async function overLimit(env, ip) {
  if (!env.RATE) return false;                 // no KV bound: no limiting
  const bucket = Math.floor(Date.now() / 1000 / RATE_WINDOW_S);
  const key = `rl:${bucket}:${ip}`;
  const n = Number(await env.RATE.get(key)) || 0;
  if (n >= RATE_LIMIT) return true;
  await env.RATE.put(key, String(n + 1), { expirationTtl: RATE_WINDOW_S * 2 });
  return false;
}

/**
 * Rebuild the request body from scratch rather than forwarding what arrived.
 * A pass-through would let a caller set any field the Messages API accepts --
 * a 128k max_tokens, a model that is not on the list, a container, a server
 * tool that fetches URLs. Only these fields survive.
 */
function sanitize(body) {
  if (!body || typeof body !== 'object') return { error: 'Body must be a JSON object.' };
  if (!MODELS.has(body.model)) return { error: `Model ${body.model} is not available here.` };
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return { error: 'messages must be a non-empty array.' };
  }
  const out = {
    model: body.model,
    max_tokens: Math.min(Number(body.max_tokens) || 4096, MAX_TOKENS),
    messages: body.messages,
    stream: body.stream === true,
  };
  if (typeof body.system === 'string') out.system = body.system;
  if (body.thinking?.type === 'adaptive') out.thinking = body.thinking;
  if (body.output_config?.effort) out.output_config = { effort: body.output_config.effort };
  return { out };
}

export default {
  async fetch(request, env) {
    const cors = corsFor(request, env);
    if (request.method === 'OPTIONS') {
      return cors ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 403 });
    }
    if (!cors) return apiError(403, 'This endpoint does not serve that origin.');
    if (request.method !== 'POST') return apiError(405, 'POST only.', cors);

    // The SDK appends the path to the base URL, so it arrives as /v1/messages.
    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    if (!path.endsWith('/v1/messages')) return apiError(404, 'No such endpoint.', cors);

    if (!env.ANTHROPIC_API_KEY) return apiError(500, 'This endpoint has no API key configured.', cors);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (await overLimit(env, ip)) {
      return apiError(429, 'Too many questions from this address just now. Try again in a few minutes.',
                      { ...cors, 'retry-after': String(RATE_WINDOW_S) });
    }

    let parsed;
    try { parsed = sanitize(await request.json()); }
    catch { return apiError(400, 'Body was not valid JSON.', cors); }
    if (parsed.error) return apiError(400, parsed.error, cors);

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': request.headers.get('anthropic-version') || '2023-06-01',
      },
      body: JSON.stringify(parsed.out),
    });

    // Streamed straight through: the panel renders tokens as they arrive, and
    // buffering the whole answer here would throw that away.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...cors,
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      },
    });
  },
};
