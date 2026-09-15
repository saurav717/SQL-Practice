// Exercises collector/worker.js against a stub D1 binding.
//
// The property this exists to protect is the one in the worker's header
// comment: the logged address comes from the edge connection, never from the
// request body. A refactor that starts trusting the payload would be a silent
// downgrade from "a real address" to "whatever the client typed", and no
// browser test would notice.
import worker from '../collector/worker.js';

const rows = [];
const DB = {
  prepare(sql) {
    const insert = /^INSERT/.test(sql.trim());
    return {
      bind(...args) {
        return {
          async run() {
            if (insert) { rows.push(args); return { meta: { changes: 1 } }; }
            const before = rows.length;              // the retention DELETE
            for (let i = rows.length - 1; i >= 0; i--) if (rows[i][0] < args[0]) rows.splice(i, 1);
            return { meta: { changes: before - rows.length } };
          },
        };
      },
    };
  },
};

const ORIGIN = 'https://saurav717.github.io';
const env = { DB, ALLOWED_ORIGINS: ORIGIN, RETENTION_DAYS: '90' };

// `'origin' in opts` rather than a nullish default: several cases below turn on
// a header being ABSENT, and `??` would quietly put it back.
const req = (opts = {}) => new Request(opts.url || 'https://collector.example/collect', {
  method: opts.method || 'POST',
  headers: {
    ...('origin' in opts ? (opts.origin ? { Origin: opts.origin } : {}) : { Origin: ORIGIN }),
    ...('ip' in opts ? (opts.ip ? { 'CF-Connecting-IP': opts.ip } : {}) : { 'CF-Connecting-IP': '203.0.113.9' }),
    'CF-IPCountry': 'IN',
    'User-Agent': 'Mozilla/5.0 check_collector',
    'content-type': 'application/json',
  },
  ...(['GET', 'OPTIONS'].includes(opts.method) ? {} : {
    body: opts.body ?? JSON.stringify({ deviceId: 'dev-1', path: '/sql-practice/', referrer: '' }),
  }),
});

let failures = 0;
const t = (name, ok) => { if (!ok) { failures++; console.error(`  FAIL ${name}`); } };

// --- a well-formed visit -----------------------------------------------------
let r = await worker.fetch(req(), env);
t('204 on a good POST', r.status === 204);
t('one row written', rows.length === 1);
t('address taken from CF-Connecting-IP', rows[0][1] === '203.0.113.9');
t('country recorded', rows[0][2] === 'IN');
t('device id recorded', rows[0][3] === 'dev-1');
t('CORS echoes the allowed origin', r.headers.get('access-control-allow-origin') === ORIGIN);

// --- a client lying about its own address ------------------------------------
rows.length = 0;
await worker.fetch(req({ body: JSON.stringify({ ip: '1.2.3.4', 'x-forwarded-for': '1.2.3.4' }) }), env);
t('an address in the body is ignored', rows[0][1] === '203.0.113.9');

// --- who may write -----------------------------------------------------------
rows.length = 0;
t('403 for a foreign origin', (await worker.fetch(req({ origin: 'https://evil.example' }), env)).status === 403);
t('no row for a foreign origin', rows.length === 0);
t('403 when Origin is absent', (await worker.fetch(req({ origin: null }), env)).status === 403);
t('403 when no allowlist is set', (await worker.fetch(req(), { DB, ALLOWED_ORIGINS: '' })).status === 403);

// --- routing -----------------------------------------------------------------
r = await worker.fetch(req({ method: 'OPTIONS' }), env);
t('204 on preflight, advertising POST', r.status === 204 && r.headers.get('access-control-allow-methods').includes('POST'));
t('405 on GET', (await worker.fetch(req({ method: 'GET' }), env)).status === 405);
t('404 off-route', (await worker.fetch(req({ url: 'https://collector.example/elsewhere' }), env)).status === 404);

// --- hostile and broken payloads ---------------------------------------------
rows.length = 0;
r = await worker.fetch(req({ body: 'not json at all' }), env);
t('a malformed body still logs the visit', r.status === 204 && rows.length === 1 && rows[0][1] === '203.0.113.9');

rows.length = 0;
await worker.fetch(req({ body: JSON.stringify({ deviceId: 'x'.repeat(5000) }) }), env);
t('an oversized field is clipped', rows[0][3].length === 512);

t('500 when the edge supplies no address', (await worker.fetch(req({ ip: null }), env)).status === 500);

// --- retention ---------------------------------------------------------------
rows.length = 0;
rows.push(['2020-01-01T00:00:00.000Z'], [new Date().toISOString()]);
await worker.scheduled({}, env);
t('the nightly sweep drops only stale rows', rows.length === 1);

if (failures) { console.error(`\n${failures} collector check(s) failed.`); process.exit(1); }
console.log('collector: request handling, origin checks and retention all behave.');
