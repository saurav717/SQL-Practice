# Claude proxy (optional)

The Ask Claude panel works without this. By default it asks each visitor for
their own Anthropic API key, keeps it in their browser, and calls
`api.anthropic.com` directly — the site has no server in the path and the
owner pays nothing.

Deploy this Worker only if you want the opposite arrangement: **you** hold one
API key, visitors hold none, and **you pay for every question anyone asks**.

## What it is

One endpoint that accepts `POST /v1/messages` from an allowlisted origin,
rebuilds the request from a small set of permitted fields, adds your key, and
streams Anthropic's response back. The browser never sees a key.

It is deliberately narrow:

| Guard | Why |
|---|---|
| Origin allowlist, fails closed | An open endpoint on the internet spends your money |
| Model allowlist | Stops a caller asking for something you did not price for |
| `max_tokens` ceiling (16k) | Stops one request billing like a hundred |
| Rate limit (20 per address per 5 min) | Stops a loop |
| Body rebuilt, not forwarded | A pass-through would accept any Messages API field — server tools, containers, a 128k output |

**None of that is a spend limit.** Set one on the key itself, in the Anthropic
console, before you deploy. These guards make abuse slow; a spend limit makes
it bounded.

## Deploy

```bash
cd proxy
wrangler kv namespace create sql-practice-claude-rate   # paste the id into wrangler.toml
wrangler secret put ANTHROPIC_API_KEY                   # the key that pays
wrangler deploy
```

Then point the site at it. The endpoint lives in the environment, not in the
repo, so a checkout and `npm run serve` reach nobody:

```bash
CLAUDE_ENDPOINT=https://sql-practice-claude.<you>.workers.dev \
  tools/deploy_pages.sh /path/to/saurav717.github.io
```

`deploy_pages.sh` writes it into `<meta name="claude-endpoint">` in the
deployed `index.html`. With it set, the panel skips the key card entirely and
`assets/js/assistant.js` points the SDK at the Worker instead.

## Verifying

```bash
node tools/check_proxy.mjs
```

Runs the Worker's request handler directly against a stub upstream and checks
the guards: a disallowed origin is refused, the preflight answers with the
headers the SDK sends, an unknown model and an oversized `max_tokens` are
rejected or clamped, extra body fields are dropped, and a stream is passed
through unbuffered.
