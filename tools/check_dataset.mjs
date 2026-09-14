// Loads schema + compat + seed into DuckDB and sanity-checks the dataset.
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'fs';
const inst = await DuckDBInstance.create(':memory:');
const c = await inst.connect();
const S = (v) => typeof v === 'bigint' ? Number(v) : (v && typeof v === 'object' && v.toString ? v.toString() : v);
const rows = async (sql) => (await c.runAndReadAll(sql)).getRows().map(r => r.map(S));
const t0 = Date.now();
for (const f of ['assets/data/schema.sql', 'assets/data/compat.sql', 'assets/data/compat-tz.sql', 'assets/data/seed.sql']) {
  await c.run(fs.readFileSync(f, 'utf8'));
  console.log(`loaded ${f} (${Date.now() - t0} ms cumulative)`);
}
console.log('\n--- row counts ---');
const tabs = (await rows("SELECT table_name FROM information_schema.tables ORDER BY table_name")).map(r => r[0]);
for (const t of tabs) console.log('  ' + t.padEnd(20), (await rows(`SELECT count(*) FROM ${t}`))[0][0]);

console.log('\n--- signal checks (each exercise needs these to be non-trivial) ---');
// A failing invariant has to fail the BUILD, not just print a word. These
// assertions are the only thing standing between a generator tweak and a
// silently broken lesson.
let failed = 0;
const chk = async (label, sql, want) => {
  let v, ok;
  try { v = (await rows(sql))[0][0]; ok = want(v); }
  catch (e) { v = `ERROR: ${String(e.message).split('\n')[0].slice(0, 70)}`; ok = false; }
  if (!ok) failed++;
  console.log(`  ${ok ? 'OK  ' : 'BAD '} ${label.padEnd(46)} ${v}`);
};
await chk('empty department exists (anti-join)',
  "SELECT count(*) FROM departments d WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.department_id=d.department_id)", v=>v>=1);
await chk('employees with NULL dept (NOT IN trap)',
  "SELECT count(*) FROM employees WHERE department_id IS NULL", v=>v>=1);
await chk('NOT IN w/ NULL returns empty (the trap)',
  "SELECT count(*) FROM departments WHERE department_id NOT IN (SELECT department_id FROM employees)", v=>v===0);
await chk('manager hierarchy depth',
  "WITH RECURSIVE h AS (SELECT employee_id,1 lvl FROM employees WHERE manager_id IS NULL UNION ALL SELECT e.employee_id,h.lvl+1 FROM employees e JOIN h ON e.manager_id=h.employee_id) SELECT max(lvl) FROM h", v=>v>=4);
await chk('daily_revenue missing days (gap lesson)',
  "SELECT (SELECT count(*) FROM generate_series(DATE '2025-01-01', DATE '2026-09-13', INTERVAL 1 DAY)) - (SELECT count(*) FROM daily_revenue)", v=>v>20);
await chk('daily_revenue zero days (NULLIF lesson)',
  "SELECT count(*) FROM daily_revenue WHERE revenue=0", v=>v>=1);
await chk('same-timestamp ties (ROWS vs RANGE demo)',
  "SELECT count(*) FROM (SELECT customer_id,txn_ts FROM transactions GROUP BY 1,2 HAVING count(*)>1)", v=>v>10);
await chk('velocity pairs <60s, different category (#8)',
  `SELECT count(*) FROM (SELECT t.txn_id FROM transactions t JOIN transactions p ON p.card_id=t.card_id AND p.txn_ts<t.txn_ts AND p.txn_ts > t.txn_ts - INTERVAL 60 SECOND JOIN merchants mt ON mt.merchant_id=t.merchant_id JOIN merchants mp ON mp.merchant_id=p.merchant_id WHERE mt.category<>mp.category)`, v=>v>=30);
await chk('login streaks >= 6 days exist (#3)',
  `WITH d AS (SELECT DISTINCT customer_id, login_ts::DATE dd FROM logins), g AS (SELECT customer_id, dd, dd - (row_number() OVER (PARTITION BY customer_id ORDER BY dd))*INTERVAL 1 DAY k FROM d) SELECT max(cnt) FROM (SELECT count(*) cnt FROM g GROUP BY customer_id,k)`, v=>v>=6);
