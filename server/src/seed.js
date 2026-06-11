import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = path.join(__dirname, '..', 'spendboard.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  txn_date TEXT NOT NULL,
  segment TEXT NOT NULL,
  sub_segment TEXT NOT NULL,
  industry TEXT NOT NULL,
  sub_industry TEXT NOT NULL,
  product TEXT NOT NULL,
  merchant TEXT NOT NULL,
  country TEXT NOT NULL,
  vintage INTEGER NOT NULL,
  amount REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_txn_segment ON transactions(segment);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  chart_type TEXT NOT NULL,
  dataset TEXT NOT NULL DEFAULT 'transactions',
  config TEXT NOT NULL DEFAULT '{}',
  sql_text TEXT NOT NULL,
  created_via TEXT NOT NULL DEFAULT 'builder',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dashboards (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dashboard_cards (
  id INTEGER PRIMARY KEY,
  dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  x INTEGER NOT NULL DEFAULT 0,
  y INTEGER NOT NULL DEFAULT 0,
  w INTEGER NOT NULL DEFAULT 4,
  h INTEGER NOT NULL DEFAULT 4
);
`;

const SEGMENTS = {
  USCS: ['Consumer', 'SBS'],
  GCS: ['SBS', 'MM', 'G&L'],
  ICS: ['Consumer', 'SBS', 'Corporate'],
};

// [name, industry, sub_industry, weight, lockedCountry?]
const MERCHANTS = [
  ['Amazon', 'G&S', 'Online-Retail', 10],
  ['Walmart', 'G&S', 'Retail-Shops', 8, 'US'],
  ['Stripe', 'B2B', 'Tech Services', 6],
  ['Apple', 'G&S', 'Retail-Shops', 5],
  ['Delta Air Lines', 'T&E', 'Airline', 5, 'US'],
  ['Marriott', 'T&E', 'Lodging', 4],
  ['Uber', 'T&E', 'Ground Transport', 4],
  ['Costco', 'G&S', 'Grocery', 4, 'US'],
  ['British Airways', 'T&E', 'Airline', 3, 'UK'],
  ['Tesco', 'G&S', 'Grocery', 3, 'UK'],
  ['Salesforce', 'B2B', 'Tech Services', 3],
  ['FedEx', 'B2B', 'Logistics', 3],
  ['Staples', 'B2B', 'Office Supplies', 2],
  ['Rakuten', 'G&S', 'Online-Retail', 2, 'Japan'],
  ['ANA', 'T&E', 'Airline', 2, 'Japan'],
];

const PRODUCTS = [
  ['Platinum', 5],
  ['Gold', 4],
  ['Green', 2],
  ['Business Platinum', 3],
  ['Corporate Card', 3],
];

const COUNTRIES = [
  ['US', 50], ['UK', 15], ['Japan', 10], ['Canada', 8],
  ['Germany', 7], ['India', 5], ['Australia', 5],
];

const VINTAGES = [
  [2021, 2], [2022, 3], [2023, 4], [2024, 5], [2025, 7], [2026, 8],
];

function weightedPick(rng, entries) {
  const total = entries.reduce((s, e) => s + e[e.length - 1 - (typeof e[e.length - 1] === 'string' ? 1 : 0)], 0);
  let r = rng() * total;
  for (const e of entries) {
    const w = typeof e[e.length - 1] === 'string' ? e[e.length - 2] : e[e.length - 1];
    r -= w;
    if (r <= 0) return e;
  }
  return entries[entries.length - 1];
}

// Deterministic PRNG so reseeding produces the same demo data
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START = new Date('2024-01-01T00:00:00Z');
const END = new Date('2026-06-11T00:00:00Z');
const DAY_MS = 86400000;
const TOTAL_DAYS = Math.floor((END - START) / DAY_MS);

export function seed(db, { force = false } = {}) {
  db.exec(SCHEMA);
  const txnCount = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
  if (txnCount > 0 && !force) return false;

  if (force) {
    db.exec('DELETE FROM dashboard_cards; DELETE FROM dashboards; DELETE FROM cards; DELETE FROM transactions;');
  }

  const rng = mulberry32(20260611);
  const insert = db.prepare(`
    INSERT INTO transactions (txn_date, segment, sub_segment, industry, sub_industry, product, merchant, country, vintage, amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const segmentNames = Object.keys(SEGMENTS);
  const insertMany = db.transaction(() => {
    for (let i = 0; i < 60000; i++) {
      const dayOffset = Math.floor(rng() * TOTAL_DAYS);
      const date = new Date(START.getTime() + dayOffset * DAY_MS);
      const txn_date = date.toISOString().slice(0, 10);

      const segment = segmentNames[Math.floor(rng() * segmentNames.length)];
      const subs = SEGMENTS[segment];
      const sub_segment = subs[Math.floor(rng() * subs.length)];

      const m = weightedPick(rng, MERCHANTS);
      const merchant = m[0];
      const industry = m[1];
      const sub_industry = m[2];
      const country = typeof m[4] === 'string' ? m[4] : weightedPick(rng, COUNTRIES)[0];

      const product = weightedPick(rng, PRODUCTS)[0];
      const vintage = weightedPick(rng, VINTAGES)[0];

      // Year-over-year growth baked in so YoY deltas look positive
      const year = date.getUTCFullYear();
      const growth = year === 2026 ? 1.35 : year === 2025 ? 1.15 : 1.0;
      const amount = Math.round((500 + rng() * rng() * 95000) * growth * 100) / 100;

      insert.run(txn_date, segment, sub_segment, industry, sub_industry, product, merchant, country, vintage, amount);
    }
  });
  insertMany();

  seedStarterContent(db);
  return true;
}

function builderSql({ dimensionExpr, limit, orderBy = 'value DESC', where = '' }) {
  return `SELECT ${dimensionExpr} AS label, SUM(amount) AS value
FROM transactions
WHERE 1=1${where ? ' ' + where : ''} {{filters}}
GROUP BY label
ORDER BY ${orderBy}${limit ? `\nLIMIT ${limit}` : ''}`;
}

function seedStarterContent(db) {
  const insertCard = db.prepare(`
    INSERT INTO cards (name, description, chart_type, dataset, config, sql_text, created_via)
    VALUES (@name, @description, @chart_type, 'transactions', @config, @sql_text, @created_via)
  `);

  const cards = [
    {
      name: 'Total AXP Spend',
      description: 'Enterprise-wide charge volume for the selected period.',
      chart_type: 'kpi',
      config: JSON.stringify({ metric: 'amount', agg: 'SUM' }),
      sql_text: `SELECT SUM(amount) AS value FROM transactions WHERE 1=1 {{filters}}`,
      created_via: 'builder',
    },
    {
      name: 'USCS Spend',
      description: 'US Consumer Services charge volume.',
      chart_type: 'kpi',
      config: JSON.stringify({ metric: 'amount', agg: 'SUM', filters: [{ field: 'segment', value: 'USCS' }] }),
      sql_text: `SELECT SUM(amount) AS value FROM transactions WHERE 1=1 AND segment = 'USCS' {{filters}}`,
      created_via: 'builder',
    },
    {
      name: 'GCS Spend',
      description: 'Global Commercial Services charge volume.',
      chart_type: 'kpi',
      config: JSON.stringify({ metric: 'amount', agg: 'SUM', filters: [{ field: 'segment', value: 'GCS' }] }),
      sql_text: `SELECT SUM(amount) AS value FROM transactions WHERE 1=1 AND segment = 'GCS' {{filters}}`,
      created_via: 'builder',
    },
    {
      name: 'ICS Spend',
      description: 'International Card Services charge volume.',
      chart_type: 'kpi',
      config: JSON.stringify({ metric: 'amount', agg: 'SUM', filters: [{ field: 'segment', value: 'ICS' }] }),
      sql_text: `SELECT SUM(amount) AS value FROM transactions WHERE 1=1 AND segment = 'ICS' {{filters}}`,
      created_via: 'builder',
    },
    {
      name: 'Industry Spend',
      description: 'Charge volume by industry, largest first.',
      chart_type: 'bar',
      config: JSON.stringify({ dimension: 'industry', metric: 'amount', agg: 'SUM', controls: { segment: true, period: true } }),
      sql_text: builderSql({ dimensionExpr: 'industry' }),
      created_via: 'builder',
    },
    {
      name: 'Product Spend',
      description: 'Charge volume by card product.',
      chart_type: 'bar',
      config: JSON.stringify({ dimension: 'product', metric: 'amount', agg: 'SUM' }),
      sql_text: builderSql({ dimensionExpr: 'product' }),
      created_via: 'builder',
    },
    {
      name: 'Spend by Vintage',
      description: 'Charge volume by card-member acquisition cohort.',
      chart_type: 'column',
      config: JSON.stringify({ dimension: 'vintage', metric: 'amount', agg: 'SUM' }),
      sql_text: builderSql({ dimensionExpr: "'Vintage ' || vintage", orderBy: 'label ASC' }),
      created_via: 'builder',
    },
    {
      name: 'Merchant Geography',
      description: 'Charge volume by merchant country.',
      chart_type: 'bar',
      config: JSON.stringify({ dimension: 'country', metric: 'amount', agg: 'SUM' }),
      sql_text: builderSql({ dimensionExpr: 'country' }),
      created_via: 'builder',
    },
    {
      name: 'Top Merchants by Charge Volume',
      description: 'Top five merchants ranked by total spend.',
      chart_type: 'bar',
      config: JSON.stringify({ dimension: 'merchant', metric: 'amount', agg: 'SUM', limit: 5 }),
      sql_text: builderSql({ dimensionExpr: 'merchant', limit: 5 }),
      created_via: 'builder',
    },
    {
      name: 'Spend Share by Segment',
      description: 'How charge volume splits across business segments.',
      chart_type: 'donut',
      config: JSON.stringify({ dimension: 'segment', metric: 'amount', agg: 'SUM' }),
      sql_text: builderSql({ dimensionExpr: 'segment' }),
      created_via: 'builder',
    },
    {
      name: 'Monthly Spend Trend by Product',
      description: 'Monthly charge volume for the three flagship consumer products.',
      chart_type: 'line',
      config: JSON.stringify({ dimension: 'txn_date', timeGrain: 'month', metric: 'amount', agg: 'SUM' }),
      sql_text: `SELECT strftime('%Y-%m', txn_date) AS label,
  SUM(CASE WHEN product = 'Platinum' THEN amount ELSE 0 END) AS Platinum,
  SUM(CASE WHEN product = 'Gold' THEN amount ELSE 0 END) AS Gold,
  SUM(CASE WHEN product = 'Green' THEN amount ELSE 0 END) AS Green
FROM transactions
WHERE 1=1 {{filters}}
GROUP BY label
ORDER BY label`,
      created_via: 'sql',
    },
    {
      name: 'Daily Spend — Rolling 90 Days',
      description: 'Daily charge volume over the trailing 90-day window.',
      chart_type: 'area',
      config: JSON.stringify({ dimension: 'txn_date', timeGrain: 'day', metric: 'amount', agg: 'SUM' }),
      sql_text: `SELECT txn_date AS label, SUM(amount) AS value
FROM transactions
WHERE txn_date >= date('2026-06-11', '-90 day') {{filters}}
GROUP BY label
ORDER BY label`,
      created_via: 'sql',
    },
  ];

  const ids = {};
  for (const c of cards) {
    const info = insertCard.run(c);
    ids[c.name] = info.lastInsertRowid;
  }

  const dash = db
    .prepare(`INSERT INTO dashboards (name, description) VALUES (?, ?)`)
    .run('Enterprise Spend Overview', 'Performance summary — spend by segment, industry, product, vintage and geography.');

  const placeItem = db.prepare(`
    INSERT INTO dashboard_cards (dashboard_id, card_id, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const layout = [
    ['Total AXP Spend', 0, 0, 3, 2],
    ['USCS Spend', 3, 0, 3, 2],
    ['GCS Spend', 6, 0, 3, 2],
    ['ICS Spend', 9, 0, 3, 2],
    ['Industry Spend', 0, 2, 4, 4],
    ['Product Spend', 4, 2, 4, 4],
    ['Spend by Vintage', 8, 2, 4, 4],
    ['Merchant Geography', 0, 6, 4, 4],
    ['Top Merchants by Charge Volume', 4, 6, 4, 4],
    ['Spend Share by Segment', 8, 6, 4, 4],
    ['Monthly Spend Trend by Product', 0, 10, 6, 4],
    ['Daily Spend — Rolling 90 Days', 6, 10, 6, 4],
  ];
  for (const [name, x, y, w, h] of layout) {
    placeItem.run(dash.lastInsertRowid, ids[name], x, y, w, h);
  }
}

// Allow running directly: `npm run seed`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const did = seed(db, { force: process.argv.includes('--force') });
  console.log(did ? 'Database seeded.' : 'Database already seeded — use --force to reseed.');
  db.close();
}
