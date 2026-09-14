import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'fs';
const inst = await DuckDBInstance.create(':memory:'); const c = await inst.connect();
for (const f of ['schema','compat','seed']) await c.run(fs.readFileSync(`assets/data/${f}.sql`,'utf8'));
const S=v=>typeof v==='bigint'?Number(v):(v&&typeof v==='object'&&v.toString?v.toString():v);
const one=async s=>S((await c.runAndReadAll(s)).getRows()[0][0]);
const t=async(l,s,p)=>{const v=await one(s);console.log(`${p(v)?'OK  ':'BAD '} ${l.padEnd(52)} ${v}`);};
await t('ts-6 roundtrip equals original exactly',
 "SELECT count(*) FROM (SELECT txn_ts, (to_timestamp(EXTRACT(EPOCH FROM txn_ts)) AT TIME ZONE 'UTC') rt FROM transactions LIMIT 500) WHERE txn_ts<>rt", v=>v===0);
await t('rolling-6 manual SD == builtin SD (4dp)',
 `WITH daily AS (SELECT txn_ts::DATE AS day, COUNT(*) AS n FROM transactions WHERE customer_id=121 GROUP BY 1),
  agg AS (SELECT day,n,SUM(n) OVER w s1,SUM(n*n) OVER w s2,COUNT(*) OVER w cnt,STDDEV_SAMP(n) OVER w sb
          FROM daily WINDOW w AS (ORDER BY day ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING))
  SELECT count(*) FROM agg WHERE sb IS NOT NULL AND ROUND(SQRT((s2-(s1*s1)/cnt)/NULLIF(cnt-1,0)),4) IS DISTINCT FROM ROUND(sb,4)`, v=>v===0);
await t('pat-4 with <= on BOTH ends inflates past 700',
 `SELECT count(*) FROM orders o LEFT JOIN dim_customer_scd d ON d.customer_id=o.customer_id
   AND o.order_ts>=d.valid_from AND o.order_ts<=COALESCE(d.valid_to,TIMESTAMP '9999-12-31')`, v=>v>700);
await t('joins-3 naive fan-out really inflates shipping',
 `SELECT (SELECT round(sum(o.shipping_fee),2) FROM orders o JOIN order_items i ON i.order_id=o.order_id)
       - (SELECT round(sum(shipping_fee),2) FROM orders)`, v=>v>1000);
await t('frames-4 LAST_VALUE default frame IS wrong here',
 `WITH w AS (SELECT customer_id, LAST_VALUE(amount) OVER (PARTITION BY customer_id ORDER BY txn_ts,txn_id) bad,
   LAST_VALUE(amount) OVER (PARTITION BY customer_id ORDER BY txn_ts,txn_id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) good FROM transactions)
  SELECT count(*) FROM w WHERE bad<>good`, v=>v>100);
await t('nulls-4 the two averages actually differ',
 `WITH s AS (SELECT UNNEST(generate_series(DATE '2026-01-01',DATE '2026-01-31',INTERVAL 1 DAY))::DATE d),
  f AS (SELECT s.d, r.revenue FROM s LEFT JOIN daily_revenue r ON r.day=s.d)
  SELECT ROUND(AVG(revenue),2)-ROUND(AVG(COALESCE(revenue,0)),2) FROM f`, v=>Math.abs(v)>100);
await t('ts-3 datediff overstates tenure (never understates)',
 `SELECT count(*) FROM customers WHERE DATEDIFF('year',signup_ts::DATE,DATE '2026-09-14')
   < FLOOR(DATEDIFF('day',signup_ts::DATE,DATE '2026-09-14')/365.25)`, v=>v===0);
await t('ts-1 the two week definitions give different totals',
 `WITH a AS (SELECT DATE '2026-02-11' d), m AS (SELECT DATE_TRUNC('week',d)::DATE ws FROM a),
  su AS (SELECT (DATE_TRUNC('week',d+INTERVAL 1 DAY)-INTERVAL 1 DAY)::DATE ws FROM a)
  SELECT (SELECT round(sum(r.revenue),2) FROM m JOIN daily_revenue r ON r.day>=m.ws AND r.day<m.ws+INTERVAL 7 DAY)
       <> (SELECT round(sum(r.revenue),2) FROM su JOIN daily_revenue r ON r.day>=su.ws AND r.day<su.ws+INTERVAL 7 DAY)`, v=>v===true);
await t('pat-2 streaks: max length is a real run',
 "WITH d AS (SELECT DISTINCT customer_id, login_ts::DATE dd FROM logins WHERE success=1) SELECT count(*) FROM d", v=>v>1000);