await chk('clickstream gaps straddling 30 min (#6)',
  `WITH g AS (SELECT customer_id, event_ts, lag(event_ts) OVER (PARTITION BY customer_id ORDER BY event_ts) p FROM clickstream) SELECT count(*) FROM g WHERE p IS NOT NULL AND event_ts > p + INTERVAL 30 MINUTE`, v=>v>100);
await chk('funnel reaches purchase',
  "SELECT count(*) FROM clickstream WHERE event_type='purchase'", v=>v>50);
await chk('snapshots precede txns (as-of, #4)',
  "SELECT count(*) FROM transactions t WHERE EXISTS (SELECT 1 FROM balance_snapshots b WHERE b.customer_id=t.customer_id AND b.snapshot_ts<=t.txn_ts)", v=>v>500);
await chk('SCD versions are contiguous half-open',
  `WITH x AS (SELECT customer_id, valid_to, lead(valid_from) OVER (PARTITION BY customer_id ORDER BY valid_from) nf FROM dim_customer_scd) SELECT count(*) FROM x WHERE valid_to IS NOT NULL AND valid_to <> nf`, v=>v===0);
await chk('SCD customers with >1 version',
  "SELECT count(*) FROM (SELECT customer_id FROM dim_customer_scd GROUP BY 1 HAVING count(*)>1)", v=>v>30);
await chk('overlapping bookings exist (4.5)',
  "SELECT count(*) FROM bookings a JOIN bookings b ON a.resource_id=b.resource_id AND a.booking_id<b.booking_id AND a.start_ts<b.end_ts AND b.start_ts<a.end_ts", v=>v>20);
await chk('win-back subs (2 spells, same customer)',
  "SELECT count(*) FROM (SELECT customer_id FROM subscriptions GROUP BY 1 HAVING count(*)>1)", v=>v>5);
await chk('active subs today (NULL end_date)',
  "SELECT count(*) FROM subscriptions WHERE end_date IS NULL", v=>v>10);
await chk('staging duplicates (dedup)',
  "SELECT count(*) FROM (SELECT source_customer_id FROM staging_customers GROUP BY 1 HAVING count(*)>1)", v=>v>10);
await chk('anomaly burst detectable by z-score (#2)',
  `WITH d AS (SELECT customer_id, txn_ts::DATE dd, count(*) n FROM transactions GROUP BY 1,2),
        w AS (SELECT *, avg(n) OVER (PARTITION BY customer_id ORDER BY dd ROWS BETWEEN 90 PRECEDING AND 1 PRECEDING) m,
                     stddev_samp(n) OVER (PARTITION BY customer_id ORDER BY dd ROWS BETWEEN 90 PRECEDING AND 1 PRECEDING) s FROM d)
   SELECT count(*) FROM w WHERE s>0 AND (n-m)/s > 3`, v=>v>=10);
await chk('customers with no transactions (anti-join)',
  "SELECT count(*) FROM customers c WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id=c.customer_id)", v=>v>=5);
await chk('fan-out inflates shipping_fee',
  "SELECT (SELECT round(sum(shipping_fee),2) FROM orders) <> (SELECT round(sum(o.shipping_fee),2) FROM orders o JOIN order_items i ON i.order_id=o.order_id)", v=>v===true||v==='true');
await chk('NULL segments / cities / emails exist',
  "SELECT (SELECT count(*) FROM customers WHERE segment IS NULL)+(SELECT count(*) FROM customers WHERE city IS NULL)+(SELECT count(*) FROM customers WHERE email IS NULL)", v=>v>10);
await chk('Snowflake compat: DATEADD runs',
  "SELECT count(*) FROM transactions WHERE txn_ts >= DATEADD('day',-30, TIMESTAMP '2026-09-14 00:00:00')", v=>v>10);
await chk('Snowflake compat: CONVERT_TIMEZONE DST-correct',
  "SELECT CONVERT_TIMEZONE('UTC','America/New_York', TIMESTAMP '2026-07-15 16:00:00') = TIMESTAMP '2026-07-15 12:00:00'", v=>v===true||v==='true');

// --- Explore-mode tables ---------------------------------------------------
// These four feed Explore mode rather than a graded exercise, but the recipes
// lean on the same deliberate awkwardness, so it gets asserted the same way.
console.log('\n--- explore-mode tables (dim_country, fx_rates, api_events, support_tickets) ---');

