// ===========================================================================
//  Deterministic seed generator for the NimbusPay practice warehouse.
//  Run:  node tools/gen_seed.mjs   ->  assets/data/seed.sql
//
//  Determinism matters: every exercise is graded by comparing your result set
//  to the reference query's result set, so the data must never drift.
//  Seeded PRNG only -- no Math.random(), no Date.now().
//
//  Where the data is deliberately awkward, the comment says WHICH exercise
//  depends on that awkwardness. Do not "clean up" the data without checking.
// ===========================================================================
import fs from 'fs';

// --- deterministic PRNG (mulberry32) ---------------------------------------
let _s = 0x9E3779B9;
function rnd() {
  _s |= 0; _s = (_s + 0x6D2B79F5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri   = (a, b) => a + Math.floor(rnd() * (b - a + 1));       // inclusive
const pick = (a)    => a[Math.floor(rnd() * a.length)];
const chance = (p)  => rnd() < p;
const r2   = (x)    => Math.round(x * 100) / 100;
// normal-ish via central limit, for money amounts
const gauss = (mu, sd) => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return mu + (s - 3) * sd; };

// --- date helpers (UTC throughout) -----------------------------------------
const DAY = 86400000;
const d2s = (ms) => new Date(ms).toISOString().slice(0, 10);
const t2s = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const mk  = (s)  => Date.parse(s + 'T00:00:00Z');

const START = mk('2025-01-01');          // event history starts
const END   = mk('2026-09-14');          // "today"
const NDAYS = Math.round((END - START) / DAY);

// --- SQL emit helpers -------------------------------------------------------
const out = [];
const q   = (v) => v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
const n   = (v) => v === null || v === undefined ? 'NULL' : String(v);
function emit(table, cols, rows) {
  if (!rows.length) return;
  out.push(`-- ${table}: ${rows.length} rows`);
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    out.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES`);
    out.push(chunk.map(r => '  (' + r.join(', ') + ')').join(',\n') + ';');
  }
  out.push('');
}

// ===========================================================================
// 1. dim_date  -- 2024-01-01 .. 2026-12-31
// ===========================================================================
const HOLIDAYS = {
  '01-01': 'New Year’s Day', '07-04': 'US Independence Day',
  '12-25': 'Christmas Day', '12-26': 'Boxing Day', '05-01': 'Labour Day',
  '11-26': 'Thanksgiving (US)', '10-03': 'German Unity Day', '08-15': 'Assumption',
};
const DOW_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
{
  const rows = [];
  for (let ms = mk('2024-01-01'); ms <= mk('2026-12-31'); ms += DAY) {
    const dt = new Date(ms);
    const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1, dom = dt.getUTCDate();
    const dowSun0 = dt.getUTCDay();                 // 0=Sun
    const isoDow  = dowSun0 === 0 ? 7 : dowSun0;    // 1=Mon..7=Sun
    const doy = Math.round((ms - mk(`${y}-01-01`)) / DAY) + 1;
    const monthStart = mk(`${y}-${String(mo).padStart(2,'0')}-01`);
    const monthEnd   = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0,10);
    const weekMon    = ms - (isoDow - 1) * DAY;
    const weekSun    = ms - dowSun0 * DAY;
    // ISO week number
    const th = ms + (4 - isoDow) * DAY;
    const isoWeek = Math.ceil(((th - mk(`${new Date(th).getUTCFullYear()}-01-01`)) / DAY + 1) / 7);
    const key = `${String(mo).padStart(2,'0')}-${String(dom).padStart(2,'0')}`;
    const hol = HOLIDAYS[key] || null;
    rows.push([
      q(d2s(ms)), y, Math.ceil(mo/3), mo, dom, doy, isoDow, dowSun0, q(DOW_NAMES[dowSun0]),
      isoDow <= 5 ? 1 : 0, hol ? 1 : 0, q(hol), q(d2s(monthStart)), q(monthEnd),
      q(d2s(weekMon)), q(d2s(weekSun)), isoWeek,
    ]);
  }
  emit('dim_date', ['day','year','quarter','month','day_of_month','day_of_year','iso_dow',
    'dow_sun0','day_name','is_weekday','is_holiday','holiday_name','month_start','month_end',
    'week_start_mon','week_start_sun','iso_week'], rows);
}

// ===========================================================================
// 2. departments + employees
//    "Legal" gets ZERO employees      -> anti-join / LEFT JOIN .. IS NULL
//    Some employees have NULL dept    -> NOT IN (subquery with NULL) trap
//    manager_id is 4 levels deep      -> recursive CTE
// ===========================================================================
const DEPTS = [
  [1,'Engineering','Berlin'], [2,'Data Science','Berlin'], [3,'Sales','Austin'],
  [4,'Marketing','London'], [5,'Support','Bengaluru'], [6,'Finance','Toronto'],
  [7,'Legal','London'],   // <-- intentionally empty
];
emit('departments', ['department_id','dept_name','location'],
  DEPTS.map(d => [d[0], q(d[1]), q(d[2])]));

const FIRST = ['Amara','Bjorn','Chen','Diya','Elif','Farid','Greta','Hiro','Ingrid','Jamal',
  'Kavya','Liam','Mira','Nikhil','Olive','Priya','Quinn','Rosa','Sven','Tara','Umar','Vera',
  'Wei','Xenia','Yusuf','Zara','Anton','Bianca','Caleb','Dalia','Emil','Fiona','Gabor','Hana',
  'Idris','Juno','Kiran','Lena','Marco','Nadia','Omar','Petra','Rafa','Sana','Tomas','Ulla',
  'Viktor','Wanda','Yara','Zeno'];
const LAST = ['Okafor','Lindqvist','Wu','Patel','Demir','Haddad','Schulz','Tanaka','Sorensen',
  'Rahman','Iyer','Byrne','Kovac','Menon','Barnes','Nair','Farrell','Alvarez','Nilsson','Raji',
  'Aziz','Novak','Zhang','Petrou','Celik','Khan','Muller','Rossi','Doyle','Haddadi','Berg',
  'Quinn','Nagy','Sato','Traore','Bell','Reddy','Fischer','Conti','Aslan'];
let nameIdx = 0;
const fullName = () => `${FIRST[(nameIdx * 7 + 3) % FIRST.length]} ${LAST[(nameIdx++ * 11 + 5) % LAST.length]}`;

const employees = [];
{
  // level 1: CEO
  employees.push({ id: 1, name: fullName(), dept: null, mgr: null, title: 'CEO', sal: 320000, hire: '2019-02-11' });
  // level 2: one head per real department (1..6)
  let id = 2;
  const heads = {};
  for (const [dId, dName] of DEPTS.slice(0, 6).map(d => [d[0], d[1]])) {
    heads[dId] = id;
    employees.push({ id: id++, name: fullName(), dept: dId, mgr: 1,
      title: `Head of ${dName}`, sal: r2(gauss(210000, 15000)), hire: `20${ri(19,21)}-0${ri(1,9)}-1${ri(0,9)}` });
  }
  // level 3: managers
  const mgrs = [];
  for (const dId of [1,1,2,3,3,4,5,6]) {
    mgrs.push(id);
    employees.push({ id: id++, name: fullName(), dept: dId, mgr: heads[dId],
      title: 'Manager', sal: r2(gauss(160000, 12000)), hire: `20${ri(20,22)}-0${ri(1,9)}-1${ri(0,9)}` });
  }
  // level 4: individual contributors
  const IC_TITLES = { 1:['Software Engineer','Senior Software Engineer','Staff Engineer'],
    2:['Data Scientist','Senior Data Scientist','ML Engineer','Analytics Engineer'],
    3:['Account Executive','Sales Development Rep'], 4:['Marketing Analyst','Content Strategist'],
    5:['Support Specialist','Support Lead'], 6:['Financial Analyst','Controller'] };
  while (id <= 48) {
    const m = pick(mgrs);
    const dId = employees.find(e => e.id === m).dept;
    employees.push({ id: id++, name: fullName(), dept: dId, mgr: m,
      title: pick(IC_TITLES[dId]), sal: r2(gauss(dId === 2 ? 145000 : 118000, 22000)),
      hire: `20${ri(21,25)}-${String(ri(1,12)).padStart(2,'0')}-${String(ri(1,28)).padStart(2,'0')}` });
  }
  // 3 contractors with NULL department_id -- the NOT IN trap depends on these
  for (const t of ['Contract Designer','Contract Recruiter','Contract Data Engineer']) {
    employees.push({ id: id++, name: fullName(), dept: null, mgr: 1, title: t,
      sal: r2(gauss(95000, 8000)), hire: `2025-0${ri(1,9)}-1${ri(0,9)}` });
  }
}
emit('employees', ['employee_id','full_name','department_id','manager_id','title','salary','hire_date'],
  employees.map(e => [e.id, q(e.name), n(e.dept), n(e.mgr), q(e.title), e.sal, q(e.hire)]));

// ===========================================================================
// 3. categories (hierarchy, 4 levels) + products
// ===========================================================================
const CATS = [
  [1,'All Products',null],
    [2,'Electronics',1], [3,'Computers',2], [4,'Laptops',3], [5,'Accessories',3],
    [6,'Audio',2], [7,'Headphones',6], [8,'Speakers',6],
    [9,'Wearables',2], [10,'Smartwatches',9], [11,'Fitness Trackers',9],
    [12,'Home',1], [13,'Kitchen',12], [14,'Cookware',13], [15,'Furniture',12],
    [16,'Office Chairs',15], [17,'Desks',15], [18,'Lighting',12],
    [19,'Outdoors',1], [20,'Camping',19], [21,'Cycling',19],
];
emit('categories', ['category_id','category_name','parent_id'],
  CATS.map(c => [c[0], q(c[1]), n(c[2])]));

const LEAF = [4,5,7,8,10,11,14,16,17,18,20,21];
const PROD_WORDS = ['Nimbus','Atlas','Vertex','Lumen','Cobalt','Harbor','Quartz','Ember','Drift',
  'Pinnacle','Aurora','Basalt','Cirrus','Dune','Fathom','Grove','Halcyon','Ionic','Juniper','Kestrel'];
const PROD_KIND = { 4:'Laptop',5:'Dock',7:'Headphones',8:'Speaker',10:'Watch',11:'Band',
  14:'Pan',16:'Chair',17:'Desk',18:'Lamp',20:'Tent',21:'Helmet' };
const products = [];
for (let pid = 1; pid <= 60; pid++) {
  const cat = LEAF[(pid * 5) % LEAF.length];
  const price = r2(Math.max(12, gauss(cat === 4 ? 1250 : cat === 17 ? 480 : 140, 90)));
  products.push({ id: pid, name: `${PROD_WORDS[(pid * 3) % PROD_WORDS.length]} ${PROD_KIND[cat]} ${ri(1,9)}00`,
    cat, price, cost: r2(price * (0.42 + rnd() * 0.24)),
    launched: d2s(mk('2024-01-01') + ri(0, 600) * DAY),
    disc: chance(0.12) ? 1 : 0 });
}
emit('products', ['product_id','product_name','category_id','unit_price','unit_cost','launched_on','discontinued'],
  products.map(p => [p.id, q(p.name), p.cat, p.price, p.cost, q(p.launched), p.disc]));

// ===========================================================================
// 4. customers -- segment/city NULLable on purpose
// ===========================================================================
const GEO = [
  ['Germany','Berlin','Europe/Berlin',60], ['Germany','Munich','Europe/Berlin',60],
  ['United States','New York','America/New_York',-300], ['United States','Austin','America/Chicago',-360],
  ['United States','San Francisco','America/Los_Angeles',-480], ['India','Bengaluru','Asia/Kolkata',330],
  ['India','Mumbai','Asia/Kolkata',330], ['United Kingdom','London','Europe/London',0],
  ['Canada','Toronto','America/Toronto',-300], ['France','Paris','Europe/Paris',60],
  ['Japan','Tokyo','Asia/Tokyo',540], ['Australia','Sydney','Australia/Sydney',600],
  ['Brazil','Sao Paulo','America/Sao_Paulo',-180], ['Spain','Madrid','Europe/Madrid',60],
];
const SEGMENTS = ['Consumer','Consumer','Consumer','SMB','SMB','Enterprise'];
const customers = [];
for (let cid = 1; cid <= 140; cid++) {
  const g = GEO[(cid * 3) % GEO.length];
  const signup = mk('2024-01-01') + ri(0, 800) * DAY + ri(0, 86399) * 1000;
  customers.push({
    id: cid, name: fullName(),
    // a few NULL emails -> COALESCE / IS NULL practice
    email: chance(0.06) ? null : `user${cid}@${pick(['example.com','mail.test','corp.example'])}`,
    country: g[0], city: chance(0.07) ? null : g[1],
    segment: chance(0.10) ? null : SEGMENTS[(cid * 7) % SEGMENTS.length],
    signup: t2s(signup), tz: g[2], off: g[3],
    active: chance(0.85) ? 1 : 0,
  });
}
emit('customers', ['customer_id','full_name','email','country','city','segment','signup_ts','tz_name','utc_offset_minutes','is_active'],
  customers.map(c => [c.id, q(c.name), q(c.email), q(c.country), q(c.city), q(c.segment),
    q(c.signup), q(c.tz), c.off, c.active]));

// ===========================================================================
// 5. cards + merchants
// ===========================================================================
const cards = [];
{
  let id = 1;
  for (const c of customers) {
    const k = chance(0.30) ? 2 : 1;
    for (let i = 0; i < k; i++)
      cards.push({ id: id++, cust: c.id, network: pick(['visa','mastercard','amex']),
        issued: d2s(mk('2023-06-01') + ri(0, 900) * DAY),
        status: chance(0.9) ? 'active' : pick(['blocked','expired']) });
  }
}
emit('cards', ['card_id','customer_id','network','issued_date','status'],
  cards.map(c => [c.id, c.cust, q(c.network), q(c.issued), q(c.status)]));

const MCAT = ['grocery','restaurant','travel','electronics','fuel','pharmacy','entertainment',
  'clothing','utilities','rideshare','hotel','digital_goods'];
const merchants = [];
for (let m = 1; m <= 24; m++)
  merchants.push({ id: m, name: `${PROD_WORDS[(m * 7) % PROD_WORDS.length]} ${pick(['Mart','Cafe','Travel','Store','Depot','Works'])}`,
    cat: MCAT[(m * 5) % MCAT.length], country: pick(['Germany','United States','United Kingdom','India','France']) });
emit('merchants', ['merchant_id','merchant_name','category','country'],
  merchants.map(m => [m.id, q(m.name), q(m.cat), q(m.country)]));

// ===========================================================================
// 6. transactions
//    * ~6 customers get an ANOMALY BURST window  -> problem #2 (z-score) needs
//      something to actually detect
//    * ~45 VELOCITY PAIRS: same card, <60s apart, different merchant category
//      -> problem #8
//    * deliberate same-timestamp ties -> the ROWS vs RANGE default-frame demo
// ===========================================================================
const txns = [];
{
  let id = 1;
  const burstCust = [7, 23, 48, 66, 91, 118];
  const burstStart = {};
  for (const bc of burstCust) burstStart[bc] = START + ri(200, NDAYS - 40) * DAY;

  for (const c of customers) {
    const myCards = cards.filter(x => x.cust === c.id);
    if (!myCards.length) continue;
    // ~12% of customers never transact -> anti-join practice
    if (chance(0.12)) continue;
    const rate = 0.03 + rnd() * 0.30;                // txns per day (tuned for file size)
    const signupMs = Date.parse(c.signup + 'Z');
    for (let d = 0; d < NDAYS; d++) {
      const dayMs = START + d * DAY;
      if (dayMs < signupMs) continue;
      let k = rnd() < rate % 1 ? Math.floor(rate) + 1 : Math.floor(rate);
      const inBurst = burstStart[c.id] && dayMs >= burstStart[c.id] && dayMs < burstStart[c.id] + 9 * DAY;
      if (inBurst) k += ri(4, 9);                     // the anomaly
      for (let j = 0; j < k; j++) {
        const card = pick(myCards);
        const ts = dayMs + ri(0, 86399) * 1000;
        txns.push({ id: id++, cust: c.id, card: card.id, merch: pick(merchants).id,
          ts: t2s(ts), amt: r2(Math.max(1.5, gauss(inBurst ? 210 : 62, inBurst ? 90 : 40))),
          status: chance(0.93) ? 'settled' : pick(['pending','reversed']) });
      }
      // ties: same customer, identical timestamp (batch settlement)
      if (chance(0.010)) {
        const ts = t2s(dayMs + 12 * 3600000);
        for (let j = 0; j < 3; j++)
          txns.push({ id: id++, cust: c.id, card: myCards[0].id, merch: pick(merchants).id,
            ts, amt: r2(Math.max(2, gauss(45, 20))), status: 'settled' });
      }
    }
  }
  // velocity fraud pairs
  const settled = txns.filter(t => t.status === 'settled');
  for (let i = 0; i < 45; i++) {
    const base = settled[Math.floor(rnd() * settled.length)];
    const baseCat = merchants.find(m => m.id === base.merch).cat;
    const other = merchants.filter(m => m.cat !== baseCat);
    const gapSec = ri(5, 55);                          // strictly under 60s
    txns.push({ id: id++, cust: base.cust, card: base.card, merch: pick(other).id,
      ts: t2s(Date.parse(base.ts + 'Z') + gapSec * 1000),
      amt: r2(Math.max(5, gauss(180, 70))), status: 'settled' });
  }
  txns.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id);
  txns.forEach((t, i) => t.id = i + 1);
}
emit('transactions', ['txn_id','customer_id','card_id','merchant_id','txn_ts','amount','status'],
  txns.map(t => [t.id, t.cust, t.card, t.merch, q(t.ts), t.amt, q(t.status)]));

// ===========================================================================
// 7. balance_snapshots -- irregular, NOT aligned to transactions (problem #4)
// ===========================================================================
{
  const rows = []; let id = 1;
  for (const c of customers) {
    if (chance(0.10)) continue;                       // some customers unsnapshot
    let bal = Math.max(50, gauss(2600, 1500));
    let ms = START + ri(0, 25) * DAY + ri(0, 86399) * 1000;
    while (ms < END) {
      rows.push([id++, c.id, q(t2s(ms)), r2(bal)]);
      bal = Math.max(-400, bal + gauss(0, 620));
      ms += (ri(18, 46) * DAY) + ri(0, 86399) * 1000;  // irregular cadence
    }
  }
  emit('balance_snapshots', ['snapshot_id','customer_id','snapshot_ts','balance'], rows);
}

// ===========================================================================
// 8. logins -- engineered streaks (problem #3)
// ===========================================================================
{
  const rows = []; let id = 1;
  for (const c of customers) {
    if (chance(0.15)) continue;
    let d = ri(0, 40);
    while (d < NDAYS) {
      const streak = chance(0.18) ? ri(6, 17) : ri(1, 3);   // long runs exist
      for (let s = 0; s < streak && d + s < NDAYS; s++) {
        const perDay = chance(0.18) ? 2 : 1;                 // dupes per day
        for (let k = 0; k < perDay; k++)
          rows.push([id++, c.id, q(t2s(START + (d + s) * DAY + ri(0, 86399) * 1000)),
            q(pick(['ios','android','web'])), chance(0.94) ? 1 : 0]);
      }
      d += streak + ri(6, 34);                              // then a gap
    }
  }
  emit('logins', ['login_id','customer_id','login_ts','device','success'], rows);
}

// ===========================================================================
// 9. clickstream -- sessions with gaps straddling 30 min (problem #6) + funnel
// ===========================================================================
{
  const rows = []; let id = 1;
  const FUNNEL = ['view_home','view_product','add_to_cart','begin_checkout','purchase'];
  for (const c of customers) {
    if (chance(0.18)) continue;
    const nSessions = ri(3, 26);
    for (let s = 0; s < nSessions; s++) {
      let ms = START + ri(0, NDAYS - 1) * DAY + ri(0, 80000) * 1000;
      // how deep into the funnel does this session get?
      let depth = 1;
      while (depth < 5 && chance([0, 0.62, 0.45, 0.58, 0.55][depth])) depth++;
      for (let e = 0; e < depth; e++) {
        const type = FUNNEL[e];
        const reps = type === 'view_product' ? ri(1, 4) : 1;
        for (let r = 0; r < reps; r++) {
          rows.push([id++, c.id, q(t2s(ms)), q(type),
            (type === 'view_product' || type === 'add_to_cart') ? pick(products).id : 'NULL']);
          // intra-session gap: mostly short, sometimes 25-45 min (straddles the
          // 30-minute timeout on BOTH sides -- that is the point)
          ms += (chance(0.12) ? ri(1500, 2700) : ri(8, 900)) * 1000;
        }
      }
    }
  }
  emit('clickstream', ['event_id','customer_id','event_ts','event_type','product_id'], rows);
}

// ===========================================================================
// 10. orders / order_items / payments -- the fan-out setup
// ===========================================================================
{
  const orders = [], items = [], pays = [];
  let oid = 1, pid = 1;
  const salesEmps = employees.filter(e => e.dept === 3).map(e => e.id);
  for (let i = 0; i < 700; i++) {
    const c = pick(customers);
    const ms = START + ri(0, NDAYS - 1) * DAY + ri(0, 86399) * 1000;
    const status = chance(0.72) ? 'completed' : pick(['shipped','pending','cancelled','returned']);
    const channel = pick(['web','web','mobile','mobile','phone','partner']);
    orders.push([oid, c.id, q(t2s(ms)), q(status), q(channel), r2(4.99 + rnd() * 16),
      channel === 'phone' ? pick(salesEmps) : 'NULL']);
    const nItems = ri(1, 5);                      // 1:many -> fan-out
    let total = 0;
    for (let k = 1; k <= nItems; k++) {
      const p = pick(products);
      const qty = ri(1, 6);
      const disc = pick([0, 0, 0, 0.05, 0.1, 0.15, 0.25]);
      items.push([oid, k, p.id, qty, p.price, disc]);
      total += p.price * qty * (1 - disc);
    }
    if (status !== 'cancelled' && status !== 'pending') {
      if (chance(0.12)) {                          // split payments
        const half = r2(total / 2);
        pays.push([pid++, oid, q(t2s(ms + ri(60, 3600) * 1000)), half, q(pick(['card','paypal']))]);
        pays.push([pid++, oid, q(t2s(ms + ri(4, 20) * DAY)), r2(total - half), q(pick(['card','bank_transfer']))]);
      } else {
        pays.push([pid++, oid, q(t2s(ms + ri(60, 7200) * 1000)), r2(total),
          q(pick(['card','card','paypal','bank_transfer','gift_card']))]);
      }
    }
    oid++;
  }
  emit('orders', ['order_id','customer_id','order_ts','status','channel','shipping_fee','employee_id'], orders);
  emit('order_items', ['order_id','item_no','product_id','quantity','unit_price','discount'], items);
  emit('payments', ['payment_id','order_id','paid_ts','amount','method'], pays);
}

// ===========================================================================
// 11. subscriptions -- problem #7 (daily active count), incl. win-backs
// ===========================================================================
{
  const rows = []; let id = 1;
  for (const c of customers) {
    if (chance(0.26)) continue;
    let cursor = START + ri(0, 240) * DAY;
    const spells = chance(0.22) ? 2 : 1;            // win-back = 2 spells
    for (let s = 0; s < spells && cursor < END; s++) {
      const plan = pick(['basic','basic','plus','pro']);
      const len = ri(60, 560);
      const endMs = cursor + len * DAY;
      const stillActive = endMs >= END;
      rows.push([id++, c.id, q(plan), q(d2s(cursor)), stillActive ? 'NULL' : q(d2s(endMs)),
        plan === 'basic' ? 9.99 : plan === 'plus' ? 24.99 : 79.0]);
      if (stillActive) break;
      cursor = endMs + ri(20, 120) * DAY;           // gap before win-back
    }
  }
  emit('subscriptions', ['subscription_id','customer_id','plan','start_date','end_date','mrr'], rows);
}

// ===========================================================================
// 12. dim_customer_scd -- contiguous HALF-OPEN versions (ref 4.4)
//     version N's valid_to == version N+1's valid_from, exactly.
//     Use <= on both ends and you double count. That is the exercise.
// ===========================================================================
{
  const rows = []; let id = 1;
  const SEG = ['Consumer','SMB','Enterprise','Churn Risk','VIP'];
  for (const c of customers) {
    const versions = chance(0.45) ? ri(2, 3) : 1;
    let from = Date.parse(c.signup + 'Z');
    for (let v = 0; v < versions; v++) {
      const last = v === versions - 1;
      const to = last ? null : from + ri(60, 300) * DAY;
      rows.push([id++, c.id, q(SEG[(c.id * 3 + v * 2) % SEG.length]), q(t2s(from)),
        to === null ? 'NULL' : q(t2s(to))]);
      if (to === null) break;
      from = to;                                    // contiguous, no gap
    }
  }
  emit('dim_customer_scd', ['scd_id','customer_id','segment_name','valid_from','valid_to'], rows);
}

// ===========================================================================
// 13. bookings -- deliberate overlaps per resource (ref 4.5)
// ===========================================================================
{
  const rows = []; let id = 1;
  for (let res = 1; res <= 8; res++) {
    let ms = START + ri(0, 30) * DAY;
    while (ms < END && id < 720) {
      const durMin = ri(30, 300);
      const start = ms + ri(0, 40000) * 1000;
      rows.push([id++, res, pick(customers).id, q(t2s(start)), q(t2s(start + durMin * 60000))]);
      // 35% of the time the next booking starts BEFORE this one ends -> overlap
      ms = chance(0.5) ? start + ri(5, durMin - 5) * 60000 : start + durMin * 60000 + ri(1, 40) * 3600000;
    }
  }
  emit('bookings', ['booking_id','resource_id','customer_id','start_ts','end_ts'], rows);
}

// ===========================================================================
// 14. daily_revenue -- WITH GAPS and ZERO days (ref 2.2 / 2.4)
// ===========================================================================
{
  const rows = [];
  let missing = 0, zeros = 0;
  for (let d = 0; d < NDAYS; d++) {
    const ms = START + d * DAY;
    const dow = new Date(ms).getUTCDay();
    // ~7% of days simply have NO ROW. ROWS 6 PRECEDING is then not 7 days.
    if (chance(0.07)) { missing++; continue; }
    const trend = 9000 + d * 7.5;
    const weekly = dow === 0 || dow === 6 ? -2600 : 900;
    let rev = Math.max(0, gauss(trend + weekly, 1500));
    if (chance(0.012)) { rev = 0; zeros++; }          // zero days -> NULLIF matters
    rows.push([q(d2s(ms)), r2(rev)]);
  }
  emit('daily_revenue', ['day','revenue'], rows);
  console.error(`daily_revenue: ${rows.length} rows, ${missing} missing days, ${zeros} zero days`);
}

// ===========================================================================
// 15. staging_customers -- duplicates for ROW_NUMBER dedup
// ===========================================================================
{
  const rows = []; let id = 1;
  for (const c of customers) {
    if (chance(0.55)) continue;
    const copies = chance(0.35) ? ri(2, 4) : 1;       // duplicate source rows
    let ms = Date.parse(c.signup + 'Z') + ri(1, 300) * DAY;
    for (let k = 0; k < copies; k++) {
      rows.push([id++, c.id, q(c.email), q(c.full_name ?? c.name),
        q(chance(0.08) ? null : c.country), q(t2s(ms))]);
      ms += ri(1, 60) * DAY;                          // later row = fresher
    }
  }
  emit('staging_customers', ['row_id','source_customer_id','email','full_name','country','updated_at'], rows);
}

// ===========================================================================
// 16. Boundary alignment for the SCD Type 2 lesson.
//
//  Half-open intervals only bite when a fact lands EXACTLY on a version
//  boundary. Random timestamps never do, which would make the lesson in
//  exercise pat-4 theoretical. So snap a deterministic ~2% of orders onto the
//  exact valid_to of one of their customer's SCD versions.
//
//  Effect: the CORRECT half-open join (>= from, < to) still returns 700 rows.
//  The INCORRECT closed join (<= on both ends) matches two versions for each
//  snapped order and returns more. That difference is the exercise.
// ===========================================================================
out.push(`-- snap a deterministic subset of orders onto exact SCD version boundaries
UPDATE orders
SET order_ts = m.boundary_ts
FROM (
    SELECT o.order_id, MIN(d.valid_to) AS boundary_ts
    FROM orders o
    JOIN dim_customer_scd d
      ON d.customer_id = o.customer_id
     AND d.valid_to IS NOT NULL
    WHERE o.order_id % 47 = 0
    GROUP BY o.order_id
) m
WHERE orders.order_id = m.order_id;
`);

// ===========================================================================
//  EXPLORE-MODE TABLES (sections 17-20)
//
//  These feed Explore mode rather than any graded exercise. They are generated
//  LAST, after every table above, so that the seeded PRNG stream consumed by
//  sections 1-16 is bit-for-bit unchanged and no reference result set drifts.
//  Add new tables here, at the end -- never in the middle.
// ===========================================================================

// ---------------------------------------------------------------------------
// 17. dim_country -- reference dimension, deliberately wider than the facts
// ---------------------------------------------------------------------------
const COUNTRIES = [
  // country,           iso2, ccy,   region, continent,       is_eu
  ['Germany',           'DE', 'EUR', 'EMEA', 'Europe',         1],
  ['United States',     'US', 'USD', 'AMER', 'North America',  0],
  ['India',             'IN', 'INR', 'APAC', 'Asia',           0],
  ['United Kingdom',    'GB', 'GBP', 'EMEA', 'Europe',         0],
  ['Canada',            'CA', 'CAD', 'AMER', 'North America',  0],
  ['France',            'FR', 'EUR', 'EMEA', 'Europe',         1],
  ['Japan',             'JP', 'JPY', 'APAC', 'Asia',           0],
  ['Australia',         'AU', 'AUD', 'APAC', 'Oceania',        0],
  ['Brazil',            'BR', 'BRL', 'AMER', 'South America',  0],
  ['Spain',             'ES', 'EUR', 'EMEA', 'Europe',         1],
  // No customers and no merchants in these five -- the anti-join has to find
  // something, otherwise "markets we have not entered" is an empty question.
  ['Mexico',            'MX', 'MXN', 'AMER', 'North America',  0],
  ['Italy',             'IT', 'EUR', 'EMEA', 'Europe',         1],
  ['Netherlands',       'NL', 'EUR', 'EMEA', 'Europe',         1],
  ['Singapore',         'SG', 'SGD', 'APAC', 'Asia',           0],
  ['Nigeria',           'NG', 'NGN', 'EMEA', 'Africa',         0],
];
emit('dim_country', ['country','iso2','currency_code','region','continent','is_eu'],
  COUNTRIES.map(c => [q(c[0]), q(c[1]), q(c[2]), q(c[3]), q(c[4]), c[5]]));

// ---------------------------------------------------------------------------
// 18. fx_rates -- WEEKDAYS ONLY. The weekend holes are the lesson: an inner
//     join on order_date = fx.day drops every Saturday and Sunday order.
//     A deterministic random walk, so rates move but never drift far.
// ---------------------------------------------------------------------------
const BASE_FX = {
  USD: 1, EUR: 0.921, GBP: 0.787, INR: 83.24, CAD: 1.361, JPY: 151.4,
  AUD: 1.523, BRL: 5.048, MXN: 17.12, SGD: 1.347, NGN: 1478.0,
};
{
  const rows = [];
  const cur = { ...BASE_FX };
  for (let ms = START; ms <= END; ms += DAY) {
    const dow = new Date(ms).getUTCDay();
    if (dow === 0 || dow === 6) continue;          // no weekend quotes
    for (const [ccy, base] of Object.entries(BASE_FX)) {
      if (ccy === 'USD') { rows.push([q(d2s(ms)), q('USD'), '1.000000']); continue; }
      // random walk with a pull back towards base, so it wanders but stays sane
      const drift = (base - cur[ccy]) * 0.02;
      cur[ccy] = cur[ccy] * (1 + (rnd() - 0.5) * 0.008) + drift;
      rows.push([q(d2s(ms)), q(ccy), cur[ccy].toFixed(6)]);
    }
  }
  emit('fx_rates', ['day','currency_code','rate_to_usd'], rows);
}

// ---------------------------------------------------------------------------
// 19. api_events -- LIST + STRUCT columns and a raw text payload.
//     Dense over the last 120 days, the way a request log actually is.
//     Contains: an error burst, retry storms sharing an idempotency_key,
//     empty tag lists, and NULL payloads.
// ---------------------------------------------------------------------------
const ENDPOINTS = [
  ['/v1/charges',        'POST',   0.34],
  ['/v1/charges',        'GET',    0.14],
  ['/v1/customers',      'GET',    0.16],
  ['/v1/customers',      'POST',   0.06],
  ['/v1/refunds',        'POST',   0.05],
  ['/v1/payouts',        'GET',    0.09],
  ['/v1/webhooks/test',  'POST',   0.06],
  ['/v1/balance',        'GET',    0.10],
];
const TAG_POOL = ['retry','mobile','beta','internal','rate_limited','webhook','sandbox','legacy_sdk'];
const OSES = [['ios','4.2.1',true],['ios','4.1.0',true],['android','4.2.0',true],
              ['android','3.9.7',true],['macos','2.0.3',false],['windows','2.0.1',false],
              ['linux','2.0.3',false]];
{
  const API_START = END - 120 * DAY;
  // Three incidents where the 5xx rate jumps from ~2% to ~45%. They last most
  // of a day on purpose: at ~35 events/day an hour-long blip would be two or
  // three rows, which no z-score could separate from noise. A day-long
  // incident is ~15 errors against a baseline of well under one.
  const BURSTS = [API_START + 27 * DAY + 5 * 3600000, API_START + 63 * DAY + 9 * 3600000,
                  API_START + 101 * DAY + 2 * 3600000];
  const inBurst = (ms) => BURSTS.some(b => ms >= b && ms < b + 18 * 3600000);

  const rows = [];
  let id = 1;
  for (let d = 0; d < 120; d++) {
    const dayStart = API_START + d * DAY;
    const dow = new Date(dayStart).getUTCDay();
    const n = (dow === 0 || dow === 6) ? ri(14, 24) : ri(28, 44);   // quieter at weekends
    for (let k = 0; k < n; k++) {
      // business-hours-weighted time of day
      const hour = chance(0.72) ? ri(8, 19) : ri(0, 23);
      const ms = dayStart + hour * 3600000 + ri(0, 3599) * 1000;

      let acc = rnd(), ep = ENDPOINTS[0];
      for (const e of ENDPOINTS) { acc -= e[2]; if (acc <= 0) { ep = e; break; } }
      const [endpoint, method] = ep;

      const burst = inBurst(ms);
      let status;
      if (burst && chance(0.45))      status = pick([500, 503, 500, 502]);
      else if (chance(0.045))         status = pick([400, 401, 404, 422, 429]);
      else if (chance(0.020))         status = pick([500, 503]);
      else                            status = method === 'POST' ? 201 : 200;

      // failures and cold paths are slow; the burst drags the whole tail out
      const base = status >= 500 ? gauss(900, 260) : status >= 400 ? gauss(120, 40) : gauss(altLatency(endpoint), 55);
      const latency = Math.max(3, Math.round(base * (burst ? 1.8 : 1)));

      const tags = [];
      if (chance(0.16)) tags.push('retry');
      if (chance(0.30)) tags.push('mobile');
      if (status === 429) tags.push('rate_limited');
      if (endpoint.includes('webhook')) tags.push('webhook');
      if (chance(0.08)) tags.push(pick(TAG_POOL));
      const uniqTags = [...new Set(tags)];         // some rows end up with []

      const os = pick(OSES);
      const cust = chance(0.09) ? null : ri(1, 140);   // unauthenticated calls
      const key = method === 'GET' ? null : `idem_${String(id).padStart(6, '0')}`;

      const payload = chance(0.08) ? null : (method === 'GET'
        ? `{"limit":${pick([10, 25, 50, 100])},"starting_after":${chance(0.5) ? 'null' : `"ch_${ri(1000, 9999)}"`}}`
        : `{"amount":${r2(gauss(74, 45) + 12).toFixed(2)},"currency":"${pick(['USD','EUR','GBP','INR'])}","source":"${pick(['card','bank','wallet'])}","livemode":${chance(0.8)}}`);

      rows.push({ id: id++, cust, ms, endpoint, method, status, latency, key, tags: uniqTags, os, payload });
    }
  }

  // Retry storms: a POST that failed is re-sent 1-3 times within a minute,
  // carrying the SAME idempotency_key. Counting "requests" instead of
  // "distinct idempotency_key" over-reports these, which is the point.
  const retries = [];
  for (const r of rows) {
    const failed = r.status >= 500 || r.status === 429;
    if (r.method === 'GET' || !failed || !chance(0.6)) continue;
    const k = ri(1, 3);
    for (let i = 1; i <= k; i++) {
      retries.push({ ...r, id: id++, ms: r.ms + i * ri(2, 20) * 1000,
        status: i === k && chance(0.7) ? 201 : r.status,
        tags: [...new Set([...r.tags, 'retry'])] });
    }
  }
  const all = [...rows, ...retries].sort((a, b) => a.ms - b.ms || a.id - b.id);

  const lit = (a) => a.length ? `[${a.map(t => `'${t}'`).join(', ')}]` : `[]`;
  emit('api_events',
    ['event_id','customer_id','event_ts','endpoint','http_method','status_code',
     'latency_ms','idempotency_key','tags','client','payload'],
    all.map(r => [
      r.id, n(r.cust), q(t2s(r.ms)), q(r.endpoint), q(r.method), r.status, r.latency,
      q(r.key), lit(r.tags),
      `{'os': '${r.os[0]}', 'app_version': '${r.os[1]}', 'is_mobile': ${r.os[2]}}`,
      q(r.payload),
    ]));
}
function altLatency(endpoint) {
  // /v1/payouts is the slow one -- gives "which endpoint is worst" a real answer
  if (endpoint === '/v1/payouts') return 310;
  if (endpoint === '/v1/charges') return 140;
  if (endpoint.includes('webhook')) return 220;
  return 85;
}

// ---------------------------------------------------------------------------
// 20. support_tickets -- deliberately messy human text.
//     Subjects carry inconsistent casing and padding; bodies embed real
//     order ids as ORD-000123 (and some malformed variants), e-mails and
//     phone numbers. closed_ts IS NULL means the ticket never closed.
// ---------------------------------------------------------------------------
const SUBJECTS = [
  'Refund not received', 'Card declined', 'Double charged', 'Cannot log in',
  'Wrong item shipped', 'Payout delayed', 'Update billing address',
  'Subscription cancelled by mistake', 'Invoice request', 'App crashes on checkout',
];
const BODY_OPEN = [
  'Hi team,', 'Hello,', 'hi', 'Good morning,', 'Hey there --', 'To whom it may concern,',
];
const BODY_MID = [
  'I placed an order last week and it still has not arrived.',
  'my card was charged twice for the same thing, please advise.',
  'The refund was promised within 5 business days and it has been 11.',
  'I cannot complete checkout, the app closes as soon as I press pay.',
  'Could you send me a VAT invoice for this please?',
  'the payout says pending but the dashboard shows it as sent.',
  'I was billed after cancelling. Please refund and confirm in writing.',
];
{
  const rows = [];
  const TK_START = mk('2025-06-01');
  const nTickets = 640;
  for (let i = 1; i <= nTickets; i++) {
    const cust = ri(1, 140);
    const opened = TK_START + ri(0, Math.round((END - TK_START) / DAY)) * DAY
                 + ri(6, 21) * 3600000 + ri(0, 3599) * 1000;
    const priority = chance(0.12) ? 'P1' : chance(0.45) ? 'P2' : 'P3';
    // P1s get closed fast; a slice of every priority never closes at all
    const stillOpen = chance(priority === 'P1' ? 0.05 : 0.14);
    const hours = priority === 'P1' ? gauss(5, 3) : priority === 'P2' ? gauss(29, 16) : gauss(74, 41);
    const closed = stillOpen ? null : opened + Math.max(1, Math.round(hours * 3600000));

    // subject: same handful of topics, but the casing and padding are a mess,
    // so GROUP BY subject gives ~30 groups and GROUP BY the trimmed, folded
    // form gives 10. That gap is the exercise.
    let subj = pick(SUBJECTS);
    if (chance(0.22)) subj = subj.toUpperCase();
    else if (chance(0.18)) subj = subj.toLowerCase();
    if (chance(0.25)) subj = '  ' + subj;
    if (chance(0.20)) subj = subj + '   ';
    if (chance(0.10)) subj = 'RE: ' + subj;

    const parts = [pick(BODY_OPEN), pick(BODY_MID)];
    // most bodies quote an order reference, in one of three spellings
    if (chance(0.78)) {
      const oid = ri(1, 700);
      const style = rnd();
      parts.push(style < 0.62 ? `Order ORD-${String(oid).padStart(6, '0')}.`
               : style < 0.85 ? `order ord-${String(oid).padStart(6, '0')} please.`
               : `ref ORD${String(oid).padStart(6, '0')}`);
    }
    if (chance(0.34)) parts.push(`You can reach me at user${cust}@${pick(['example.com','mail.test'])}.`);
    if (chance(0.22)) parts.push(`Phone: +${ri(1, 49)} ${ri(100, 999)} ${ri(100000, 999999)}`);
    parts.push(pick(['Thanks,', 'Regards,', 'thanks!', 'Best,']));

    rows.push([
      i, cust, q(t2s(opened)), closed === null ? 'NULL' : q(t2s(closed)),
      q(pick(['email', 'email', 'chat', 'phone'])), q(priority),
      q(subj), q(parts.join(' ')),
      closed === null || chance(0.18) ? 'NULL' : ri(1, 5),
    ]);
  }
  emit('support_tickets',
    ['ticket_id','customer_id','opened_ts','closed_ts','channel','priority',
     'subject','body','satisfaction'], rows);
}

// ---------------------------------------------------------------------------
const header = `-- =========================================================================
--  GENERATED FILE -- do not edit by hand.
--  Regenerate with:  node tools/gen_seed.mjs
--  Deterministic: the same seed always produces the same rows, because every
--  exercise is graded by comparing your result set against a reference query.
-- =========================================================================

`;
fs.writeFileSync('assets/data/seed.sql', header + out.join('\n'));
const bytes = fs.statSync('assets/data/seed.sql').size;
console.error(`seed.sql written: ${(bytes / 1048576).toFixed(2)} MB`);
