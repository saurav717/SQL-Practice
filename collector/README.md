# Visit collector

A single-endpoint Cloudflare Worker that logs one row per page load into a D1
database. It exists because the practice site is static: it deploys into a
Jekyll Pages repo, GitHub Pages exposes no access logs, and a browser cannot
see its own public address. Without something in the request path, there is
nothing to read an IP from.

Nothing here is published. The rows live in your D1 database, readable only
with your Cloudflare credentials. The site repo never receives visit data —
`assets/js/beacon.js` posts to the endpoint and stores nothing locally.

## What a row holds

| column | source | note |
| --- | --- | --- |
| `at` | server clock | ISO-8601 UTC |
| `ip` | `CF-Connecting-IP` | set by the edge, not forgeable by the client |
| `country` | `CF-IPCountry` | two-letter, `NULL` when unknown |
| `device_id` | request body | the browser-local UUID from `activity.js` |
| `path` | request body | page path |
| `referrer` | request body | `document.referrer`, empty on direct hits |
| `user_agent` | `User-Agent` header | self-reported, treat as a hint |

The address is deliberately taken from the connection rather than the payload.
`X-Forwarded-For` and anything in the body are attacker-controlled; a row built
from those is worth nothing.

## Deploy

```sh
cd collector
npm install -g wrangler        # once
wrangler login

wrangler d1 create sql-practice-visits   # paste the id into wrangler.toml
wrangler d1 execute sql-practice-visits --remote --file=./schema.sql

# Set ALLOWED_ORIGINS in wrangler.toml to the origin the site is served from.
wrangler deploy
```

`wrangler deploy` prints the Worker URL. Point the site at it by exporting the
endpoint before running the deploy script:

```sh
COLLECTOR_ENDPOINT=https://sql-practice-collector.<subdomain>.workers.dev/collect \
  tools/deploy_pages.sh /path/to/saurav717.github.io
```

The endpoint is injected into the deployed `index.html` at that point. It is
**not** stored in this repo, and a local `npm run serve` has no endpoint set, so
development never writes rows.

## Reading the log

```sh
wrangler d1 execute sql-practice-visits --remote \
  --command "SELECT at, ip, country, path FROM visits ORDER BY at DESC LIMIT 50"

# distinct addresses per day
wrangler d1 execute sql-practice-visits --remote \
  --command "SELECT substr(at,1,10) d, COUNT(DISTINCT ip) ips, COUNT(*) hits
             FROM visits GROUP BY d ORDER BY d DESC"
```

## Retention

The cron in `wrangler.toml` runs nightly and deletes rows older than
`RETENTION_DAYS` (90 by default). Lower it if you only need recent traffic —
a shorter window is less to hold and less to lose.

## Things worth knowing

- **The endpoint is public.** The origin allowlist stops a browser on another
  site from posting, but it does not stop `curl`, which can send any `Origin`
  header it likes. Someone who finds the URL can write junk rows. If that
  starts happening, put a Cloudflare rate-limiting rule on the route — the
  free tier covers this.
- **Beacons are best-effort.** Ad blockers, `fetch` failures and closed tabs
  all drop rows silently, by design: `beacon.js` never blocks or retries. Treat
  the numbers as a floor, not a census.
- **An IP is personal data** in the EU/UK and under several US state laws.
  Logging one server-side for operating the site is ordinary and defensible,
  but the usual expectation is a short retention window and a line in a privacy
  notice saying it happens. `index.html` carries that line — see the boot card.
