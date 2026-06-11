import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { DB_PATH, seed } from './seed.js';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
seed(db);

// Separate read-only connection for executing user-supplied SQL
const rodb = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const MAX_ROWS = 1000;

function sanitizeSql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('SQL is required.');
  const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
  if (statements.length !== 1) throw new Error('Exactly one SQL statement is allowed.');
  if (!/^(select|with)\b/i.test(statements[0])) throw new Error('Only SELECT queries are allowed.');
  return statements[0];
}

// Build the SQL fragment injected at the {{filters}} token from dashboard-level filters
function buildFilters({ segment, sub_segments, from, to }) {
  const parts = [];
  if (segment && segment !== 'ALL') {
    if (!/^[A-Za-z&\- ]{1,30}$/.test(segment)) throw new Error('Invalid segment.');
    parts.push(`AND segment = '${segment}'`);
  }
  if (sub_segments) {
    const list = String(sub_segments).split(',').map((s) => s.trim()).filter(Boolean);
    for (const s of list) {
      if (!/^[A-Za-z&\- ]{1,30}$/.test(s)) throw new Error('Invalid sub-segment.');
    }
    if (list.length) parts.push(`AND sub_segment IN (${list.map((s) => `'${s}'`).join(', ')})`);
  }
  for (const [key, op] of [[from, '>='], [to, '<=']]) {
    if (key) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('Invalid date.');
      parts.push(`AND txn_date ${op} '${key}'`);
    }
  }
  return parts.join(' ');
}

function runQuery(sql, filters = {}) {
  const prepared = sanitizeSql(sql).replaceAll('{{filters}}', buildFilters(filters));
  const stmt = rodb.prepare(prepared);
  if (!stmt.reader) throw new Error('Query must return rows.');
  const rows = stmt.all().slice(0, MAX_ROWS);
  return rows;
}

const asJson = (row) => row && { ...row, config: JSON.parse(row.config || '{}') };

// ---------- datasets ----------
app.get('/api/datasets', (_req, res) => {
  const columns = rodb.prepare(`PRAGMA table_info(transactions)`).all()
    .map((c) => ({ name: c.name, type: c.type }));
  const rowCount = rodb.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
  const dimensionValues = {};
  for (const dim of ['segment', 'sub_segment', 'industry', 'sub_industry', 'product', 'merchant', 'country', 'vintage']) {
    dimensionValues[dim] = rodb
      .prepare(`SELECT DISTINCT ${dim} AS v FROM transactions ORDER BY v`)
      .all()
      .map((r) => String(r.v));
  }
  res.json([{ name: 'transactions', label: 'Charge Transactions', rowCount, columns, dimensionValues }]);
});