await chk('countries with no customers (anti-join)',
  "SELECT count(*) FROM dim_country d WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.country=d.country)", v=>v>=3);
await chk('every customer country is in dim_country',
  "SELECT count(*) FROM customers c WHERE NOT EXISTS (SELECT 1 FROM dim_country d WHERE d.country=c.country)", v=>v===0);
await chk('fx_rates has NO weekend quotes (the gap)',
  "SELECT count(*) FROM fx_rates WHERE dayofweek(day) IN (0,6)", v=>v===0);
await chk('orders on days with no fx rate (the trap)',
  "SELECT count(*) FROM orders o WHERE NOT EXISTS (SELECT 1 FROM fx_rates f WHERE f.day=CAST(o.order_ts AS DATE))", v=>v>=50);
await chk('USD is exactly 1.0 on every day',
  "SELECT count(*) FROM fx_rates WHERE currency_code='USD' AND rate_to_usd <> 1", v=>v===0);
await chk('as-of fx lookup reaches every order',
  "SELECT count(*) FROM orders o ASOF JOIN (SELECT * FROM fx_rates WHERE currency_code='EUR') f ON f.day <= CAST(o.order_ts AS DATE)", v=>v>=690);

await chk('api_events LIST column: empty lists exist',
  "SELECT count(*) FROM api_events WHERE len(tags)=0", v=>v>=100);
await chk('api_events STRUCT column is addressable',
  "SELECT count(DISTINCT client.os) FROM api_events", v=>v>=4);
await chk('api_events NULL payloads exist',
  "SELECT count(*) FROM api_events WHERE payload IS NULL", v=>v>=50);
await chk('payload fields are regex-extractable',
  "SELECT count(*) FROM api_events WHERE nullif(regexp_extract(payload,'\"currency\":\"([A-Z]{3})\"',1),'') IS NOT NULL", v=>v>=500);
await chk('retry storms: keys reused within a minute',
  "SELECT count(*) FROM (SELECT idempotency_key FROM api_events WHERE idempotency_key IS NOT NULL GROUP BY 1 HAVING count(*)>1)", v=>v>=20);
await chk('error bursts are findable by daily z-score',
  `WITH d AS (SELECT CAST(event_ts AS DATE) dy, count(*) FILTER (WHERE status_code>=500) e FROM api_events GROUP BY 1)
   SELECT count(*) FROM (SELECT (e-avg(e) OVER())/nullif(stddev_samp(e) OVER(),0) z FROM d) WHERE z > 2.5`, v=>v>=3);
await chk('one endpoint is clearly the slow one',
  "SELECT count(*) FROM (SELECT endpoint FROM api_events GROUP BY 1 HAVING quantile_cont(latency_ms,0.95) > 350)", v=>v>=1);

await chk('ticket subjects are messy (raw >> normalised)',
  "SELECT count(DISTINCT subject) FROM support_tickets", v=>v>=50);
await chk('ticket subjects normalise to ~10 topics',
  "SELECT count(DISTINCT lower(trim(regexp_replace(subject,'^RE:\\s*','')))) FROM support_tickets", v=>v>=8 && v<=14);
await chk('tickets still open (NULL closed_ts)',
  "SELECT count(*) FROM support_tickets WHERE closed_ts IS NULL", v=>v>=20);
await chk('ORD refs in bodies resolve to real orders',
  `SELECT count(*) FROM support_tickets t JOIN orders o
     ON o.order_id = TRY_CAST(nullif(regexp_extract(upper(t.body),'ORD-?([0-9]{6})',1),'') AS INTEGER)`, v=>v>=300);
await chk('P1 tickets close faster than P3',
  `SELECT (SELECT avg(date_diff('hour',opened_ts,closed_ts)) FROM support_tickets WHERE priority='P1')
        < (SELECT avg(date_diff('hour',opened_ts,closed_ts)) FROM support_tickets WHERE priority='P3')`, v=>v===true||v==='true');

console.log(`\ntotal load+check time: ${Date.now() - t0} ms`);
if (failed) {
  console.log(`\n${failed} dataset invariant${failed === 1 ? '' : 's'} BROKEN.`);
  process.exit(1);
}
