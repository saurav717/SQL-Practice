# SQL-Practice

A browser-based SQL practice environment built directly from two documents:
the **pre-onboarding prep guide** (Tier 1, "SQL — analytics-grade, not
interview-grade") and the **rolling windows & timestamp operations** reference.

Reading those queries is not the same as writing them. This runs a real
analytical database in your browser, hands you 61 exercises against a toy
warehouse shaped to produce the exact traps the documents warn about, and
grades your answer by comparing your result set against a reference query.

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

A toy payments/commerce warehouse, ~2.2 MB of SQL, 20 tables, deterministic.
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

The data is deliberately awkward. Gaps, NULLs, ties, duplicates, orphans, an
empty department, customers who never transacted, and ~14 orders snapped onto
exact SCD version boundaries are all intentional. `assets/data/schema.sql`
documents which exercise depends on which piece of awkwardness — read it before
"cleaning up" anything.

No foreign keys are enforced, matching Redshift, Snowflake and Athena, where FK
declarations are informational metadata only.

---

## Using it

| Action | Shortcut |
|---|---|
| Run the statement at the cursor | `⌘/Ctrl + Enter` |
| Run every statement in the editor | `⌘/Ctrl + Alt + Enter` |
| Check the answer | `⌘/Ctrl + Shift + Enter` |
| Comment / uncomment the selected lines | `⌘/Ctrl + /` |
| Indent the lines the selection touches | `Tab` |
| Dedent them again | `Shift + Tab` |
| Undo / redo | `⌘/Ctrl + Z`, `⌘⇧Z / Ctrl + Y` |
| Next exercise | `⌘/Ctrl + Alt + ↓` |
| Previous exercise | `⌘/Ctrl + Alt + ↑` |
| Resize a focused seam | `←/→` or `↑/↓` (`Home`/`End`) |
| Move a focused results tab | `Shift + ←/→` |
| Move the Claude window | `⌘/Ctrl + ←↑→↓` (hold to keep going) |
| Throw it at an edge | `⌘/Ctrl + Shift + ←↑→↓` |

**Run acts on one statement**, the way a Snowflake worksheet does: the one the
cursor is sitting in. Keep scratch work above your answer, separated by `;`, and
only the statement you are pointing at runs — it is highlighted in the editor,
and the toolbar says which one `⌘↵` will take. Select a fragment and Run takes
the selection instead. **Check answer** grades the same statement, so parked
scratch work is never submitted along with it. **Run all** executes the whole
editor top to bottom, stopping at the first error.

Statement boundaries are found by lexing, not by splitting on `;` — a semicolon
inside a string, a quoted identifier, a comment or a `$$` body is just text.

Exercise navigation is `⌘⌥↑`/`⌘⌥↓`, vertical like the sidebar it walks. It is
deliberately not `⌥←`/`⌥→`: those move the caret one word at a time in the
editor on macOS, and a page-level shortcut on them makes the editor unusable.
After a correct answer, the Feedback tab also offers the next unsolved
exercise as a button.

`Tab` indents every line the selection touches and `⇧Tab` takes a level back
off; with nothing selected it inserts two spaces at the caret. It never replaces
the selection, so tabbing a selected block cannot swallow it.

Every edit the page makes to the editor — `Tab`, `⌘/`, and clicking a column in
the Schema browser — goes in through the browser's own insert path rather than
by assigning to `value`, which is what keeps `⌘Z` able to undo it.

`⌘/` comments the selected lines with `--`, and uncomments them when they are
all already commented. The marker goes at the block's shallowest indent, so the
shape of the query survives the round trip.

Grading compares your **result set** against the reference, not your SQL text —
any correct approach passes. Column *values* must match; column *names* are
advisory (you get a note, not a failure). Exercises that specify an ordering are
compared in order; the rest are compared as sets. Floating-point values are
rounded to 6 decimals first, so `0.1 + 0.2` noise never fails a correct answer.

Column **order** is advisory too. Rows are compared position by position, so a
right answer whose `SELECT` list is in a different order used to come back as
*Wrong values*. When your columns turn out to be a reordering of the expected
ones — same data, different slots — it grades as **Correct**, with an amber note
naming both orders and the reordering that matches the brief. The exercise
counts as solved; the note is there because column order is part of the output
contract everywhere else.

Failure messages are diagnostic rather than binary — wrong row count tells you
whether a join fanned out or an inner join dropped rows; wrong order tells you
the rows were right.

**Sandbox** (top bar) gives you a free-form editor where `INSERT`/`UPDATE`/`DDL`
are allowed. It is a mode, not an action, so the button stays lit — filled,
ringed, and carrying a live dot — for as long as you are in it, and goes dark
the moment you leave, including by picking an exercise from the list. **Reset
data** reloads the dataset from scratch. **⊞** puts the panels and tabs back to
their starting arrangement.

### Which tables, and what is in them

Every exercise carries a **Tables** strip under its title naming the tables the
question is about, and every table name inside the prompt text and the hints is
a trigger too. Hover one — or focus it and press `Enter`, or tap it on a touch
screen — and a card opens with:

* one line on what the table is for and where its trap is,
* every column with its type, `PK` and `null` markers,
* the join key each foreign column points at (`customer_id → customers.customer_id`),
* the note from `schema.sql`, where that column has one.

`Esc` closes the card; clicking pins it open so you can read down a long column
list. Which tables an exercise uses is *derived* — from the identifiers its
prompt marks as code and the ones its reference solution names — so it can
never go stale against the exercise.

The card's content comes from three places, deliberately kept apart
(`assets/js/schema-doc.js` explains why): column names, types and row counts are
read from the live database, the per-column notes are parsed out of
`assets/data/schema.sql`, and the one-line table purposes are prose in
`schema-doc.js`. `tools/check_schema_notes.mjs` fails the build if the three
stop agreeing — a card naming a column the warehouse does not have is worse than
no card at all.

### Rearranging the panels

The window is five tiles — **Exercises**, **Exercise**, **Editor**,
**Results** and **Ask Claude** — and you decide where each one goes. Claude
starts closed, and opens as a floating window rather than a fifth tile (see
[Ask Claude](#ask-claude)), so the other four never notice it either way; dock
it with **⊟** and it joins the tree like anything else. Every tile carries a thin bar with a
grip on the left:

* **Drag the bar** and drop the tile against the **left, right, top or bottom**
  edge of any other tile: it splits that tile and takes half. Drop it in the
  **middle** of another tile instead and the two swap places. Drop it against an
  edge of the *window* and it becomes a full-height column or full-width row.
  The outline and the label under the pointer show what the drop will do before
  you commit to it; `Esc` calls it off.
* **Four arrow buttons** appear on the bar on hover, and send the tile straight
  to the left, top, bottom or right edge of the window. They are the keyboard
  path to the same thing — no pointer required.
* **⊞ in the top bar** puts every tile and every tab back where it started.

Stack the editor beside the results grid, park the exercise list on the right,
put the prompt along the bottom — whatever you arrange survives a reload,
because the arrangement is stored per browser.

The tabs in the results panel rearrange too: **drag a tab sideways** to move it,
or focus one and use `Shift + ←/→`. Dragging a tab reorders it without switching
to it.

### Resizing the panels

Every seam between two tiles is a drag handle. Drag to resize, **double-click to
reset that seam**, or focus one and use the arrow keys (`Home`/`End` for the
extremes). Sizes are in pixels and are remembered per browser, so the editor does
not re-scale every time the window changes height. Each tile has a floor that a
drag cannot push past, so nothing can be collapsed to nothing — and in every
split, the tile holding the results grid is the elastic one, so a window resize
lands there instead of re-shuffling everything you set. (A docked Claude panel is
never the elastic one: it sits at the end of the row it shares with the editor,
and a wider window should widen the editor, not the side panel.) Below 1000px wide the
tiles stack and size themselves, and the handles go away.

### Ask Claude

**Ask Claude** in the top bar — or `⌘\` / `Ctrl+\` from anywhere — opens a
chat **window** over the workspace. Not a panel: it floats, so the editor and
the results keep their full width, and it is translucent, so the query you are
asking about stays readable underneath it. `Esc` puts it away, and `⌘J` still
toggles it too: that was the first binding and some fingers know it. Ask why a window
frame is off, what `QUALIFY` does, or what is wrong with the query you have
open.

Move it by dragging its title bar, resize it from any edge or corner, and
double-click the title bar to send it back to its column — double-click again
and it fills the workspace. Where you leave it, how big, how transparent and
which frame it wears are all remembered per browser.

From the keyboard, `⌘/Ctrl + an arrow` **moves** it that way — a tap shifts it
a little, holding the key flies it across the page, accelerating as it goes,
and it stops the moment you let go, at the size it already was. It never walks
off the page. `⌘/Ctrl + Shift + an arrow` is the tiling gesture instead:
it throws the window at that edge, and pressing the same arrow again cycles
the fraction it takes there — half, a third, two thirds. The editor keeps its
own arrows, since `⌘←`/`⌘→` is caret movement there; everywhere else — the
chat box, the thread, the results — the arrows drive the window.

The title bar carries three controls:

* **The transparency slider** — from barely-there to solid. Double-click it to
  return to the default. Unfocused, the window fades back a little further on
  its own, the way an unfocused terminal does.
* **◆ style** — cycles four frames: **Frosted** (the default: a wide blur
  doing the work, so text never fights the backdrop), **Clear** (least opacity,
  widest blur), **Terminal** (macOS Terminal with transparency turned up,
  traffic lights included) and **Aurora** (the same glass with the accent bled
  into the rim). Each frame moves the slider to the transparency it was drawn
  for; move it again afterwards if you disagree.
* **⊟ dock** — puts it back in the tiled layout as an ordinary tile beside the
  editor, where it behaves exactly like the other four and costs the editor
  width again. **⧉** floats it once more.

Below 1000px wide there is no workspace to float over, so it stacks with
everything else whatever you last chose.

Each message can carry context, and you choose what: the **warehouse schema**,
the **current exercise**, the **editor contents**, and the **last result or
error**. The switches are under **⚙**, all on by default, and turning one off
means that part is never assembled into the request — not sent and ignored.
Every ```` ```sql ```` block in an answer grows an **Insert** button that drops
it into the editor, asking first if you have a draft there.

Model is yours to pick — Opus 5 (the default), Sonnet 5, or Haiku 4.5 — and the
conversation lives for the page load; **New chat** clears it.

#### Signing in

Anthropic publishes no "sign in with Claude" for third-party websites. A
Claude.ai or Claude Code subscription cannot be spent from a page like this
one, and there is no OAuth flow to offer, so there are two honest options and
the panel supports both:

1. **Your own API key** (the default). Create one at
   [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
   and paste it into the panel. It is stored in your browser's `localStorage`
   under its own key — clearing your practice progress does not take it with it
   — and goes straight to `api.anthropic.com`; this site has no server and
   never sees it. Usage bills your own account. **⚙ → Forget my key** removes
   it.
2. **A proxy that holds one key for everyone.** `proxy/` is a Cloudflare Worker
   that keeps the key server-side; deploy it, point `CLAUDE_ENDPOINT` at it when
   deploying the site, and visitors need no key at all — but you pay for every
   question anyone asks. `proxy/README.md` covers the guards and the spend
   limit you should set first.

With neither configured, the panel shows the key card and calls nobody. A plain
checkout talks to no one, which is the same promise the rest of the site makes.

The Anthropic SDK is vendored at `engine/anthropic/` (185 KB, ~48 KB over the
wire) and imported only when the panel is first used, so a visit that never
opens it never downloads it.

### Activity log

The **Activity** tab keeps a record of every query that *ran successfully* —
the SQL, the exercise, the row count, the elapsed time, the grading verdict for
a Check, a stable device ID, and optionally your location. Export it as JSON or
CSV, or clear it.

Two limits are worth stating plainly, because they shape what this can be:

**There is no MAC address.** No browser exposes the network adapter's hardware
address to JavaScript — a globally unique, non-resettable hardware identifier is
exactly the kind of supercookie the platform withholds, and there is no
permission that unlocks it. (The old WebRTC ICE-candidate trick only ever leaked
a local *IP*, and browsers now mDNS-obfuscate that too.) The log therefore
carries a **device ID**: a random UUID minted once per browser profile and kept
in `localStorage`. It identifies a browser, not a machine, and the `reset` link
mints a new one. Anything that claims to read a MAC address from a web page is
guessing.

**The query log is not transmitted.** Entries stay in `localStorage` and leave
only when you export them. `activity.js` ends with a `drain(send)` function,
unused today, which is the seam a collector would hook into. The separate visit
log described below does not touch it — no SQL, no entries, no location.

Recording is on by default and local-only, like the existing progress tracking.
**Location is off until you turn it on**, and the browser runs its own
permission prompt on top of that; a fix is cached for 10 minutes so a practice
session does not re-geolocate on every query. The log keeps the most recent 500
entries and truncates any single query at 4,000 characters.

### Visit log

Separate from the Activity tab, and server-side: the hosted site reports each
page load to a small collector, which records the visitor's IP address. The
code is in `collector/` — a Cloudflare Worker writing to a D1 table, with the
deploy steps and query recipes in [`collector/README.md`](collector/README.md).

Three things about how it is built:

**The address is read from the connection, not the page.** A browser cannot see
its own public IP, and any address a client volunteers — in a field, in an
`X-Forwarded-For` header — is attacker-controlled. The Worker uses
`CF-Connecting-IP`, set by the edge after the handshake. `assets/js/beacon.js`
sends only the page path, the referrer, and the browser-local device ID.

**A checkout reports nowhere.** The endpoint lives in
`<meta name="collector-endpoint">`, empty in this repo. `tools/deploy_pages.sh`
injects the real one from `$COLLECTOR_ENDPOINT` at deploy time, so
`npm run serve` and a plain clone never phone anywhere. No visit data is ever
written back into this repository.

**The disclosure rides with the endpoint.** `deploy_pages.sh` adds the boot-card
sentence about IP logging in the same branch that injects the endpoint, and
fails the deploy if it cannot. So a build that reports nowhere never claims to
be logging, a build that does never stays quiet about it, and the stated
retention always matches `$RETENTION_DAYS`. The Worker's nightly cron drops
rows past that window (90 days by default). An IP is personal data in the EU/UK
and under several US state laws — logging one server-side to operate a site is
ordinary, but saying so and not keeping it forever is the part that makes it
ordinary.

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
npm run check        # regenerate seed, run every check suite
npm run check:browser  # end-to-end: boots the real page in Chromium
```

| Script | Checks |
|---|---|
| `tools/check_exercises.mjs` | all 61 solutions parse, run, and return rows |
| `tools/check_order.mjs` | the grader's `CAST(... AS VARCHAR)` wrapper preserves `ORDER BY` (56/56) |
| `tools/check_grading.mjs` | every solution with its columns reversed grades as a `column-order` pass (not a failure), a genuinely wrong answer still fails, and the Sandbox button tracks the mode in both directions |
| `tools/check_schema_notes.mjs` | the hover cards' tables, columns and join keys all exist in the database |
| `tools/check_claims.mjs` | the traps prompts describe actually occur in the data |
| `tools/check_dataset.mjs` | 24 dataset invariants (gaps, ties, streaks, overlaps, orphans) |
| `tools/browser_test.mjs` | boot, run, grade right/wrong answers, linter, schema, hover cards, hints, solution box, mobile layout |
| `tools/check_collector.mjs` | the visit collector logs the edge address (never the payload), enforces its origin allowlist, and prunes on schedule |
| `tools/check_proxy.mjs` | the Claude proxy's guards: origin allowlist, model allowlist, `max_tokens` ceiling, rate limit, and that it rebuilds the request body rather than forwarding it |
| `tools/check_assistant.mjs` | the Claude panel end to end against a fake Anthropic: it streams, renders, inserts SQL into the editor, and sends only the context that is switched on |
| `tools/check_window.mjs` | the Claude window as a window: it costs the layout nothing, drags, resizes from every edge without the opposite edge wandering, cannot be dragged off the page, docks, and is where you left it after a reload |

Run `npm run check` after touching `assets/js/curriculum.js`,
`assets/data/schema.sql`, or `tools/gen_seed.mjs`.

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

The **Tables** strip needs no field: it is derived from the backticked
identifiers in `prompt` and the table names in `solution`. Add `tables: ['...']`
only to put a table first, or to name one the exercise talks about without
querying.

## Layout

```
index.html                    single page
assets/css/app.css            the glass material: dark/light theme, backdrop, tiles
assets/js/engine.js           DuckDB boot, execution, grading, portability linter
assets/js/curriculum.js       all 61 exercises + tracks + dialect notes
assets/js/app.js              UI: editor, highlighting, grid, progress
assets/js/activity.js         activity log: device ID, opt-in location, export
assets/js/layout.js           the tile tree: drag-to-rearrange, splitters, tab order
assets/js/schema-doc.js       table purposes, schema.sql note parser, join keys
assets/js/tabletip.js         the table hover card (chips, prompt triggers, positioning)
assets/js/assistant.js        the Ask Claude panel: auth, context, streaming, rendering
assets/js/float.js            the floating window: move, resize, tint, frame, persistence
assets/data/schema.sql        20 annotated tables
assets/data/seed.sql          generated, deterministic (2.2 MB)
assets/data/compat.sql        Snowflake/Redshift function shims
assets/data/compat-tz.sql     time-zone shims (loaded only when ICU is available)
tools/                        generator + verification suites
engine/duckdb/                DuckDB-Wasm 1.33.1 (MIT), ~36 MB, ~8 MB over the wire
engine/anthropic/             @anthropic-ai/sdk (MIT), 185 KB, loaded on first use
proxy/                        optional Cloudflare Worker holding one API key
collector/                    optional Cloudflare Worker logging visits
```

`engine/duckdb/NOTICE.md` and `engine/anthropic/NOTICE.md` record licensing.
The Anthropic bundle is rebuilt with `npm run build:sdk`.

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
