# SQL-Practice

A browser-based SQL practice environment built directly from two documents:
the **pre-onboarding prep guide** (Tier 1, "SQL — analytics-grade, not
interview-grade") and the **rolling windows & timestamp operations** reference.

Reading those queries is not the same as writing them. This runs a real
analytical database in your browser and gives you two ways to use it:

- **Practice** — 61 graded exercises against a toy warehouse shaped to produce
  the exact traps the documents warn about. Your answer is graded by comparing
  your result set against a reference query.
- **Explore** — a free-form editor over the same 24 tables, with no grading, a
  data browser, and 87 ready-to-run recipes covering every class of query the
  warehouse can pose. This is where you go to just poke at the data.

```
git clone git@github.com:saurav717/SQL-Practice.git
cd SQL-Practice
python3 -m http.server 8000      # any static server works
open http://localhost:8000
```

It must be served over `http://`. Opening `index.html` from the filesystem
fails — browsers block WebAssembly and `fetch` on `file://` URLs.

There is no build step, no backend, and no account. Everything runs locally and
nothing leaves your machine. Progress is stored in `localStorage`.

---

## Which SQL engine is this?

**The practice engine is DuckDB** (compiled to WebAssembly, vendored in
`engine/duckdb/`). This deserves an explanation, because it is not one of your
target engines.

Nothing can run Redshift, Athena or Snowflake in a browser — they are cloud
services, not embeddable engines. So the question is which embeddable dialect
sits closest to the ones you will actually type into. DuckDB is Postgres-family,
which is the same family as Redshift (Postgres-derived) and Snowflake, and it is
the only browser-capable engine that supports the constructs these documents
drill:

| Construct from the reference doc | DuckDB | SQLite (rejected) |
|---|---|---|
| `RANGE BETWEEN INTERVAL '7' DAY PRECEDING` | yes | no |
| `IGNORE NULLS` (§4.3 carry-forward) | yes | no |
| `STDDEV_SAMP(...) OVER (...)` | yes | no — "may not be used as a window function" |
| `DATE_TRUNC`, `EXTRACT(ISODOW/EPOCH)` | yes | no |
| IANA time zones with real DST | optional (ICU) | no |
| `QUALIFY`, `ASOF JOIN` | yes | no |
| `GROUPS` frames, `EXCLUDE`, named `WINDOW`, `FILTER` | yes | partial |

DuckDB also reproduces the documents' worked examples exactly — the §1.2
`RANGE`/`ROWS` divergence, the §1.3 default-frame tie behaviour, and the §3.3
`DATEDIFF('year', '2025-12-31', '2026-01-01') = 1` boundary-crossing trap all
come out as written.

Two things keep you honest about the gap between DuckDB and your real warehouse:

**1. A dialect compatibility layer** (`assets/data/compat.sql`). Snowflake and
Redshift spellings are defined as DuckDB macros, so they actually run:

```sql
DATEADD('day', -7, txn_ts)                          -- Snowflake / Redshift
CONVERT_TIMEZONE('UTC', 'America/New_York', ts)     -- Snowflake / Redshift
NVL(x, 0)   IFF(cond, a, b)   ZEROIFNULL(x)   TO_CHAR(d, 'YYYY-MM-DD')
```

`QUALIFY`, `ILIKE`, `TRY_CAST`, `LISTAGG`, `DATEDIFF` and `MEDIAN` are native
and need no shim.

**2. A portability linter.** Pick your target engine in the top bar — Snowflake,
Redshift, Athena/Trino or Spark SQL — and the **Portability** tab flags anything
in your query that will not run there, with the rewrite. It knows, for example,
that `QUALIFY` is Snowflake-only among the four, that Redshift rejects *all*
offsets with `RANGE`, that `FILTER (WHERE ...)` is Trino-only, and that
`generate_series` cannot be joined to user tables on Redshift.

Every exercise additionally carries per-engine notes on the **Dialect notes** tab.

> The prep guide (line 55) says to ask Ayush which engine backs the main tables —
> Redshift, Athena or Spark. Until you know, the linter default is Redshift
> because it is the most restrictive of the four; switch it the moment you find
> out. If the answer turns out to be Snowflake, switch to that and most of the
> warnings disappear, since Snowflake is the closest of the four to DuckDB.

---

## What is covered

61 exercises across nine tracks, each mapped to a section of the source material.

| Track | Source | n |
|---|---|---|
| Joins & the fan-out problem | Prep guide, Tier 1 | 6 |
| NULL semantics | Prep guide, Tier 1 | 4 |
| Window frame mechanics | Windows ref, Part 1 | 6 |
| Rolling aggregation | Windows ref, Part 2 | 8 |
| Timestamp operations | Windows ref, Part 3 | 8 |
| Timestamp analysis patterns | Windows ref, Part 4 | 8 |
| Analytics patterns | Prep guide, Tier 1 | 7 |
| Performance & portability | Windows ref, Parts 5–6 | 4 |
| **Capstone: the ten problems** | **Windows ref, Part 7** | **10** |

The capstone track is Part 7 of the reference, verbatim, mapped onto this
schema. The reference says problems 1, 3, 4 and 6 cover roughly 80% of the
patterns — those four are marked `*core*` in their titles.

Representative traps the exercises make you walk into on purpose:

- A `LEFT JOIN` where `COUNT(*)` returns 1 for an empty group and
  `COUNT(right_col)` returns 0
- `NOT IN` against a subquery containing `NULL`, returning zero rows forever
- A 1:many join inflating an order-level `shipping_fee` by 18,169.46
- The default `RANGE` frame jumping to the batch total across tied timestamps
- `ROWS BETWEEN 6 PRECEDING` silently reaching back more than seven days
  across gaps — 48 rows in Q1 2026 where it differs from the `RANGE` answer
- `LAST_VALUE` returning the current row instead of the partition's last
- SCD Type 2 with `<=` on both ends returning 706 rows instead of 700
- `AVG` skipping missing days instead of treating them as zero

---

## The dataset

A toy payments/commerce warehouse, ~3.3 MB of SQL, 24 tables, deterministic.
Generated by `tools/gen_seed.mjs` from a seeded PRNG — the same seed always
produces the same rows, because grading compares against reference result sets.

Key tables and why each exists:

| Table | Rows | Exists for |
|---|---|---|
| `transactions` | 13,191 | rolling sums, z-scores, velocity fraud, tied timestamps |
| `clickstream` | 5,337 | sessionization (30-min gaps), funnel analysis |
| `logins` | 13,866 | gaps & islands / streaks |
| `balance_snapshots` | 2,403 | as-of (point-in-time correct) joins |
| `daily_revenue` | 574 | frame mechanics — **has 47 missing days and 7 zero days** |
| `dim_customer_scd` | 242 | SCD Type 2, contiguous half-open intervals |
| `bookings` | 459 | overlapping intervals, interval merging |
| `subscriptions` | 108 | daily active counts, win-back spells |
| `orders` / `order_items` | 700 / 2,099 | the fan-out problem |
| `staging_customers` | 116 | deduplication with `ROW_NUMBER` |
| `dim_date` | 1,096 | calendar dimension: ISO vs Sunday weeks, holidays, business days |
| `dim_country` | 15 | reference dimension — **5 countries have no customers at all** |
| `fx_rates` | 4,884 | currency conversion — **weekdays only, so weekends have no rate** |
| `api_events` | 3,797 | LIST and STRUCT columns, raw JSON payload text, error bursts, retry storms |
| `support_tickets` | 640 | messy human free text: embedded order refs, inconsistent casing |

The data is deliberately awkward. Gaps, NULLs, ties, duplicates, orphans, an
empty department, customers who never transacted, and ~14 orders snapped onto
exact SCD version boundaries are all intentional. `assets/data/schema.sql`
documents which exercise depends on which piece of awkwardness — read it before
"cleaning up" anything.

The last four tables exist for Explore mode rather than for any graded
exercise, and carry their own traps: an inner join from `orders` to `fx_rates`
on the order date silently drops **193 of 700 orders**, because markets do not
quote at weekends. Grouping `support_tickets` by its raw `subject` finds 146
topics where there are really 10.

> **On JSON.** `api_events.payload` holds raw JSON as `VARCHAR`, not as a `JSON`
> column, and `tags`/`client` are a real `LIST` and `STRUCT`. That is not
> laziness either: DuckDB's json extension is *loadable*, fetched over the
> network by the wasm build, so a `JSON` column would make the table fail to
> load whenever `extensions.duckdb.org` is unreachable — the same condition
> that already turns time zones off. `LIST` and `STRUCT` are core types and
> always work. Pulling fields out of raw payload text with `regexp_extract` is
> in any case what you end up doing on an engine with no variant type.

No foreign keys are enforced, matching Redshift, Snowflake and Athena, where FK
declarations are informational metadata only.

---

## Using it

| Action | Shortcut |
|---|---|
| Run the query | `⌘/Ctrl + Enter` |
| Check the answer | `⌘/Ctrl + Shift + Enter` |
| Jump to next unsolved | `Alt + →` |
| Toggle Explore mode | `E` (when the editor is not focused) |

Grading compares your **result set** against the reference, not your SQL text —
any correct approach passes. Column *values* must match; column *names* are
advisory (you get a note, not a failure). Exercises that specify an ordering are
compared in order; the rest are compared as sets. Floating-point values are
rounded to 6 decimals first, so `0.1 + 0.2` noise never fails a correct answer.

Failure messages are diagnostic rather than binary — wrong row count tells you
whether a join fanned out or an inner join dropped rows; wrong order tells you
the rows were right.

### Explore mode

**Explore** in the top bar (or press <kbd>E</kbd>) swaps grading for a free-form
editor over all 24 tables. Nothing is checked against anything; the point is to
poke at the data.

| | |
|---|---|
| **Tables** | Every table with its row count. Click one to expand its columns and types; click a column to insert its name at the cursor; **peek** previews the first 100 rows. |
| **Recipes** | 87 runnable queries grouped into 14 categories. Click one to load and run it, then take it apart. Each carries a note saying what to look at in the result. |
| **History** | Your last 60 queries, newest first, deduplicated. Click to load one back into the editor. |

Beyond that, Explore mode differs from practice mode in four ways:

- **`INSERT`, `UPDATE`, `CREATE`, `DROP` and views are all allowed.** **Reset
  data** rebuilds the warehouse from the seed file; your history and exercise
  progress survive it.
- **Multiple statements** separated by `;` run in order, and the grid shows the
  last one that returned rows — so a recipe can build a table and then select
  from it. If one fails, the error names which statement it was.
- **Select part of a query and only the selection runs.** The usual way to try
  one CTE of a long query without deleting the rest.
- **CSV** saves the current result grid to a file.

The portability linter and the schema tab keep working, so a query you draft
here is still checked against your target engine as you type.

The recipe categories, and what each is for:

| Category | n | Covers |
|---|---|---|
| Shape of the data | 6 | row counts, column profiling, `SUMMARIZE`, frequency tables |
| Joins & fan-out | 7 | grain checks, `LEFT JOIN` counting, anti/semi joins, orphan audits |
| NULL semantics | 5 | the `NOT IN` trap, three-valued logic, aggregates skipping NULLs |
| Aggregation & grouping | 6 | `HAVING`, `ROLLUP`, `GROUPING SETS`, `PIVOT`, conditional aggregation |
| Window frames | 7 | `ROWS`/`RANGE`/`GROUPS`, default-frame surprises, `EXCLUDE`, `QUALIFY` |
| Rolling & cumulative | 5 | moving averages, running totals, period-over-period, fill-forward |
| Time & calendars | 7 | truncation, `DATEDIFF` boundary counting, spines, gap filling, time zones |
| Analytics patterns | 11 | gaps & islands, sessionization, funnels, cohorts, SCD, as-of, dedup |
| Text & regex | 6 | normalising messy subjects, extracting order refs, PII sweeps, SLA maths |
| Semi-structured | 8 | `LIST`/`STRUCT` columns, `UNNEST`, payload extraction, retry storms |
| Reference & currency | 5 | star-schema joins, the weekend rate gap, as-of currency conversion |
| Distributions & stats | 6 | percentiles, histograms, deciles, z-scores, correlation, Pareto |
| Writing data | 3 | `CREATE TABLE AS`, `INSERT`/`UPDATE`/`DELETE`, views |
| Introspection & plans | 5 | `EXPLAIN`, `EXPLAIN ANALYZE`, `DESCRIBE`, integrity audits, function search |

Every recipe is executed against the real database on every `npm run check`, so
one that stops working fails the build rather than greeting you broken.

### Optional: full time-zone support

DuckDB keeps the IANA time-zone database in its ICU extension, which the wasm
build fetches from `extensions.duckdb.org` on first use. The site treats this as
optional — it tries once with an 8-second timeout, and if unavailable turns
extension auto-loading off so nothing hangs. The status is shown at the bottom
of the sidebar.

Every exercise works either way. Exercises `ts-4` and `ts-8` deliberately use
the **fixed-offset** approach and then measure its error, which is the actual
lesson of §3.4: a fixed offset (what `'EST'` gives you) misplaces every summer
timestamp by an hour. With ICU loaded, `CONVERT_TIMEZONE` and `AT TIME ZONE`
also work, with correct DST.

---

## Verifying changes

Every reference solution is executed against the real database, and every
factual claim a prompt makes is asserted against the data.

```bash
npm install          # @duckdb/node-api, playwright, esbuild (dev only)
npm run check        # regenerate seed, run all four check suites
npm run check:browser  # end-to-end: boots the real page in Chromium
```

| Script | Checks |
|---|---|
| `tools/check_exercises.mjs` | all 61 solutions parse, run, and return rows |
| `tools/check_recipes.mjs` | all 87 Explore recipes parse, run, and return rows |
| `tools/check_order.mjs` | the grader's `CAST(... AS VARCHAR)` wrapper preserves `ORDER BY` (56/56) |
| `tools/check_claims.mjs` | the traps prompts describe actually occur in the data |
| `tools/check_dataset.mjs` | 42 dataset invariants (gaps, ties, streaks, overlaps, orphans, fx weekend holes, LIST/STRUCT columns, messy text) |
| `tools/browser_test.mjs` | boot, run, grade right/wrong answers, linter, schema, hints, Explore mode (table browser, recipes, multi-statement scripts, history), mobile layout |

Run `npm run check` after touching `assets/js/curriculum.js`,
`assets/js/recipes.js`, `assets/data/schema.sql`, or `tools/gen_seed.mjs`.

> **If you add a table**, add it at the *end* of `tools/gen_seed.mjs`. The
> generator is one continuous seeded PRNG stream, so inserting a table in the
> middle shifts every random draw after it and silently changes the reference
> result set of every exercise downstream.

## Adding an exercise

Append an object to `EXERCISES` in `assets/js/curriculum.js`:

```js
{
  id: 'rolling-9', track: 'rolling', diff: 3,
  title: 'Short imperative title',
  ref: 'Windows ref 2.4',              // where it comes from
  prompt: `Markdown. Name the exact output columns.`,
  hints: ['nudge', 'bigger nudge', 'nearly the answer'],
  ordered: true,                        // compare row order?
  solution: `SELECT ...`,               // the reference result set
  dialect: { snowflake: '...', redshift: '...', trino: '...', spark: '...' },
}
```

Then `npm run check`. A solution that errors or returns zero rows fails the
build, because a broken reference silently breaks grading.

## Adding a recipe

Append an object to `RECIPES` in `assets/js/recipes.js`:

```js
{
  id: 's-newthing', cat: 'semi',        // cat must be one of RECIPE_CATEGORIES
  title: 'Short imperative title',
  note: 'What to LOOK at in the result — not what the syntax means.',
  sql: `SELECT ...`,                    // must run and return rows
}
```

Then `npm run check`. Recipes that demonstrate a trap should show the wrong and
the right answer side by side in one result set, so the difference is visible
without running two queries.

## Layout

```
index.html                    single page
assets/css/app.css            dark/light theme
assets/js/engine.js           DuckDB boot, execution, grading, portability linter
assets/js/sqltext.js          statement splitting, read-only detection, CSV (shared with tools/)
assets/js/curriculum.js       all 61 exercises + tracks + dialect notes
assets/js/recipes.js          all 87 Explore recipes + categories
assets/js/app.js              UI: editor, highlighting, grid, progress, Explore mode
assets/data/schema.sql        24 annotated tables
assets/data/seed.sql          generated, deterministic (3.3 MB)
assets/data/compat.sql        Snowflake/Redshift function shims
assets/data/compat-tz.sql     time-zone shims (loaded only when ICU is available)
tools/                        generator + verification suites
engine/duckdb/                DuckDB-Wasm 1.33.1 (MIT), ~36 MB, ~8 MB over the wire
```

`engine/duckdb/NOTICE.md` records licensing.

## Engine source: vendored vs CDN

The DuckDB wasm binary is ~36 MB on disk but ~8 MB compressed over the wire, so
the source is chosen per environment:

| Where | Source | Why |
|---|---|---|
| `localhost`, `127.0.0.1`, `file://` | `engine/duckdb/` | works with no network at all |
| any real host | jsDelivr | ~8 MB first load instead of ~36 MB |

Override with `?engine=vendor` or `?engine=cdn`, or by putting
`data-engine-source="cdn"` on the module `<script>` tag. The hosted copy at
<https://saurav717.github.io/sql-practice/> sets that attribute, so it never
looks for files it does not ship.

Cross-origin classic workers are not constructible, so the CDN path wraps the
worker in a same-origin blob that `importScripts()` the real one — DuckDB's own
documented pattern. `tools/check_engine_source.mjs` boots all four
combinations.
