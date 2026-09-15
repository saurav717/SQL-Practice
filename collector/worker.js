// ===========================================================================
//  Visit collector.
//
//  The practice site is static -- it deploys into a Jekyll Pages repo and has
//  no server, so nothing in the request path ever sees a client address. This
//  Worker is that missing piece: one endpoint, one job, which is to write a
//  row per page load into D1.
//
//  THE ADDRESS IS READ FROM THE CONNECTION, NOT FROM THE BODY. A browser does
//  not know its own public IP, and any address a client volunteers -- in a
//  field, in X-Forwarded-For -- is attacker-controlled. CF-Connecting-IP is
//  set by the edge after the TCP handshake and cannot be forged by the client.
//
//  Deploy notes and the retention story are in collector/README.md.
// ===========================================================================

/** Rows older than this are deleted by the scheduled handler. */
const DEFAULT_RETENTION_DAYS = 90;

/** Bound so a hostile client cannot write megabytes into a column. */
const MAX_FIELD_CHARS = 512;

const json = (body, status, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Origins allowed to POST, from the ALLOWED_ORIGINS var (comma-separated). */
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * CORS headers for an allowed origin, or null when the origin is not on the
 * list. Returning null is what makes the endpoint refuse the request: without
 * an Access-Control-Allow-Origin the browser discards the response anyway, so
 * we may as well reject it outright and not write the row.
 */
function corsFor(request, env) {
  const origin = request.headers.get('Origin');
  const list = allowedOrigins(env);
  // No allowlist configured: fail closed rather than collect for anyone.
  if (!list.length) return null;
  if (!origin || !list.includes(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

const clip = (v) =>
  v === null || v === undefined ? null : String(v).slice(0, MAX_FIELD_CHARS);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/collect') return json({ error: 'not found' }, 404);

    const cors = corsFor(request, env);
    if (!cors) return json({ error: 'origin not allowed' }, 403);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors);

    let body = {};
    try {
      body = await request.json();
      if (!body || typeof body !== 'object') body = {};
    } catch {
      // A malformed body still represents a real visit from a real address,
      // so log the row and drop the payload rather than losing the visit.
      body = {};
    }

    // The two fields that matter come from the edge, not the payload.
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return json({ error: 'no client address' }, 500, cors);

    try {
      await env.DB.prepare(
        `INSERT INTO visits (at, ip, country, device_id, path, referrer, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        new Date().toISOString(),
        ip,
        request.headers.get('CF-IPCountry') || null,
        clip(body.deviceId),
        clip(body.path),
        clip(body.referrer),
        clip(request.headers.get('User-Agent')),
      ).run();
    } catch (e) {
      // Never surface the database error to the page: it is the caller's
      // problem to see a 500, not to learn the schema.
      console.error('insert failed:', e.message);
      return json({ error: 'write failed' }, 500, cors);
    }

    return new Response(null, { status: 204, headers: cors });
  },

  /**
   * Retention. Wired to a cron in wrangler.toml -- without it the table grows
   * without bound and the log outlives any reason to hold it.
   */
  async scheduled(event, env) {
    const days = Number(env.RETENTION_DAYS) || DEFAULT_RETENTION_DAYS;
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    const { meta } = await env.DB.prepare('DELETE FROM visits WHERE at < ?').bind(cutoff).run();
    console.log(`pruned ${meta?.changes ?? 0} rows older than ${days}d`);
  },
};
