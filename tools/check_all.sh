#!/usr/bin/env bash
# Full verification sweep. Run before committing any change to the curriculum,
# the schema, or the generator.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== regenerating seed data =="
node tools/gen_seed.mjs
echo "== every reference solution runs and returns rows =="
node tools/check_exercises.mjs
echo "== grading wrapper preserves ORDER BY =="
node tools/check_order.mjs
echo "== hover-card notes agree with the database =="
node tools/check_schema_notes.mjs
echo "== prompts' factual claims still hold =="
node tools/check_claims.mjs
echo "== dataset still exhibits the properties the prompts claim =="
node tools/check_dataset.mjs
echo "== both engine sources (vendored + CDN) boot and query =="
node tools/check_engine_source.mjs
echo "== visit collector logs the edge address, not the payload =="
node tools/check_collector.mjs
echo "== Claude proxy refuses what it should and forwards only what it must =="
node tools/check_proxy.mjs
echo "== Ask Claude panel streams, renders and sends only what is switched on =="
node tools/check_assistant.mjs
echo "== the Claude window drags, resizes, docks and is where you left it =="
node tools/check_window.mjs
echo
echo "All checks passed."
