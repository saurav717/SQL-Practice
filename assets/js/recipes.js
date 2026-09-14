// ===========================================================================
//  Recipe library for Explore mode.
//
//  These are NOT exercises. Nothing here is graded and nothing is hidden --
//  each one is a complete, runnable query you can load into the editor, run,
//  and then take apart. They exist so that "I want to poke at the data" has a
//  starting point for every class of query this warehouse can pose, instead of
//  an empty editor.
//
//  Rules for anything added here:
//    * it must RUN against the shipped dataset and return rows
//    * `note` says what to LOOK at in the result, not what the syntax means
//    * where a query demonstrates a trap, it shows the wrong and right answer
//      side by side in one result set, so the difference is visible at a glance
//
//  tools/check_recipes.mjs executes every one of them on every run of
//  `npm run check`, so a recipe that rots fails the build.
// ===========================================================================

export const RECIPE_CATEGORIES = [
  { id: 'basics',   name: 'Shape of the data',      blurb: 'What is in here, how much of it, and how bad is it.' },
  { id: 'joins',    name: 'Joins & fan-out',        blurb: 'Including the ways a join quietly changes your numbers.' },
  { id: 'nulls',    name: 'NULL semantics',         blurb: 'Three-valued logic, and where it bites.' },
  { id: 'agg',      name: 'Aggregation & grouping', blurb: 'GROUP BY, HAVING, ROLLUP, GROUPING SETS, PIVOT.' },
  { id: 'window',   name: 'Window frames',          blurb: 'ROWS vs RANGE vs GROUPS, and default-frame surprises.' },
  { id: 'rolling',  name: 'Rolling & cumulative',   blurb: 'Moving averages, running totals, period-over-period.' },
  { id: 'time',     name: 'Time & calendars',       blurb: 'Truncation, spines, gap filling, time zones.' },
  { id: 'patterns', name: 'Analytics patterns',     blurb: 'Gaps & islands, sessions, cohorts, funnels, SCD, as-of.' },
  { id: 'text',     name: 'Text & regex',           blurb: 'Messy human writing in support_tickets.' },
  { id: 'semi',     name: 'Semi-structured',        blurb: 'LIST and STRUCT columns, and raw payload text.' },
  { id: 'fx',       name: 'Reference & currency',   blurb: 'dim_country and the gappy fx_rates calendar.' },
  { id: 'stats',    name: 'Distributions & stats',  blurb: 'Percentiles, histograms, correlation, z-scores.' },
  { id: 'write',    name: 'Writing data',           blurb: 'DDL and DML. Reset data puts it all back.' },
  { id: 'meta',     name: 'Introspection & plans',  blurb: 'Ask the database about itself.' },
];

