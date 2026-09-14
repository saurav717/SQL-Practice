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
echo "== prompts' factual claims still hold =="
node tools/check_claims.mjs
echo "== every Explore recipe runs and returns rows =="
node tools/check_recipes.mjs
echo "== dataset still exhibits the properties the prompts claim =="
node tools/check_dataset.mjs
echo "== both engine sources (vendored + CDN) boot and query =="
node tools/check_engine_source.mjs
echo
echo "All checks passed."
