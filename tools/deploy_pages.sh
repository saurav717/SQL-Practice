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
cp "$SRC/assets/js/app.js"                          "$DEST/assets/js/"
cp "$SRC/assets/js/engine.js"                       "$DEST/assets/js/"
cp "$SRC/assets/js/curriculum.js"                   "$DEST/assets/js/"
cp "$SRC/assets/data/"*.sql                         "$DEST/assets/data/"
cp "$SRC/engine/duckdb/duckdb-browser.bundle.mjs"   "$DEST/engine/duckdb/"
cp "$SRC/engine/duckdb/NOTICE.md"                   "$DEST/engine/duckdb/"

# Pin the deployed copy to the CDN so it never looks for files it does not ship.
sed 's|<script type="module" src="assets/js/app.js">|<script type="module" data-engine-source="cdn" src="assets/js/app.js">|' \
    "$SRC/index.html" > "$DEST/index.html"

grep -q 'data-engine-source="cdn"' "$DEST/index.html" \
  || { echo "error: failed to pin the deployed copy to the CDN"; exit 1; }

# The directory is called engine/, not vendor/: Jekyll's default exclude list
# contains "vendor", and this is a Jekyll site.
case "$(ls "$DEST")" in *vendor*) echo "error: vendor/ would be dropped by Jekyll"; exit 1;; esac

echo "deployed to $DEST"
du -sh "$DEST"
find "$DEST" -type f | sed "s|$DEST/||" | sort
