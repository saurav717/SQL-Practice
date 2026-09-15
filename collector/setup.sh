#!/usr/bin/env bash
# One-shot Cloudflare setup for the visit collector.
#
# Collapses the steps in README.md into a single run: create the D1 database,
# write its id into wrangler.toml, apply the schema, deploy the Worker, and
# print the endpoint to hand to tools/deploy_pages.sh.
#
# WHAT THIS CANNOT DO FOR YOU: create the Cloudflare account, and log in.
# Signing up means accepting Cloudflare's terms, which only you can do, and
# `wrangler login` opens a browser for OAuth. Do those two things first; this
# script checks for them and stops with instructions if they are missing.
#
# Safe to re-run: an existing database is reused rather than duplicated, and
# the schema uses CREATE TABLE IF NOT EXISTS.
set -euo pipefail
cd "$(dirname "$0")"

DB_NAME="sql-practice-visits"

die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n== %s ==\n' "$1"; }

# --- prerequisites -----------------------------------------------------------
step "checking prerequisites"

if ! command -v wrangler >/dev/null 2>&1; then
  cat >&2 <<'MSG'
wrangler is not installed. Install it, then re-run this script:

    npm install -g wrangler

MSG
  exit 1
fi
echo "wrangler: $(wrangler --version 2>/dev/null | tail -1)"

if ! wrangler whoami >/dev/null 2>&1; then
  cat >&2 <<'MSG'
Not logged in to Cloudflare. You need a (free) account first:

    1. Sign up at https://dash.cloudflare.com/sign-up
    2. Run:  wrangler login      (this opens a browser)
    3. Re-run this script.

MSG
  exit 1
fi
echo "logged in as: $(wrangler whoami 2>/dev/null | grep -oE '[^ ]+@[^ ]+' | head -1 || echo 'ok')"

# --- the database ------------------------------------------------------------
# `d1 create` fails if the database already exists, so ask first and only
# create when it is genuinely absent. That keeps the script re-runnable.
step "database"

db_id=""
if list_json="$(wrangler d1 list --json 2>/dev/null)"; then
  db_id="$(printf '%s' "$list_json" \
    | node -e "
        let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
          try {
            const hit=(JSON.parse(s)||[]).find(d=>d.name===process.argv[1]);
            if (hit) process.stdout.write(hit.uuid||hit.database_id||'');
          } catch {}
        });" "$DB_NAME")"
fi

if [ -n "$db_id" ]; then
  echo "reusing existing database $DB_NAME ($db_id)"
else
  echo "creating $DB_NAME"
  create_out="$(wrangler d1 create "$DB_NAME" 2>&1)" || { echo "$create_out" >&2; die "could not create the database"; }
  # The id is a UUID in the output, whatever prose surrounds it.
  db_id="$(printf '%s' "$create_out" | grep -oiE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
  [ -n "$db_id" ] || { echo "$create_out" >&2; die "created the database but could not find its id in the output -- paste it into wrangler.toml by hand"; }
  echo "created ($db_id)"
fi

# --- wire the id into wrangler.toml ------------------------------------------
step "wrangler.toml"

if grep -q "database_id = \"$db_id\"" wrangler.toml; then
  echo "already points at $db_id"
else
  # -i.bak then remove: the bare -i spelling differs between GNU and BSD sed.
  sed -i.bak -E "s|^database_id = \".*\"|database_id = \"$db_id\"|" wrangler.toml
  rm -f wrangler.toml.bak
  grep -q "database_id = \"$db_id\"" wrangler.toml || die "failed to write the database id into wrangler.toml"
  echo "database_id set to $db_id"
fi

# --- schema and deploy -------------------------------------------------------
step "applying schema"
wrangler d1 execute "$DB_NAME" --remote --file=./schema.sql --yes >/dev/null
echo "visits table and indexes are in place"

step "deploying the worker"
deploy_out="$(wrangler deploy 2>&1)" || { echo "$deploy_out" >&2; die "deploy failed"; }
echo "$deploy_out" | tail -5

worker_url="$(printf '%s' "$deploy_out" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)"
[ -n "$worker_url" ] || {
  echo
  echo "Deployed, but the URL was not in the output above. Find it in the Cloudflare"
  echo "dashboard under Workers & Pages, and append /collect to it."
  exit 0
}

endpoint="$worker_url/collect"

# --- what to do next ---------------------------------------------------------
cat <<NEXT

== done ==

Collector endpoint:

    $endpoint

Nothing is being logged yet -- the site still has to be pointed at it. From the
repo root, with the path to your Pages checkout:

    COLLECTOR_ENDPOINT=$endpoint \\
      tools/deploy_pages.sh /path/to/saurav717.github.io

That fills in the endpoint AND adds the disclosure sentence to the boot card.
Commit and push the Pages repo afterwards, and logging is live.

Then read the log with:

    wrangler d1 execute $DB_NAME --remote \\
      --command "SELECT at, ip, country, path FROM visits ORDER BY at DESC LIMIT 50"

NEXT