export const RECIPES = [

  // ---------------------------------------------------------------- basics --
  {
    id: 'b-tables', cat: 'basics', title: 'Every table and its row count',
    note: 'Start here. 24 tables. The row counts tell you which ones are facts and which are dimensions.',
    sql: `SELECT table_name,
       estimated_size AS approx_rows,
       column_count
FROM duckdb_tables()
ORDER BY approx_rows DESC;`,
  },
  {
    id: 'b-cols', cat: 'basics', title: 'Every column in the warehouse',
    note: 'One row per column across all tables. Filter it to hunt for a column whose name you half remember.',
    sql: `SELECT table_name, ordinal_position AS pos, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'main'
ORDER BY table_name, ordinal_position;`,
  },
  {
    id: 'b-peek', cat: 'basics', title: 'Peek at a table',
    note: 'The blunt instrument. Swap the table name for any other and re-run.',
    sql: `SELECT * FROM transactions LIMIT 50;`,
  },
  {
    id: 'b-profile', cat: 'basics', title: 'Profile a column: nulls, cardinality, range',
    note: 'The four questions worth asking of any column before you trust it. Note how many customers have no segment.',
    sql: `SELECT
    count(*)                                          AS rows_total,
    count(segment)                                    AS rows_with_segment,
    count(*) - count(segment)                         AS rows_null,
    round(100.0 * (count(*) - count(segment)) / count(*), 1) AS pct_null,
    count(DISTINCT segment)                           AS distinct_values,
    min(signup_ts)                                    AS earliest_signup,
    max(signup_ts)                                    AS latest_signup
FROM customers;`,
  },
  {
    id: 'b-summarize', cat: 'basics', title: 'SUMMARIZE: profile every column at once',
    note: 'DuckDB-only, and the fastest way to get your bearings in an unfamiliar table. No equivalent on Redshift.',
    sql: `SUMMARIZE transactions;`,
  },
  {
    id: 'b-freq', cat: 'basics', title: 'Frequency table for a categorical column',
    note: 'Counts plus share of total. The share is what tells you whether a category matters.',
    sql: `SELECT status,
       count(*)                                             AS n,
       round(100.0 * count(*) / sum(count(*)) OVER (), 2)   AS pct_of_all
FROM transactions
GROUP BY status
ORDER BY n DESC;`,
  },

  // ----------------------------------------------------------------- joins --
  {
    id: 'j-fanout', cat: 'joins', title: 'The fan-out, wrong and right in one result',
    note: 'shipping_fee is an ORDER-level column. Joining to order_items repeats it once per line, so the total comes out at 27,401.56 against a truth of 9,232.10 -- inflated by 18,169.46, about 3x. Wrong by that much is easy to catch. The same bug on a 1.05x fan-out is the one that ships.',
    sql: `SELECT
    (SELECT sum(shipping_fee) FROM orders)                       AS truth,
    (SELECT sum(o.shipping_fee)
       FROM orders o JOIN order_items i ON i.order_id = o.order_id) AS inflated_by_fanout,
    (SELECT sum(shipping_fee) FROM (
        SELECT DISTINCT o.order_id, o.shipping_fee
        FROM orders o JOIN order_items i ON i.order_id = o.order_id)) AS fixed_by_dedup;`,
  },
  {
    id: 'j-grain', cat: 'joins', title: 'Check the grain before you join',
    note: 'Run this on the right-hand table of any join. If max_rows_per_key > 1 the join will fan out, and any order-level sum through it is wrong.',
    sql: `SELECT
    count(*)                                  AS rows_total,
    count(DISTINCT order_id)                  AS distinct_keys,
    max(n)                                    AS max_rows_per_key,
    count(*) FILTER (WHERE n > 1)             AS keys_that_fan_out
FROM (SELECT order_id, count(*) AS n FROM order_items GROUP BY order_id);`,
  },
  {
    id: 'j-left', cat: 'joins', title: 'LEFT JOIN: COUNT(*) vs COUNT(column)',
    note: 'Legal has no employees. COUNT(*) says it has one, because the outer join manufactured a row of NULLs. COUNT(e.employee_id) says zero. Only one of those is a headcount.',
    sql: `SELECT d.dept_name,
       count(*)                AS count_star_WRONG,
       count(e.employee_id)    AS count_column_RIGHT
FROM departments d
LEFT JOIN employees e ON e.department_id = d.department_id
GROUP BY d.dept_name
ORDER BY count_column_RIGHT, d.dept_name;`,
  },
  {
    id: 'j-anti', cat: 'joins', title: 'Anti-join: customers who never transacted',
    note: 'NOT EXISTS is the form that is NULL-safe and usually the fastest. The LEFT JOIN ... IS NULL form below it returns the same 16 rows.',
    sql: `SELECT c.customer_id, c.full_name, c.country
FROM customers c
WHERE NOT EXISTS (
    SELECT 1 FROM transactions t WHERE t.customer_id = c.customer_id
)
ORDER BY c.customer_id;`,
  },
  {
    id: 'j-semi', cat: 'joins', title: 'Semi-join vs join: count customers, not rows',
    note: 'The inner join counts one row per transaction. The semi-join counts customers. Same intent, 13,191 vs 124.',
    sql: `SELECT
    (SELECT count(*) FROM customers c
       JOIN transactions t ON t.customer_id = c.customer_id)     AS inner_join_rows,
    (SELECT count(*) FROM customers c
      WHERE EXISTS (SELECT 1 FROM transactions t
                     WHERE t.customer_id = c.customer_id))       AS customers_who_transacted;`,
  },
  {
    id: 'j-self', cat: 'joins', title: 'Self join: employee to manager',
    note: 'The CEO has no manager, so this must be a LEFT join or you silently lose the top of the org.',
    sql: `SELECT e.employee_id, e.full_name, e.title,
       m.full_name AS manager, m.title AS manager_title
FROM employees e
LEFT JOIN employees m ON m.employee_id = e.manager_id
ORDER BY m.full_name NULLS FIRST, e.full_name;`,
  },
  {
    id: 'j-orphan', cat: 'joins', title: 'Find orphan rows on both sides',
    note: 'No foreign keys are enforced here, exactly as on Redshift/Snowflake/Athena. A FULL OUTER JOIN is how you audit what that cost you.',
    sql: `SELECT
    count(*) FILTER (WHERE o.order_id IS NULL)   AS payments_without_order,
    count(*) FILTER (WHERE p.order_id IS NULL)   AS orders_without_payment,
    count(*) FILTER (WHERE o.order_id IS NOT NULL
                       AND p.order_id IS NOT NULL) AS matched
FROM orders o
FULL OUTER JOIN payments p ON p.order_id = o.order_id;`,
  },

  // ----------------------------------------------------------------- nulls --
  {
    id: 'n-notin', cat: 'nulls', title: 'NOT IN against a NULL: the empty result',
    note: 'Four employees have a NULL department_id. That single NULL makes NOT IN return zero rows forever -- not an error, just silence. NOT EXISTS finds the real answer.',
    sql: `SELECT
    (SELECT count(*) FROM departments
      WHERE department_id NOT IN (SELECT department_id FROM employees))    AS not_in_BROKEN,
    (SELECT count(*) FROM departments d
      WHERE NOT EXISTS (SELECT 1 FROM employees e
                         WHERE e.department_id = d.department_id))         AS not_exists_RIGHT,
    (SELECT count(*) FROM employees WHERE department_id IS NULL)           AS the_null_that_did_it;`,
  },
  {
    id: 'n-3vl', cat: 'nulls', title: 'Three-valued logic, laid out',
    note: 'NULL = NULL is not true. It is not false either. IS NOT DISTINCT FROM is the operator that treats two NULLs as equal.',
    sql: `SELECT
    (NULL = NULL)                       AS null_eq_null,
    (NULL <> NULL)                      AS null_ne_null,
    (NULL IS NULL)                      AS null_is_null,
    (NULL IS NOT DISTINCT FROM NULL)    AS null_not_distinct_from_null,
    (1 IN (2, NULL))                    AS one_in_two_null,
    (1 NOT IN (2, NULL))                AS one_not_in_two_null,
    (TRUE OR NULL)                      AS true_or_null,
    (FALSE AND NULL)                    AS false_and_null;`,
  },
  {
    id: 'n-agg', cat: 'nulls', title: 'Aggregates skip NULLs -- averages lie',
    note: 'AVG divides by the count of NON-NULL values. If a missing reading means zero, AVG is wrong and you want COALESCE first. Compare the two columns.',
    sql: `SELECT
    count(*)                                       AS rows_total,
    count(satisfaction)                            AS rated,
    round(avg(satisfaction), 3)                    AS avg_skipping_nulls,
    round(avg(coalesce(satisfaction, 0)), 3)       AS avg_treating_null_as_zero,
    round(sum(satisfaction) * 1.0 / count(*), 3)   AS sum_over_all_rows
FROM support_tickets;`,
  },
  {
    id: 'n-coalesce', cat: 'nulls', title: 'COALESCE, NULLIF and the divide-by-zero guard',
    note: 'daily_revenue has 7 zero days. Dividing by revenue without NULLIF is a runtime error waiting for the day the denominator goes to zero.',
    sql: `SELECT day, revenue,
       lag(revenue) OVER (ORDER BY day)                                   AS prev_revenue,
       round(100.0 * (revenue - lag(revenue) OVER (ORDER BY day))
             / nullif(lag(revenue) OVER (ORDER BY day), 0), 2)            AS pct_change_safe
FROM daily_revenue
WHERE day BETWEEN DATE '2025-03-01' AND DATE '2025-04-15'
ORDER BY day;`,
  },
  {
    id: 'n-sort', cat: 'nulls', title: 'Where do NULLs sort?',
    note: 'DuckDB and Postgres put NULLs last on ASC by default; other engines disagree. Say NULLS FIRST or NULLS LAST explicitly and stop guessing.',
    sql: `SELECT city, count(*) AS n
FROM customers
GROUP BY city
ORDER BY city ASC NULLS FIRST;`,
  },

  // ------------------------------------------------------------------- agg --
  {
    id: 'a-having', cat: 'agg', title: 'WHERE filters rows, HAVING filters groups',
    note: 'The WHERE clause runs before grouping, HAVING after. Swapping them changes the answer, not just the plan.',
    sql: `SELECT c.country,
       count(*)                AS settled_txns,
       round(sum(t.amount), 2) AS settled_value
FROM transactions t
JOIN customers c ON c.customer_id = t.customer_id
WHERE t.status = 'settled'
GROUP BY c.country
HAVING count(*) > 400
ORDER BY settled_value DESC;`,
  },
  {
    id: 'a-rollup', cat: 'agg', title: 'ROLLUP: subtotals and a grand total',
    note: 'The rows where segment is NULL are the per-country subtotals; the row where both are NULL is the grand total. GROUPING() tells them apart from real NULLs.',
    sql: `SELECT coalesce(country, '(all countries)')  AS country,
       coalesce(segment, '(all segments)')   AS segment,
       grouping(country) + grouping(segment) AS subtotal_level,
       count(*)                              AS customers
FROM customers
GROUP BY ROLLUP (country, segment)
ORDER BY subtotal_level DESC, country, segment;`,
  },
  {
    id: 'a-sets', cat: 'agg', title: 'GROUPING SETS: three reports in one scan',
    note: 'By channel, by status, and overall -- without scanning orders three times or UNION ALL-ing three queries.',
    sql: `SELECT coalesce(channel, '-')             AS channel,
       coalesce(status, '-')              AS status,
       count(*)                           AS orders,
       round(sum(shipping_fee), 2)        AS shipping
FROM orders
GROUP BY GROUPING SETS ((channel), (status), ())
ORDER BY channel, status;`,
  },
  {
    id: 'a-pivot-portable', cat: 'agg', title: 'Pivot the portable way: conditional aggregation',
    note: 'SUM(CASE WHEN ...) is the pivot that runs on every engine. Learn this one; the PIVOT keyword is a convenience, not a skill.',
    sql: `SELECT channel,
       count(*)                                                 AS orders_total,
       count(*) FILTER (WHERE status = 'completed')             AS completed,
       count(*) FILTER (WHERE status = 'cancelled')             AS cancelled,
       count(*) FILTER (WHERE status = 'returned')              AS returned,
       sum(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)    AS completed_portable,
       round(100.0 * count(*) FILTER (WHERE status = 'completed') / count(*), 1) AS pct_completed
FROM orders
GROUP BY channel
ORDER BY orders_total DESC;`,
  },
  {
    id: 'a-pivot-kw', cat: 'agg', title: 'PIVOT and UNPIVOT keywords',
    note: 'DuckDB-only syntax. Handy here, unavailable on Redshift and Trino -- the Portability tab will say so.',
    sql: `PIVOT orders
ON channel
USING count(*) AS n, round(sum(shipping_fee), 2) AS fees
GROUP BY status
ORDER BY status;`,
  },
  {
    id: 'a-distinct', cat: 'agg', title: 'COUNT(DISTINCT) vs counting rows',
    note: 'A customer with two cards is one customer and two cards. Which number you want depends on the question -- but they are never interchangeable.',
    sql: `SELECT c.country,
       count(*)                          AS card_rows,
       count(DISTINCT c.customer_id)     AS customers,
       count(DISTINCT k.network)         AS networks_used,
       string_agg(DISTINCT k.network, ', ' ORDER BY k.network) AS which_networks
FROM customers c
JOIN cards k ON k.customer_id = c.customer_id
GROUP BY c.country
ORDER BY customers DESC;`,
  },

  // ---------------------------------------------------------------- window --
  {
    id: 'w-default', cat: 'window', title: 'The default frame is RANGE, and it surprises people',
    note: 'With ORDER BY and no frame clause you get RANGE UNBOUNDED PRECEDING AND CURRENT ROW. Across tied timestamps that jumps straight to the group total. The ROWS column climbs one row at a time; the RANGE column does not.',
    sql: `SELECT txn_ts, amount,
       sum(amount) OVER (ORDER BY txn_ts)                                        AS default_frame_RANGE,
       sum(amount) OVER (ORDER BY txn_ts ROWS UNBOUNDED PRECEDING)               AS explicit_ROWS,
       count(*)    OVER (PARTITION BY txn_ts)                                    AS rows_sharing_this_ts
FROM transactions
WHERE txn_ts IN (SELECT txn_ts FROM transactions GROUP BY txn_ts HAVING count(*) > 2)
ORDER BY txn_ts, amount
LIMIT 40;`,
  },
  {
    id: 'w-rows-range', cat: 'window', title: 'ROWS 6 PRECEDING is not "the last 7 days"',
    note: 'daily_revenue has 47 missing days. ROWS counts rows; RANGE counts calendar time. Where they disagree, the gap is the reason. Look at days_spanned.',
    sql: `SELECT day, revenue,
       round(sum(revenue) OVER (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW), 2)    AS rows_6,
       round(sum(revenue) OVER (ORDER BY day
             RANGE BETWEEN INTERVAL '6' DAY PRECEDING AND CURRENT ROW), 2)                    AS range_6d,
       day - min(day) OVER (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)            AS days_spanned
FROM daily_revenue
QUALIFY rows_6 <> range_6d
ORDER BY day
LIMIT 40;`,
  },
  {
    id: 'w-lastvalue', cat: 'window', title: 'LAST_VALUE returns the current row unless you tell it not to',
    note: 'The default frame ends at CURRENT ROW, so "last value" means "this one". The fix is an explicit frame, or MAX/FIRST_VALUE with a reversed sort.',
    sql: `SELECT day, revenue,
       last_value(revenue) OVER (ORDER BY day)                                AS last_value_WRONG,
       last_value(revenue) OVER (ORDER BY day
             ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)        AS last_value_RIGHT,
       first_value(revenue) OVER (ORDER BY day DESC)                          AS same_thing_reversed
FROM daily_revenue
ORDER BY day
LIMIT 20;`,
  },
  {
    id: 'w-ranks', cat: 'window', title: 'ROW_NUMBER vs RANK vs DENSE_RANK on ties',
    note: 'Filtered to a customer with duplicate amounts so the three columns actually differ. ROW_NUMBER breaks ties arbitrarily -- never use it where ties are meaningful.',
    sql: `SELECT customer_id, amount,
       row_number() OVER (PARTITION BY customer_id ORDER BY amount DESC) AS rn,
       rank()       OVER (PARTITION BY customer_id ORDER BY amount DESC) AS rnk,
       dense_rank() OVER (PARTITION BY customer_id ORDER BY amount DESC) AS dense,
       percent_rank() OVER (PARTITION BY customer_id ORDER BY amount DESC) AS pct_rank
FROM transactions
WHERE customer_id = (
    SELECT customer_id FROM transactions
    GROUP BY customer_id, amount HAVING count(*) > 1
    LIMIT 1)
ORDER BY amount DESC
LIMIT 30;`,
  },
  {
    id: 'w-groups', cat: 'window', title: 'GROUPS frames: count peer groups, not rows',
    note: 'A GROUPS frame steps in units of tied peers. Compare against the ROWS frame over the same data.',
    sql: `SELECT txn_ts, amount,
       count(*) OVER (ORDER BY txn_ts GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) AS groups_frame,
       count(*) OVER (ORDER BY txn_ts ROWS   BETWEEN 1 PRECEDING AND CURRENT ROW) AS rows_frame
FROM transactions
WHERE txn_ts >= TIMESTAMP '2025-01-01' AND txn_ts < TIMESTAMP '2025-01-03'
ORDER BY txn_ts
LIMIT 40;`,
  },
  {
    id: 'w-exclude', cat: 'window', title: 'Leave-one-out average with EXCLUDE CURRENT ROW',
    note: 'Comparing a row against its own neighbourhood average is circular if the row is in the average. Postgres/DuckDB spell the fix EXCLUDE CURRENT ROW; everywhere else you subtract by hand, as the last column does.',
    sql: `SELECT day, revenue,
       round(avg(revenue) OVER w, 2)                                             AS avg_including_self,
       round(avg(revenue) OVER (ORDER BY day
             ROWS BETWEEN 3 PRECEDING AND 3 FOLLOWING EXCLUDE CURRENT ROW), 2)   AS avg_excluding_self,
       round((sum(revenue) OVER w - revenue)
             / nullif(count(*) OVER w - 1, 0), 2)                                AS same_thing_portable
FROM daily_revenue
WINDOW w AS (ORDER BY day ROWS BETWEEN 3 PRECEDING AND 3 FOLLOWING)
ORDER BY day
LIMIT 25;`,
  },
  {
    id: 'w-qualify', cat: 'window', title: 'QUALIFY: filter on a window function',
    note: 'You cannot put a window function in WHERE -- it is computed after. QUALIFY is Snowflake/DuckDB sugar for the CTE you would otherwise write.',
    sql: `SELECT customer_id, txn_ts, amount
FROM transactions
WHERE status = 'settled'
QUALIFY row_number() OVER (PARTITION BY customer_id ORDER BY amount DESC) <= 3
ORDER BY customer_id, amount DESC
LIMIT 40;`,
  },

  // --------------------------------------------------------------- rolling --
  {
    id: 'r-ma', cat: 'rolling', title: '7-day moving average, done honestly',
    note: 'Built on a gap-free spine so a missing day counts as zero rather than being skipped. The partial column marks the first six days, where the average is over fewer than 7 days and should usually be suppressed.',
    sql: `WITH spine AS (
    SELECT CAST(d AS DATE) AS day
    FROM generate_series(DATE '2025-01-01', DATE '2025-06-30', INTERVAL 1 DAY) AS g(d)
), filled AS (
    SELECT s.day, coalesce(r.revenue, 0) AS revenue
    FROM spine s
    LEFT JOIN daily_revenue r ON r.day = s.day
)
SELECT day, revenue,
       round(avg(revenue) OVER (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW), 2) AS ma7,
       count(*) OVER (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) < 7 AS partial_window
FROM filled
ORDER BY day;`,
  },
  {
    id: 'r-running', cat: 'rolling', title: 'Running total and share of cumulative',
    note: 'A running total needs an explicit ROWS frame, or ties in the ORDER BY will make it jump.',
    sql: `SELECT day, revenue,
       round(sum(revenue) OVER (ORDER BY day ROWS UNBOUNDED PRECEDING), 2)      AS running_total,
       round(100.0 * sum(revenue) OVER (ORDER BY day ROWS UNBOUNDED PRECEDING)
             / sum(revenue) OVER (), 2)                                         AS pct_of_period_to_date
FROM daily_revenue
WHERE day >= DATE '2026-01-01'
ORDER BY day;`,
  },
  {
    id: 'r-rolling30', cat: 'rolling', title: 'Rolling 30-day spend per customer',
    note: 'A RANGE frame with an INTERVAL offset is a real 30 days of wall-clock time, gaps and all. Redshift cannot do this -- see the Portability tab.',
    sql: `SELECT customer_id, txn_ts, amount,
       round(sum(amount) OVER (
           PARTITION BY customer_id ORDER BY txn_ts
           RANGE BETWEEN INTERVAL '30' DAY PRECEDING AND CURRENT ROW), 2) AS spend_30d,
       count(*) OVER (
           PARTITION BY customer_id ORDER BY txn_ts
           RANGE BETWEEN INTERVAL '30' DAY PRECEDING AND CURRENT ROW)     AS txns_30d
FROM transactions
WHERE customer_id <= 3 AND status = 'settled'
ORDER BY customer_id, txn_ts
LIMIT 60;`,
  },
  {
    id: 'r-wow', cat: 'rolling', title: 'Week-over-week and month-over-month',
    note: 'LAG over an aggregated CTE, not over raw rows. Aggregate first, then compare -- the other order is a common and silent mistake.',
    sql: `WITH weekly AS (
    SELECT date_trunc('week', order_ts) AS week_start,
           count(*)                     AS orders,
           round(sum(shipping_fee), 2)  AS shipping
    FROM orders
    GROUP BY 1
)
SELECT week_start, orders,
       lag(orders) OVER (ORDER BY week_start)                                  AS prev_week,
       orders - lag(orders) OVER (ORDER BY week_start)                         AS delta,
       round(100.0 * (orders - lag(orders) OVER (ORDER BY week_start))
             / nullif(lag(orders) OVER (ORDER BY week_start), 0), 1)           AS wow_pct
FROM weekly
ORDER BY week_start;`,
  },
  {
    id: 'r-carry', cat: 'rolling', title: 'Carry the last known value forward',
    note: 'The classic fill-forward. IGNORE NULLS is what makes it work; without it you get the NULL back.',
    sql: `WITH spine AS (
    SELECT CAST(d AS DATE) AS day
    FROM generate_series(DATE '2025-02-01', DATE '2025-03-15', INTERVAL 1 DAY) AS g(d)
), sparse AS (
    SELECT s.day, r.revenue
    FROM spine s LEFT JOIN daily_revenue r ON r.day = s.day
)
SELECT day, revenue AS raw_revenue,
       last_value(revenue IGNORE NULLS) OVER (ORDER BY day ROWS UNBOUNDED PRECEDING) AS carried_forward,
       revenue IS NULL AS was_missing
FROM sparse
ORDER BY day;`,
  },

  // ------------------------------------------------------------------ time --
  {
    id: 't-trunc', cat: 'time', title: 'DATE_TRUNC at every grain',
    note: 'One timestamp, six truncations. Note that week starts on Monday here -- Snowflake follows a session parameter and may disagree.',
    sql: `SELECT txn_ts,
       date_trunc('hour',    txn_ts) AS hour,
       date_trunc('day',     txn_ts) AS day,
       date_trunc('week',    txn_ts) AS week_monday,
       date_trunc('month',   txn_ts) AS month,
       date_trunc('quarter', txn_ts) AS quarter,
       date_trunc('year',    txn_ts) AS year
FROM transactions
ORDER BY txn_ts
LIMIT 15;`,
  },
  {
    id: 't-extract', cat: 'time', title: 'EXTRACT, and the two competing day-of-week numberings',
    note: 'ISODOW is Monday=1..Sunday=7. DOW is Sunday=0..Saturday=6. Picking the wrong one shifts your whole week by a day.',
    sql: `SELECT day, day_name,
       extract(isodow FROM day)   AS isodow_mon1,
       extract(dow    FROM day)   AS dow_sun0,
       iso_dow                    AS dim_iso_dow,
       dow_sun0                   AS dim_dow_sun0,
       week_start_mon, week_start_sun,
       week_start_mon <> week_start_sun AS the_two_weeks_differ
FROM dim_date
WHERE day BETWEEN DATE '2026-03-01' AND DATE '2026-03-10'
ORDER BY day;`,
  },
  {
    id: 't-datediff', cat: 'time', title: 'DATEDIFF counts boundaries crossed, not elapsed time',
    note: 'One day apart, but DATEDIFF("year", ...) says 1 -- because it counts year boundaries crossed. This is the single most common date bug in analytics.',
    sql: `SELECT
    DATEDIFF('year',  DATE '2025-12-31', DATE '2026-01-01')  AS one_day_apart_says_1_year,
    DATEDIFF('month', DATE '2026-01-31', DATE '2026-02-01')  AS one_day_apart_says_1_month,
    DATEDIFF('day',   DATE '2025-12-31', DATE '2026-01-01')  AS actually_one_day,
    DATE '2026-01-01' - DATE '2025-12-31'                    AS plain_subtraction,
    DATEADD('month', 1, DATE '2026-01-31')                   AS jan31_plus_a_month;`,
  },
  {
    id: 't-spine', cat: 'time', title: 'Build a date spine three ways',
    note: 'A gap-free calendar is the foundation of any honest time series. This warehouse ships dim_date, so prefer that; the other two are for when yours does not.',
    sql: `WITH RECURSIVE recur AS (
    SELECT DATE '2026-01-01' AS day
    UNION ALL
    SELECT day + 1 FROM recur WHERE day < DATE '2026-01-31'
)
SELECT 'generate_series' AS method, count(*) AS days,
       min(CAST(d AS DATE)) AS first_day, max(CAST(d AS DATE)) AS last_day
FROM generate_series(DATE '2026-01-01', DATE '2026-01-31', INTERVAL 1 DAY) AS g(d)
UNION ALL
SELECT 'recursive CTE', count(*), min(day), max(day) FROM recur
UNION ALL
SELECT 'dim_date table', count(*), min(day), max(day) FROM dim_date
WHERE day BETWEEN DATE '2026-01-01' AND DATE '2026-01-31';`,
  },
  {
    id: 't-gapfill', cat: 'time', title: 'Gap filling: the missing days are the point',
    note: 'daily_revenue has 47 absent days. They are not zeros in the table -- they are simply not there. Only a LEFT JOIN from a spine can tell you which.',
    sql: `SELECT CAST(g.d AS DATE) AS day,
       r.revenue                          AS raw,
       coalesce(r.revenue, 0)             AS filled,
       r.day IS NULL                      AS day_was_missing
FROM generate_series(DATE '2025-01-01', DATE '2025-12-31', INTERVAL 1 DAY) AS g(d)
LEFT JOIN daily_revenue r ON r.day = CAST(g.d AS DATE)
WHERE r.day IS NULL
ORDER BY day;`,
  },
  {
    id: 't-business', cat: 'time', title: 'Business days between two dates',
    note: 'Counting weekdays with arithmetic is fiddly and wrong around holidays. With a calendar dimension it is a SUM over a filter.',
    sql: `SELECT o.order_id, CAST(o.order_ts AS DATE) AS ordered,
       CAST(p.paid_ts AS DATE)                AS paid,
       CAST(p.paid_ts AS DATE) - CAST(o.order_ts AS DATE) AS calendar_days,
       (SELECT count(*) FROM dim_date d
         WHERE d.day >  CAST(o.order_ts AS DATE)
           AND d.day <= CAST(p.paid_ts AS DATE)
           AND d.is_weekday = 1 AND d.is_holiday = 0)      AS business_days
FROM orders o
JOIN payments p ON p.order_id = o.order_id
WHERE p.paid_ts > o.order_ts
ORDER BY calendar_days DESC
LIMIT 25;`,
  },
  {
    id: 't-tz', cat: 'time', title: 'Fixed offset vs real time zone',
    note: 'A fixed offset is wrong for half the year. This uses each customer stored offset, which is the naive approach -- compare local_fixed against what a real IANA zone would give in summer.',
    sql: `SELECT c.customer_id, c.tz_name, c.utc_offset_minutes,
       t.txn_ts                                                      AS utc,
       t.txn_ts + (c.utc_offset_minutes * INTERVAL 1 MINUTE)         AS local_fixed_offset,
       extract(hour FROM t.txn_ts + (c.utc_offset_minutes * INTERVAL 1 MINUTE)) AS local_hour
FROM transactions t
JOIN customers c ON c.customer_id = t.customer_id
WHERE c.tz_name = 'America/New_York'
  AND t.txn_ts >= TIMESTAMP '2025-07-01'
  AND t.txn_ts <  TIMESTAMP '2025-07-08'
ORDER BY t.txn_ts
LIMIT 20;`,
  },

  // -------------------------------------------------------------- patterns --
  {
    id: 'p-islands', cat: 'patterns', title: 'Gaps & islands: longest login streak',
    note: 'The trick is date minus row_number: within a run of consecutive days that difference is constant, so it becomes the group key.',
    sql: `WITH days AS (
    SELECT DISTINCT customer_id, CAST(login_ts AS DATE) AS day
    FROM logins WHERE success = 1
), grouped AS (
    SELECT customer_id, day,
           day - CAST(row_number() OVER (PARTITION BY customer_id ORDER BY day) AS INTEGER) AS grp
    FROM days
), runs AS (
    SELECT customer_id, min(day) AS streak_start, max(day) AS streak_end, count(*) AS streak_days
    FROM grouped GROUP BY customer_id, grp
)
SELECT * FROM runs
ORDER BY streak_days DESC, customer_id
LIMIT 20;`,
  },
  {
    id: 'p-session', cat: 'patterns', title: 'Sessionize a clickstream on a 30-minute gap',
    note: 'Flag each row that opens a new session, then cumulative-sum the flags into a session id. The standard two-step.',
    sql: `WITH flagged AS (
    SELECT customer_id, event_ts, event_type,
           CASE WHEN event_ts - lag(event_ts) OVER (PARTITION BY customer_id ORDER BY event_ts)
                     > INTERVAL 30 MINUTE
                  OR lag(event_ts) OVER (PARTITION BY customer_id ORDER BY event_ts) IS NULL
                THEN 1 ELSE 0 END AS is_new_session
    FROM clickstream
), sessioned AS (
    SELECT *, sum(is_new_session) OVER (PARTITION BY customer_id ORDER BY event_ts
                                        ROWS UNBOUNDED PRECEDING) AS session_no
    FROM flagged
)
SELECT customer_id, session_no,
       min(event_ts) AS started, max(event_ts) AS ended,
       count(*)      AS events,
       CAST(date_diff('second', min(event_ts), max(event_ts)) AS INTEGER) AS duration_s,
       count(*) FILTER (WHERE event_type = 'purchase') > 0 AS converted
FROM sessioned
GROUP BY customer_id, session_no
ORDER BY events DESC, customer_id
LIMIT 25;`,
  },
  {
    id: 'p-funnel', cat: 'patterns', title: 'Funnel with step-to-step conversion',
    note: 'Counting distinct customers per step, not events. The drop between begin_checkout and purchase is where the money leaks.',
    sql: `WITH steps AS (
    SELECT 1 AS step_no, 'view_home'      AS step UNION ALL
    SELECT 2, 'view_product'   UNION ALL
    SELECT 3, 'add_to_cart'    UNION ALL
    SELECT 4, 'begin_checkout' UNION ALL
    SELECT 5, 'purchase'
), counted AS (
    SELECT s.step_no, s.step,
           count(DISTINCT c.customer_id) AS customers
    FROM steps s
    LEFT JOIN clickstream c ON c.event_type = s.step
    GROUP BY s.step_no, s.step
)
SELECT step_no, step, customers,
       round(100.0 * customers / first_value(customers) OVER (ORDER BY step_no), 1) AS pct_of_top,
       round(100.0 * customers
             / nullif(lag(customers) OVER (ORDER BY step_no), 0), 1)                AS pct_of_prev_step
FROM counted
ORDER BY step_no;`,
  },
  {
    id: 'p-cohort', cat: 'patterns', title: 'Monthly signup cohort retention',
    note: 'Rows are signup month, columns are months since signup. A healthy product has a flattening curve; read across each row.',
    sql: `WITH base AS (
    SELECT c.customer_id,
           date_trunc('month', c.signup_ts) AS cohort_month,
           date_trunc('month', o.order_ts)  AS active_month
    FROM customers c
    JOIN orders o ON o.customer_id = c.customer_id
), sized AS (
    SELECT cohort_month, count(DISTINCT customer_id) AS cohort_size
    FROM base GROUP BY cohort_month
)
SELECT b.cohort_month,
       s.cohort_size,
       CAST(date_diff('month', b.cohort_month, b.active_month) AS INTEGER) AS months_since,
       count(DISTINCT b.customer_id) AS active,
       round(100.0 * count(DISTINCT b.customer_id) / s.cohort_size, 1) AS pct_retained
FROM base b
JOIN sized s ON s.cohort_month = b.cohort_month
WHERE b.active_month >= b.cohort_month
GROUP BY b.cohort_month, s.cohort_size, months_since
ORDER BY b.cohort_month, months_since;`,
  },
  {
    id: 'p-scd', cat: 'patterns', title: 'SCD Type 2: half-open beats closed intervals',
    note: 'Versions are contiguous, so valid_to of one equals valid_from of the next. Use <= on both ends and every order landing exactly on a boundary matches two versions. The difference is the last column.',
    sql: `SELECT
    (SELECT count(*) FROM orders)                                   AS orders_total,
    (SELECT count(*) FROM orders o JOIN dim_customer_scd d
       ON d.customer_id = o.customer_id
      AND o.order_ts >= d.valid_from
      AND (d.valid_to IS NULL OR o.order_ts < d.valid_to))          AS half_open_RIGHT,
    (SELECT count(*) FROM orders o JOIN dim_customer_scd d
       ON d.customer_id = o.customer_id
      AND o.order_ts >= d.valid_from
      AND (d.valid_to IS NULL OR o.order_ts <= d.valid_to))         AS closed_both_ends_WRONG;`,
  },
  {
    id: 'p-asof', cat: 'patterns', title: 'As-of join: balance at the moment of the transaction',
    note: 'Snapshots do not line up with transaction times. ASOF JOIN picks the latest row at or before each event. The portable equivalent is the correlated subquery underneath it.',
    sql: `SELECT t.txn_id, t.customer_id, t.txn_ts, t.amount,
       b.snapshot_ts                                    AS balance_as_of,
       b.balance,
       CAST(date_diff('hour', b.snapshot_ts, t.txn_ts) AS INTEGER) AS snapshot_age_hours
FROM transactions t
ASOF LEFT JOIN balance_snapshots b
  ON b.customer_id = t.customer_id
 AND b.snapshot_ts <= t.txn_ts
WHERE t.customer_id <= 3
ORDER BY t.txn_ts
LIMIT 30;`,
  },
  {
    id: 'p-dedup', cat: 'patterns', title: 'Deduplicate a CDC landing table',
    note: 'Keep the newest row per business key. ROW_NUMBER, not DISTINCT -- DISTINCT cannot express "newest".',
    sql: `WITH ranked AS (
    SELECT *,
           row_number() OVER (PARTITION BY source_customer_id ORDER BY updated_at DESC, row_id DESC) AS rn,
           count(*)     OVER (PARTITION BY source_customer_id) AS versions
    FROM staging_customers
)
SELECT source_customer_id, full_name, email, country, updated_at, versions
FROM ranked
WHERE rn = 1 AND versions > 1
ORDER BY versions DESC, source_customer_id;`,
  },
  {
    id: 'p-overlap', cat: 'patterns', title: 'Overlapping bookings on the same resource',
    note: 'Two intervals overlap when each starts before the other ends. The a.booking_id < b.booking_id guard stops every pair appearing twice.',
    sql: `SELECT a.resource_id,
       a.booking_id AS booking_a, b.booking_id AS booking_b,
       a.start_ts   AS a_start,   a.end_ts     AS a_end,
       b.start_ts   AS b_start,   b.end_ts     AS b_end,
       CAST(date_diff('minute', greatest(a.start_ts, b.start_ts),
                                least(a.end_ts, b.end_ts)) AS INTEGER) AS overlap_minutes
FROM bookings a
JOIN bookings b
  ON b.resource_id = a.resource_id
 AND a.booking_id  < b.booking_id
 AND a.start_ts    < b.end_ts
 AND b.start_ts    < a.end_ts
ORDER BY overlap_minutes DESC;`,
  },
  {
    id: 'p-active', cat: 'patterns', title: 'Daily active subscriptions from intervals',
    note: 'A spine crossed with the intervals. Some customers churned and came back, so counting distinct customers and counting subscriptions give different answers.',
    sql: `SELECT CAST(g.d AS DATE)                    AS day,
       count(*)                              AS active_subscriptions,
       count(DISTINCT s.customer_id)         AS distinct_customers,
       round(sum(s.mrr), 2)                  AS mrr
FROM generate_series(DATE '2026-01-01', DATE '2026-03-31', INTERVAL 1 DAY) AS g(d)
JOIN subscriptions s
  ON s.start_date <= CAST(g.d AS DATE)
 AND (s.end_date IS NULL OR CAST(g.d AS DATE) < s.end_date)
GROUP BY day
ORDER BY day;`,
  },
  {
    id: 'p-hier', cat: 'patterns', title: 'Recursive CTE: walk the category tree',
    note: 'Depth, and a materialised path built by string concatenation on the way down.',
    sql: `WITH RECURSIVE tree AS (
    SELECT category_id, category_name, parent_id,
           0 AS depth,
           category_name AS path
    FROM categories WHERE parent_id IS NULL
    UNION ALL
    SELECT c.category_id, c.category_name, c.parent_id,
           t.depth + 1,
           t.path || ' > ' || c.category_name
    FROM categories c
    JOIN tree t ON c.parent_id = t.category_id
)
SELECT category_id, depth, path,
       (SELECT count(*) FROM categories k WHERE k.parent_id = tree.category_id) AS direct_children
FROM tree
ORDER BY path;`,
  },
  {
    id: 'p-velocity', cat: 'patterns', title: 'Velocity check: same card, seconds apart',
    note: 'Classic fraud signal. LAG within the card partition, then filter on the gap and a category change.',
    sql: `WITH seq AS (
    SELECT t.txn_id, t.card_id, t.txn_ts, t.amount, m.category,
           lag(t.txn_ts)   OVER (PARTITION BY t.card_id ORDER BY t.txn_ts) AS prev_ts,
           lag(m.category) OVER (PARTITION BY t.card_id ORDER BY t.txn_ts) AS prev_category
    FROM transactions t
    JOIN merchants m ON m.merchant_id = t.merchant_id
)
SELECT card_id, prev_ts, txn_ts,
       CAST(date_diff('second', prev_ts, txn_ts) AS INTEGER) AS seconds_apart,
       prev_category, category, amount
FROM seq
WHERE prev_ts IS NOT NULL
  AND date_diff('second', prev_ts, txn_ts) < 60
  AND category <> prev_category
ORDER BY seconds_apart, card_id
LIMIT 30;`,
  },

  // ------------------------------------------------------------------ text --
  {
    id: 'x-messy', cat: 'text', title: 'Why GROUP BY on raw text lies',
    note: 'There are 10 real ticket subjects. Grouping the raw column finds ~146, because of padding, casing and "RE:" prefixes. Normalise first, always.',
    sql: `SELECT
    count(DISTINCT subject)                                              AS raw_groups,
    count(DISTINCT lower(trim(subject)))                                 AS trimmed_and_folded,
    count(DISTINCT lower(trim(regexp_replace(subject, '^RE:\\s*', ''))))  AS also_stripping_re
FROM support_tickets;`,
  },
  {
    id: 'x-normalise', cat: 'text', title: 'Normalise, then group',
    note: 'Ten clean categories. Compare the n column against how fragmented the raw version was.',
    sql: `SELECT lower(trim(regexp_replace(subject, '^RE:\\s*', ''))) AS topic,
       count(*)                                          AS tickets,
       count(*) FILTER (WHERE priority = 'P1')           AS p1,
       round(avg(satisfaction), 2)                       AS avg_csat
FROM support_tickets
GROUP BY topic
ORDER BY tickets DESC;`,
  },
  {
    id: 'x-extract', cat: 'text', title: 'Pull order references out of free text and join on them',
    note: 'Bodies quote orders as ORD-000123, sometimes lowercase, sometimes without the dash. NULLIF turns a non-match into NULL so TRY_CAST does not explode.',
    sql: `WITH refs AS (
    SELECT ticket_id, customer_id, opened_ts,
           TRY_CAST(nullif(regexp_extract(upper(body), 'ORD-?([0-9]{6})', 1), '') AS INTEGER) AS order_ref
    FROM support_tickets
)
SELECT r.ticket_id, r.order_ref, o.status AS order_status, o.channel,
       r.customer_id AS ticket_customer, o.customer_id AS order_customer,
       r.customer_id <> o.customer_id AS customer_mismatch
FROM refs r
JOIN orders o ON o.order_id = r.order_ref
ORDER BY r.ticket_id
LIMIT 40;`,
  },
  {
    id: 'x-pii', cat: 'text', title: 'Find e-mail addresses and phone numbers in bodies',
    note: 'A crude PII sweep. regexp_extract returns the empty string when nothing matches, which is not the same as NULL -- hence the NULLIF.',
    sql: `SELECT ticket_id,
       nullif(regexp_extract(body, '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}', 0), '') AS email_found,
       nullif(regexp_extract(body, '\\+[0-9]{1,3} [0-9]{3} [0-9]{6}', 0), '')                  AS phone_found,
       length(body)                                                                          AS body_len
FROM support_tickets
WHERE regexp_matches(body, '@') OR regexp_matches(body, '\\+[0-9]')
ORDER BY ticket_id
LIMIT 40;`,
  },
  {
    id: 'x-funcs', cat: 'text', title: 'The string functions worth memorising',
    note: 'split_part, substring, position, replace, lpad, concat_ws and friends, all on one row so you can see what each does.',
    sql: `SELECT email,
       upper(split_part(email, '@', 1))          AS local_part,
       split_part(email, '@', 2)                 AS domain,
       position('@' IN email)                    AS at_position,
       length(email)                             AS len,
       lpad(CAST(customer_id AS VARCHAR), 6, '0') AS padded_id,
       concat_ws(' | ', country, coalesce(city, '?'), coalesce(segment, 'unsegmented')) AS label,
       left(full_name, 1) || '.' || split_part(full_name, ' ', 2) AS initial_surname
FROM customers
WHERE email IS NOT NULL
ORDER BY customer_id
LIMIT 20;`,
  },
  {
    id: 'x-sla', cat: 'text', title: 'Resolution time, and what to do about tickets that never closed',
    note: 'The open ones have a NULL closed_ts. Dropping them flatters your average; treating them as "still running as of now" is usually more honest. Both are here.',
    sql: `SELECT priority,
       count(*)                                                      AS tickets,
       count(*) FILTER (WHERE closed_ts IS NULL)                     AS still_open,
       round(avg(date_diff('hour', opened_ts, closed_ts)), 1)        AS avg_hours_closed_only,
       round(avg(date_diff('hour', opened_ts,
                 coalesce(closed_ts, TIMESTAMP '2026-09-14'))), 1)   AS avg_hours_censored_at_today,
       max(date_diff('hour', opened_ts, closed_ts))                  AS worst_closed
FROM support_tickets
GROUP BY priority
ORDER BY priority;`,
  },

  // ------------------------------------------------------------------ semi --
  {
    id: 's-peek', cat: 'semi', title: 'A LIST column, a STRUCT column and a raw payload',
    note: 'tags is a real list, client is a real struct, payload is JSON kept as text. Look at how each prints before querying it.',
    sql: `SELECT event_id, endpoint, status_code, tags, client, payload
FROM api_events
WHERE len(tags) > 1 AND payload IS NOT NULL
ORDER BY event_id
LIMIT 25;`,
  },
  {
    id: 's-struct', cat: 'semi', title: 'Reach into a STRUCT with dot notation',
    note: 'client.os is just a column expression -- it groups, filters and sorts like any other.',
    sql: `SELECT client.os          AS os,
       client.app_version  AS app_version,
       client.is_mobile    AS is_mobile,
       count(*)            AS calls,
       round(avg(latency_ms))                                     AS avg_latency,
       round(100.0 * count(*) FILTER (WHERE status_code >= 400) / count(*), 2) AS pct_errors
FROM api_events
GROUP BY ALL
ORDER BY calls DESC;`,
  },
  {
    id: 's-unnest', cat: 'semi', title: 'Explode a LIST into rows with UNNEST',
    note: 'One row per (event, tag). Note that rows with an empty tag list vanish entirely -- UNNEST of [] produces nothing, which is a quiet way to lose half your data.',
    sql: `SELECT tag, count(*) AS events,
       round(100.0 * count(*) / (SELECT count(*) FROM api_events), 2) AS pct_of_all_events
FROM (SELECT unnest(tags) AS tag FROM api_events)
GROUP BY tag
ORDER BY events DESC;`,
  },
  {
    id: 's-listfns', cat: 'semi', title: 'Query lists without exploding them',
    note: 'list_contains, len, list_position and array slicing all work in place -- usually faster and always simpler than an UNNEST plus a re-aggregate.',
    sql: `SELECT event_id, endpoint, status_code, tags,
       len(tags)                          AS n_tags,
       list_contains(tags, 'retry')       AS is_retry,
       list_position(tags, 'mobile')      AS mobile_at,
       tags[1]                            AS first_tag
FROM api_events
WHERE list_contains(tags, 'retry') AND status_code >= 500
ORDER BY event_id
LIMIT 30;`,
  },
  {
    id: 's-payload', cat: 'semi', title: 'Extract fields from a raw JSON payload with regex',
    note: 'No JSON functions needed. This is what you fall back to on an engine with no variant type -- and it is why a real JSON/SUPER column is worth asking for.',
    sql: `SELECT event_id, endpoint,
       TRY_CAST(nullif(regexp_extract(payload, '"amount":([0-9.]+)', 1), '') AS DECIMAL(12,2)) AS amount,
       nullif(regexp_extract(payload, '"currency":"([A-Z]{3})"', 1), '')                       AS currency,
       nullif(regexp_extract(payload, '"source":"([a-z]+)"', 1), '')                           AS source,
       payload
FROM api_events
WHERE http_method = 'POST' AND payload IS NOT NULL
ORDER BY amount DESC NULLS LAST
LIMIT 30;`,
  },
  {
    id: 's-build', cat: 'semi', title: 'Build lists and structs on the fly',
    note: 'Aggregating back into a list is how you collapse a one-to-many into one row without a fan-out.',
    sql: `SELECT c.customer_id, c.full_name,
       count(*)                                        AS n_cards,
       list(k.network ORDER BY k.network)              AS networks,
       list(DISTINCT k.status)                         AS statuses,
       {'first': min(k.issued_date), 'latest': max(k.issued_date)} AS issued_range
FROM customers c
JOIN cards k ON k.customer_id = c.customer_id
GROUP BY c.customer_id, c.full_name
HAVING count(*) > 1
ORDER BY c.customer_id
LIMIT 25;`,
  },
  {
    id: 's-retry', cat: 'semi', title: 'Retry storms: requests vs distinct idempotency keys',
    note: 'Failed POSTs get re-sent with the same idempotency_key. Counting requests over-reports volume; the gap between the two columns is the retry traffic.',
    sql: `SELECT idempotency_key,
       count(*)                                        AS attempts,
       min(event_ts)                                   AS first_attempt,
       max(event_ts)                                   AS last_attempt,
       CAST(date_diff('second', min(event_ts), max(event_ts)) AS INTEGER) AS span_seconds,
       list(status_code ORDER BY event_ts)             AS status_sequence
FROM api_events
WHERE idempotency_key IS NOT NULL
GROUP BY idempotency_key
HAVING count(*) > 1
ORDER BY attempts DESC, span_seconds
LIMIT 30;`,
  },
  {
    id: 's-incident', cat: 'semi', title: 'Find the outage days with a z-score',
    note: 'Three incident days were injected into this data. A z-score over the daily error count finds them -- and one borderline day that is just noise. Choosing the threshold is the judgement call.',
    sql: `WITH daily AS (
    SELECT CAST(event_ts AS DATE)                      AS day,
           count(*)                                    AS requests,
           count(*) FILTER (WHERE status_code >= 500)  AS errors
    FROM api_events
    GROUP BY 1
)
SELECT day, requests, errors,
       round(100.0 * errors / requests, 1)                                       AS pct_errors,
       round((errors - avg(errors) OVER ())
             / nullif(stddev_samp(errors) OVER (), 0), 2)                        AS z_score
FROM daily
QUALIFY z_score > 2
ORDER BY z_score DESC;`,
  },

  // -------------------------------------------------------------------- fx --
  {
    id: 'f-dim', cat: 'fx', title: 'The country dimension, and the markets with no customers',
    note: 'A dimension is normally wider than its facts. Five countries here have never had a customer -- an inner join would hide them, which is exactly when you want the outer one.',
    sql: `SELECT d.country, d.iso2, d.currency_code, d.region, d.is_eu,
       count(c.customer_id)                            AS customers,
       count(c.customer_id) = 0                        AS never_entered
FROM dim_country d
LEFT JOIN customers c ON c.country = d.country
GROUP BY ALL
ORDER BY customers DESC, d.country;`,
  },
  {
    id: 'f-gap', cat: 'fx', title: 'The weekend hole: an inner join on fx silently drops orders',
    note: 'Markets do not quote at weekends, so fx_rates has weekdays only. Joining on order_date = fx.day loses 193 of 700 orders without a single error message.',
    sql: `SELECT
    (SELECT count(*) FROM orders)                                               AS orders_total,
    (SELECT count(*) FROM orders o
        JOIN fx_rates f ON f.day = CAST(o.order_ts AS DATE) AND f.currency_code = 'EUR')
                                                                                AS kept_by_inner_join,
    (SELECT count(*) FROM orders o
      WHERE NOT EXISTS (SELECT 1 FROM fx_rates f
                         WHERE f.day = CAST(o.order_ts AS DATE)))                AS silently_dropped;`,
  },
  {
    id: 'f-asof', cat: 'fx', title: 'The fix: as-of lookup of the last quoted rate',
    note: 'Every order gets a rate, and a weekend order carries Friday rate -- which is what a finance team would actually do. Look at rate_age_days: 0 on a weekday, 1 on a Saturday, 2 on a Sunday. Note WHERE the currency is filtered: an ASOF join matches the single nearest row, so if you filter the currency in an outer WHERE it picks the nearest row of ANY currency first and then throws it away, and you get nothing back.',
    sql: `SELECT o.order_id,
       CAST(o.order_ts AS DATE)   AS order_date,
       dayname(o.order_ts)        AS order_dow,
       f.day                      AS rate_date,
       CAST(o.order_ts AS DATE) - f.day AS rate_age_days,
       f.currency_code, f.rate_to_usd,
       round(o.shipping_fee * f.rate_to_usd, 2) AS shipping_in_local
FROM orders o
ASOF JOIN (SELECT * FROM fx_rates WHERE currency_code = 'EUR') f
  ON f.day <= CAST(o.order_ts AS DATE)
ORDER BY rate_age_days DESC, o.order_id
LIMIT 30;`,
  },
  {
    id: 'f-convert', cat: 'fx', title: 'Revenue converted to each customer local currency',
    note: 'Three joins: order to customer, customer to country, country to rate. This is what a star schema is for.',
    sql: `SELECT dc.region, dc.country, dc.currency_code,
       count(*)                                     AS orders,
       round(sum(o.shipping_fee), 2)                AS shipping_usd,
       round(sum(o.shipping_fee * f.rate_to_usd), 2) AS shipping_local
FROM orders o
JOIN customers   c  ON c.customer_id = o.customer_id
JOIN dim_country dc ON dc.country    = c.country
ASOF JOIN fx_rates f ON f.currency_code = dc.currency_code
                    AND f.day <= CAST(o.order_ts AS DATE)
GROUP BY ALL
ORDER BY shipping_usd DESC;`,
  },
  {
    id: 'f-vol', cat: 'fx', title: 'Rate volatility over a gappy calendar',
    note: 'LAG over weekday-only rows gives the change since the previous TRADING day, not the previous calendar day. Around a Monday that is a three-day move.',
    sql: `SELECT day, currency_code, rate_to_usd,
       lag(rate_to_usd) OVER (PARTITION BY currency_code ORDER BY day)          AS prev_rate,
       day - lag(day) OVER (PARTITION BY currency_code ORDER BY day)            AS days_since_prev_quote,
       round(100.0 * (rate_to_usd - lag(rate_to_usd) OVER (PARTITION BY currency_code ORDER BY day))
             / nullif(lag(rate_to_usd) OVER (PARTITION BY currency_code ORDER BY day), 0), 3) AS pct_move
FROM fx_rates
WHERE currency_code = 'GBP' AND day >= DATE '2026-08-01'
ORDER BY day;`,
  },

  // ----------------------------------------------------------------- stats --
  {
    id: 'st-pct', cat: 'stats', title: 'Percentiles, and why the mean misleads',
    note: 'Transaction amounts are skewed. The mean sits well above the median; p95 and p99 are what an SLA or a fraud threshold should be built on.',
    sql: `SELECT count(*)                                  AS n,
       round(min(amount), 2)                      AS min,
       round(quantile_cont(amount, 0.25), 2)      AS p25,
       round(median(amount), 2)                   AS median,
       round(avg(amount), 2)                      AS mean,
       round(quantile_cont(amount, 0.95), 2)      AS p95,
       round(quantile_cont(amount, 0.99), 2)      AS p99,
       round(max(amount), 2)                      AS max,
       round(stddev_samp(amount), 2)              AS stddev
FROM transactions;`,
  },
  {
    id: 'st-hist', cat: 'stats', title: 'Histogram with a bar you can read',
    note: 'Bucket with floor(), then draw the bar with repeat(). Crude, effective, and works on any engine.',
    sql: `SELECT CAST(floor(amount / 25) * 25 AS INTEGER) AS bucket_low,
       CAST(floor(amount / 25) * 25 + 25 AS INTEGER) AS bucket_high,
       count(*)                                  AS n,
       repeat('#', CAST(count(*) / 40 AS INTEGER)) AS bar
FROM transactions
GROUP BY bucket_low, bucket_high
ORDER BY bucket_low;`,
  },
  {
    id: 'st-ntile', cat: 'stats', title: 'Decile customers by spend',
    note: 'NTILE splits into equal-sized buckets by count, not by value -- see how uneven decile_spend is. The extra subquery is not decoration: a window function is computed after grouping, so it cannot appear in GROUP BY and has to be materialised first.',
    sql: `WITH spend AS (
    SELECT customer_id, round(sum(amount), 2) AS total
    FROM transactions WHERE status = 'settled'
    GROUP BY customer_id
)
SELECT decile,
       count(*)                        AS customers,
       round(min(total), 2)            AS min_spend,
       round(max(total), 2)            AS max_spend,
       round(sum(total), 2)            AS decile_spend,
       round(100.0 * sum(total) / sum(sum(total)) OVER (), 1) AS pct_of_all_spend
FROM (SELECT total, ntile(10) OVER (ORDER BY total) AS decile FROM spend)
GROUP BY decile
ORDER BY decile;`,
  },
  {
    id: 'st-z', cat: 'stats', title: 'Z-score anomaly detection on a rolling baseline',
    note: 'Comparing each day against a trailing 30-day mean and standard deviation, not against the whole period -- otherwise a trend looks like an anomaly.',
    sql: `SELECT day, revenue,
       round(avg(revenue) OVER w, 2)                                     AS baseline_mean,
       round(stddev_samp(revenue) OVER w, 2)                             AS baseline_sd,
       round((revenue - avg(revenue) OVER w)
             / nullif(stddev_samp(revenue) OVER w, 0), 2)                AS z_score
FROM daily_revenue
WINDOW w AS (ORDER BY day ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING)
QUALIFY abs(z_score) > 2
ORDER BY abs(z_score) DESC
LIMIT 25;`,
  },
  {
    id: 'st-corr', cat: 'stats', title: 'Correlation and linear regression',
    note: 'Price and cost are near-perfectly correlated here, which is what you would expect from a fixed-margin catalogue. regr_slope gives the markup.',
    sql: `SELECT count(*)                                   AS n,
       round(corr(unit_price, unit_cost), 4)       AS correlation,
       round(regr_slope(unit_price, unit_cost), 4) AS slope,
       round(regr_intercept(unit_price, unit_cost), 4) AS intercept,
       round(regr_r2(unit_price, unit_cost), 4)    AS r_squared,
       round(covar_samp(unit_price, unit_cost), 2) AS covariance
FROM products;`,
  },
  {
    id: 'st-pareto', cat: 'stats', title: 'Pareto: how few customers make most of the money',
    note: 'A running share of the cumulative total, sorted descending. Read down the pct_cumulative column until it crosses 80.',
    sql: `WITH spend AS (
    SELECT customer_id, round(sum(amount), 2) AS total
    FROM transactions WHERE status = 'settled'
    GROUP BY customer_id
)
SELECT row_number() OVER (ORDER BY total DESC)                     AS rank,
       customer_id, total,
       round(100.0 * sum(total) OVER (ORDER BY total DESC ROWS UNBOUNDED PRECEDING)
             / sum(total) OVER (), 2)                              AS pct_cumulative,
       round(100.0 * row_number() OVER (ORDER BY total DESC)
             / count(*) OVER (), 2)                                AS pct_of_customers
FROM spend
ORDER BY total DESC
LIMIT 40;`,
  },

  // ----------------------------------------------------------------- write --
  {
    id: 'wr-ctas', cat: 'write', title: 'CREATE TABLE AS, then query it',
    note: 'Explore mode allows DDL and DML. Nothing here is permanent -- "Reset data" in the top bar rebuilds the whole warehouse from the seed file.',
    sql: `CREATE OR REPLACE TABLE my_customer_summary AS
SELECT c.customer_id,
       c.full_name,
       c.country,
       count(t.txn_id)                       AS txns,
       round(coalesce(sum(t.amount), 0), 2)  AS lifetime_value,
       max(t.txn_ts)                         AS last_seen
FROM customers c
LEFT JOIN transactions t ON t.customer_id = c.customer_id AND t.status = 'settled'
GROUP BY c.customer_id, c.full_name, c.country;

SELECT * FROM my_customer_summary ORDER BY lifetime_value DESC LIMIT 20;`,
  },
  {
    id: 'wr-dml', cat: 'write', title: 'INSERT, UPDATE, DELETE and check the damage',
    note: 'Run the whole script. Each statement runs in order and the last SELECT is what you see. "Reset data" undoes all of it.',
    sql: `CREATE OR REPLACE TABLE scratch_orders AS SELECT * FROM orders;

INSERT INTO scratch_orders
    (order_id, customer_id, order_ts, status, channel, shipping_fee, employee_id)
VALUES (999001, 1, TIMESTAMP '2026-09-14 10:00:00', 'pending', 'web', 4.99, NULL);

UPDATE scratch_orders SET status = 'cancelled'
WHERE status = 'pending' AND order_ts < TIMESTAMP '2025-06-01';

DELETE FROM scratch_orders WHERE status = 'returned';

SELECT status, count(*) AS n,
       (SELECT count(*) FROM orders o WHERE o.status = s.status) AS n_in_original
FROM scratch_orders s
GROUP BY status
ORDER BY n DESC;`,
  },
  {
    id: 'wr-view', cat: 'write', title: 'A view to save yourself retyping',
    note: 'Views cost nothing and are re-evaluated each time. Handy while exploring: define the join once, then query the view.',
    sql: `CREATE OR REPLACE VIEW v_order_detail AS
SELECT o.order_id, o.order_ts, o.status, o.channel,
       c.full_name, c.country, dc.region, dc.currency_code,
       i.item_no, p.product_name,
       i.quantity, i.unit_price, i.discount,
       round(i.quantity * i.unit_price * (1 - i.discount), 2) AS line_total
FROM orders o
JOIN customers   c  ON c.customer_id = o.customer_id
JOIN dim_country dc ON dc.country    = c.country
JOIN order_items i  ON i.order_id    = o.order_id
JOIN products    p  ON p.product_id  = i.product_id;

SELECT region, count(DISTINCT order_id) AS orders,
       round(sum(line_total), 2) AS revenue
FROM v_order_detail
GROUP BY region
ORDER BY revenue DESC;`,
  },

  // ------------------------------------------------------------------ meta --
  {
    id: 'm-explain', cat: 'meta', title: 'EXPLAIN: what the planner decided to do',
    note: 'Read it bottom-up. Look for the join order and whether a filter was pushed down into the scan.',
    sql: `EXPLAIN
SELECT c.country, count(*), round(sum(t.amount), 2)
FROM transactions t
JOIN customers c ON c.customer_id = t.customer_id
WHERE t.status = 'settled' AND t.txn_ts >= TIMESTAMP '2026-01-01'
GROUP BY c.country;`,
  },
  {
    id: 'm-analyze', cat: 'meta', title: 'EXPLAIN ANALYZE: what it actually cost',
    note: 'Runs the query and reports real timings and real row counts per operator. The gap between estimated and actual rows is where bad plans come from.',
    sql: `EXPLAIN ANALYZE
SELECT c.country, count(*), round(sum(t.amount), 2)
FROM transactions t
JOIN customers c ON c.customer_id = t.customer_id
WHERE t.status = 'settled'
GROUP BY c.country;`,
  },
  {
    id: 'm-describe', cat: 'meta', title: 'DESCRIBE a table or a query',
    note: 'DESCRIBE works on a query too, which is the quickest way to find out what type an expression came out as before you cast it.',
    sql: `DESCRIBE
SELECT customer_id,
       sum(amount)                      AS total,
       avg(amount)                      AS mean,
       count(*)                         AS n,
       list(DISTINCT status)            AS statuses,
       max(txn_ts)                      AS last_txn
FROM transactions
GROUP BY customer_id;`,
  },
  {
    id: 'm-fk', cat: 'meta', title: 'Audit referential integrity yourself',
    note: 'No engine here enforces foreign keys, so integrity is something you check, not something you are given. This counts orphans on every relationship at once.',
    sql: `SELECT 'transactions.customer_id -> customers' AS relationship,
       count(*) AS orphan_rows
FROM transactions t WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.customer_id = t.customer_id)
UNION ALL
SELECT 'order_items.order_id -> orders',
       count(*) FROM order_items i WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.order_id = i.order_id)
UNION ALL
SELECT 'orders.employee_id -> employees',
       count(*) FROM orders o WHERE o.employee_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.employee_id = o.employee_id)
UNION ALL
SELECT 'customers.country -> dim_country',
       count(*) FROM customers c WHERE NOT EXISTS (SELECT 1 FROM dim_country d WHERE d.country = c.country)
UNION ALL
SELECT 'api_events.customer_id -> customers',
       count(*) FROM api_events a WHERE a.customer_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.customer_id = a.customer_id)
ORDER BY orphan_rows DESC;`,
  },
  {
    id: 'm-funcs', cat: 'meta', title: 'Search the function catalogue',
    note: 'When you half-remember a function name, ask the database instead of the internet. Change the filter to hunt for anything.',
    sql: `SELECT function_name, function_type, return_type, parameters
FROM duckdb_functions()
WHERE function_name ILIKE '%date%'
ORDER BY function_name
LIMIT 60;`,
  },
];

/** Recipes for one category, in declaration order. */
export const recipesIn = (catId) => RECIPES.filter(r => r.cat === catId);
export const recipeById = (id) => RECIPES.find(r => r.id === id);