// ---------- ad-hoc query (card studio preview) ----------
app.post('/api/query', (req, res) => {
  try {
    const t0 = performance.now();
    const rows = runQuery(req.body.sql, req.body.filters || {});
    res.json({ rows, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- cards ----------
app.get('/api/cards', (_req, res) => {
  res.json(db.prepare('SELECT * FROM cards ORDER BY id DESC').all().map(asJson));
});

app.get('/api/cards/:id', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found.' });
  res.json(asJson(card));
});

app.post('/api/cards', (req, res) => {
  const { name, description = '', chart_type, dataset = 'transactions', config = {}, sql_text, created_via = 'builder' } = req.body;
  if (!name || !chart_type || !sql_text) return res.status(400).json({ error: 'name, chart_type and sql_text are required.' });
  try {
    sanitizeSql(sql_text);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const info = db
    .prepare(`INSERT INTO cards (name, description, chart_type, dataset, config, sql_text, created_via) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(name, description, chart_type, dataset, JSON.stringify(config), sql_text, created_via);
  res.status(201).json(asJson(db.prepare('SELECT * FROM cards WHERE id = ?').get(info.lastInsertRowid)));
});

app.put('/api/cards/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Card not found.' });
  const { name = existing.name, description = existing.description, chart_type = existing.chart_type,
    config, sql_text = existing.sql_text, created_via = existing.created_via } = req.body;
  try {
    sanitizeSql(sql_text);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  db.prepare(`UPDATE cards SET name = ?, description = ?, chart_type = ?, config = ?, sql_text = ?, created_via = ? WHERE id = ?`)
    .run(name, description, chart_type, JSON.stringify(config ?? JSON.parse(existing.config)), sql_text, created_via, req.params.id);
  res.json(asJson(db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id)));
});

app.delete('/api/cards/:id', (req, res) => {
  db.prepare('DELETE FROM cards WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ---------- card data (used by dashboards & previews) ----------
app.get('/api/cards/:id/data', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found.' });
  const { segment, sub_segments, from, to } = req.query;
  try {
    const rows = runQuery(card.sql_text, { segment, sub_segments, from, to });
    const meta = {};
    // For KPI cards with a date window, compute same-window-last-year delta
    if (card.chart_type === 'kpi' && from && to) {
      const shift = (d) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
      try {
        const prevRows = runQuery(card.sql_text, { segment, sub_segments, from: shift(from), to: shift(to) });
        const cur = Number(Object.values(rows[0] ?? {})[0] ?? 0);
        const prev = Number(Object.values(prevRows[0] ?? {})[0] ?? 0);
        if (prev > 0) {
          meta.prevValue = prev;
          meta.deltaAbs = cur - prev;
          meta.deltaPct = ((cur - prev) / prev) * 100;
        }
      } catch {
        // YoY comparison is best-effort
      }
    }
    res.json({ rows, meta });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- dashboards ----------
app.get('/api/dashboards', (_req, res) => {
  res.json(db.prepare(`
    SELECT d.*, COUNT(dc.id) AS card_count
    FROM dashboards d LEFT JOIN dashboard_cards dc ON dc.dashboard_id = d.id
    GROUP BY d.id ORDER BY d.id DESC
  `).all());
});

app.post('/api/dashboards', (req, res) => {
  const { name, description = '' } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required.' });
  const info = db.prepare('INSERT INTO dashboards (name, description) VALUES (?, ?)').run(name, description);
  res.status(201).json(db.prepare('SELECT * FROM dashboards WHERE id = ?').get(info.lastInsertRowid));
});

app.get('/api/dashboards/:id', (req, res) => {
  const dashboard = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(req.params.id);
  if (!dashboard) return res.status(404).json({ error: 'Dashboard not found.' });
  const items = db.prepare(`
    SELECT dc.id AS item_id, dc.x, dc.y, dc.w, dc.h, c.*
    FROM dashboard_cards dc JOIN cards c ON c.id = dc.card_id
    WHERE dc.dashboard_id = ? ORDER BY dc.y, dc.x
  `).all(req.params.id).map((r) => ({ ...asJson(r) }));
  res.json({ ...dashboard, items });
});

// Replace the full card mapping + layout for a dashboard
app.put('/api/dashboards/:id/items', (req, res) => {
  const dashboard = db.prepare('SELECT id FROM dashboards WHERE id = ?').get(req.params.id);
  if (!dashboard) return res.status(404).json({ error: 'Dashboard not found.' });
  const items = req.body.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items array is required.' });
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM dashboard_cards WHERE dashboard_id = ?').run(dashboard.id);
    const ins = db.prepare('INSERT INTO dashboard_cards (dashboard_id, card_id, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?)');
    for (const it of items) {
      ins.run(dashboard.id, it.card_id, it.x ?? 0, it.y ?? 0, it.w ?? 4, it.h ?? 4);
    }
  });
  replace();
  res.json({ ok: true });
});

app.delete('/api/dashboards/:id', (req, res) => {
  db.prepare('DELETE FROM dashboards WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`SpendBoard API listening on http://localhost:${PORT}`));
