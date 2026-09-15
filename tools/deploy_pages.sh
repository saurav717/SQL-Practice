#!/usr/bin/env bash
# Sync the practice site into the Jekyll Pages repo at <pages>/sql-practice/.
#
# Only the files the HOSTED copy needs are copied. The DuckDB worker and the
# 36 MB wasm binary are NOT copied: the deployed index.html carries
# data-engine-source="cdn", so the browser pulls those from jsDelivr instead.
# That keeps the personal site repo small and the first visit at ~8 MB.
#
# Usage: tools/deploy_pages.sh /path/to/saurav717.github.io
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
PAGES="${1:?usage: deploy_pages.sh /path/to/saurav717.github.io}"
DEST="$PAGES/sql-practice"

[ -f "$PAGES/_config.yml" ] || { echo "error: $PAGES does not look like the Jekyll site"; exit 1; }

rm -rf "$DEST"
mkdir -p "$DEST/assets/css" "$DEST/assets/js" "$DEST/assets/data" "$DEST/engine/duckdb"

cp "$SRC/assets/css/app.css"                        "$DEST/assets/css/"
# Every module, not a hand-kept list: app.js imports its siblings, so one
# missed file 404s the module graph and the page never boots. The guard below
# checks that what got copied actually satisfies every import.
cp "$SRC/assets/js/"*.js                            "$DEST/assets/js/"
cp "$SRC/assets/data/"*.sql                         "$DEST/assets/data/"
cp "$SRC/engine/duckdb/duckdb-browser.bundle.mjs"   "$DEST/engine/duckdb/"
# .txt, not .md: Jekyll processes Markdown, and this is a Jekyll site.
cp "$SRC/engine/duckdb/NOTICE.md"                   "$DEST/engine/duckdb/NOTICE.txt"

# Pin the deployed copy to the CDN so it never looks for files it does not ship.
sed 's|<script type="module" src="assets/js/app.js">|<script type="module" data-engine-source="cdn" src="assets/js/app.js">|' \
    "$SRC/index.html" > "$DEST/index.html"

grep -q 'data-engine-source="cdn"' "$DEST/index.html" \
  || { echo "error: failed to pin the deployed copy to the CDN"; exit 1; }

# Point the deployed copy at the visit collector. The endpoint lives in the
# environment, not in the repo, so a checkout (and `npm run serve`) reports
# nowhere. Unset here means the same for the deployed copy.
if [ -n "${COLLECTOR_ENDPOINT:-}" ]; then
  case "$COLLECTOR_ENDPOINT" in
    https://*) ;;
    *) echo "error: COLLECTOR_ENDPOINT must be an https:// URL"; exit 1 ;;
  esac
  # -i.bak then remove: the bare -i spelling differs between GNU and BSD sed.
  # '|' cannot appear in a URL, so it is safe as the delimiter.
  sed -i.bak "s|<meta name=\"collector-endpoint\" content=\"\">|<meta name=\"collector-endpoint\" content=\"$COLLECTOR_ENDPOINT\">|" \
      "$DEST/index.html"
  rm -f "$DEST/index.html.bak"
  grep -qF "collector-endpoint\" content=\"$COLLECTOR_ENDPOINT" "$DEST/index.html" \
    || { echo "error: failed to inject the collector endpoint"; exit 1; }

  # The disclosure rides with the endpoint, and only with it. A build that
  # reports nowhere must not tell visitors it is logging them, and a build that
  # does must not stay quiet about it -- so the sentence is added here rather
  # than sitting in index.html being wrong half the time.
  retention="${RETENTION_DAYS:-90}"
  sed -i.bak "s|Your queries run here and stay here\.|Your queries run here and stay here; the site records each visit\&#39;s IP address in a private access log, kept ${retention} days.|" \
      "$DEST/index.html"
  rm -f "$DEST/index.html.bak"
  grep -qF "records each visit&#39;s IP address" "$DEST/index.html" \
    || { echo "error: endpoint injected but the disclosure did not apply -- refusing to ship silent logging"; exit 1; }

  echo "collector: $COLLECTOR_ENDPOINT (disclosed in the boot card, ${retention}-day retention)"
else
  echo "collector: none set (COLLECTOR_ENDPOINT unset -- visits will not be logged)"
fi

# Every relative import in the deployed JS must resolve to a file that shipped.
# A missing module is silent at deploy time and fatal in the browser.
missing=0
for js in "$DEST/assets/js/"*.js; do
  while read -r spec; do
    [ -n "$spec" ] || continue
    target="$(cd "$(dirname "$js")" && cd "$(dirname "$spec")" 2>/dev/null && pwd)/$(basename "$spec")"
    [ -f "$target" ] || { echo "error: $(basename "$js") imports $spec, which was not deployed"; missing=1; }
  done < <(grep -oE "from '\\./[^']+'" "$js" | sed "s/from '//; s/'$//")
done
[ "$missing" -eq 0 ] || exit 1

# The directory is called engine/, not vendor/: Jekyll's default exclude list
# contains "vendor", and this is a Jekyll site.
case "$(ls "$DEST")" in *vendor*) echo "error: vendor/ would be dropped by Jekyll"; exit 1;; esac

echo "deployed to $DEST"
du -sh "$DEST"
find "$DEST" -type f | sed "s|$DEST/||" | sort
