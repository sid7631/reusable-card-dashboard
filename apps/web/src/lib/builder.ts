import type { CardConfig, ChartType } from './types';

/**
 * Generates the SQL stored with a card. The `{{filters}}` token is replaced
 * server-side with dashboard-level segment/period conditions at query time.
 */
export interface SqlTarget {
  table: string;
  dialect: 'postgres' | 'duckdb';
  /** Time dimension column (time-series axis), from the semantic model. */
  timeColumn: string | null;
  /** Whether the table has the columns the current dashboard filters bind to (segment, txn_date). */
  dashboardFilters: boolean;
}

export const DEMO_TARGET: SqlTarget = { table: 'transactions', dialect: 'postgres', timeColumn: 'txn_date', dashboardFilters: true };

const ident = (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`);

export function buildSql(chartType: ChartType, cfg: CardConfig, target: SqlTarget = DEMO_TARGET): string {
  const agg = cfg.agg ?? 'SUM';
  const metric = cfg.metric ?? 'amount';
  const aggExpr = agg === 'COUNT' ? 'COUNT(*)' : `${agg}(${ident(metric)})`;
  const table = ident(target.table);
  const filtersToken = target.dashboardFilters ? ' {{filters}}' : '';

  const where = (cfg.filters ?? [])
    .filter((f) => f.field && f.value)
    .map((f) => `AND ${ident(f.field)} = '${f.value.replaceAll("'", "''")}'`)
    .join(' ');
  const whereSql = where ? ` ${where}` : '';

  if (chartType === 'kpi') {
    return `SELECT ${aggExpr} AS value\nFROM ${table}\nWHERE 1=1${whereSql}${filtersToken}`;
  }

  const dim = cfg.dimension ?? 'industry';
  const isTime = dim === target.timeColumn;
  let dimExpr = ident(dim);
  if (isTime && cfg.timeGrain === 'month') {
    dimExpr = target.dialect === 'postgres' ? `to_char(${ident(dim)}, 'YYYY-MM')` : `strftime(${ident(dim)}, '%Y-%m')`;
  }
  if (dim === 'vintage' && target.table === 'transactions') dimExpr = `'Vintage ' || vintage`;

  const orderBy = isTime ? 'label ASC' : 'value DESC';
  const limit = cfg.limit ? `\nLIMIT ${cfg.limit}` : '';

  // Bar lists can carry a secondary category column (industry → sub-industry)
  const sub = chartType === 'barlist' && cfg.dimension2 && cfg.dimension2 !== dim ? cfg.dimension2 : undefined;
  const selectSub = sub ? `, ${ident(sub)} AS sublabel` : '';
  const groupBy = sub ? 'label, sublabel' : 'label';

  return `SELECT ${dimExpr} AS label${selectSub}, ${aggExpr} AS value\nFROM ${table}\nWHERE 1=1${whereSql}${filtersToken}\nGROUP BY ${groupBy}\nORDER BY ${orderBy}${limit}`;
}

/** Strip the filters token for ad-hoc preview runs (server also handles it). */
export function previewSql(sql: string): string {
  return sql.replaceAll('{{filters}}', '').trim();
}

export interface CopilotResult {
  message: string;
  chartType?: ChartType;
  config?: CardConfig;
  suggestedName?: string;
}

const SUGGESTIONS =
  'Try something like:\n• "Show industry spend as a bar chart"\n• "Top 5 merchants by charge volume"\n• "Monthly spend trend"\n• "Spend split by segment as a donut"\n• "Total spend KPI for Platinum"';

/** Mock Copilot — pattern-matches a prompt to a builder configuration. */
export function copilotRespond(prompt: string): CopilotResult {
  const p = prompt.toLowerCase();

  const wantsTrend = /\b(trend|over time|daily|monthly|time series|rolling)\b/.test(p);
  const wantsDonut = /\b(donut|pie|share|split|breakdown|proportion)\b/.test(p);
  const wantsKpi = /\b(kpi|total|overall|single number|headline)\b/.test(p);
  const topMatch = p.match(/top\s+(\d+)/);

  const product = ['platinum', 'gold', 'green'].find((x) => p.includes(x));
  const segment = ['uscs', 'gcs', 'ics'].find((x) => p.includes(x));
  const filters = [
    ...(product ? [{ field: 'product', value: product[0].toUpperCase() + product.slice(1) }] : []),
    ...(segment ? [{ field: 'segment', value: segment.toUpperCase() }] : []),
  ];
  const filterNote = filters.length ? ` filtered to ${filters.map((f) => f.value).join(' + ')}` : '';

  if (wantsKpi && !wantsTrend) {
    return {
      message: `Here's a KPI card showing total charge volume${filterNote}. It will respond to dashboard segment and period filters automatically.`,
      chartType: 'kpi',
      config: { metric: 'amount', agg: 'SUM', filters },
      suggestedName: `Total Spend${filterNote ? ` — ${filters.map((f) => f.value).join(' ')}` : ''}`,
    };
  }

  if (wantsTrend) {
    const monthly = /month/.test(p);
    return {
      message: `Done — a ${monthly ? 'monthly' : 'daily'} spend trend line${filterNote}. You can switch it to an area chart in the Builder tab if you prefer.`,
      chartType: 'line',
      config: { dimension: 'txn_date', timeGrain: monthly ? 'month' : 'day', metric: 'amount', agg: 'SUM', filters },
      suggestedName: `${monthly ? 'Monthly' : 'Daily'} Spend Trend`,
    };
  }

  const dims: [RegExp, string, string][] = [
    [/merchant|vendor/, 'merchant', 'Top Merchants by Charge Volume'],
    [/industr/, 'industry', 'Industry Spend'],
    [/product|card type/, 'product', 'Product Spend'],
    [/vintage|cohort/, 'vintage', 'Spend by Vintage'],
    [/geo|country|region/, 'country', 'Merchant Geography'],
    [/segment/, 'segment', 'Spend by Segment'],
    [/sub.?industr/, 'sub_industry', 'Sub-Industry Spend'],
  ];
  const hit = dims.find(([re]) => re.test(p));
  if (hit) {
    const [, dimension, name] = hit;
    const limit = topMatch ? Number(topMatch[1]) : dimension === 'merchant' ? 5 : undefined;
    const chartType: ChartType = wantsDonut ? 'donut' : 'barlist';
    const rank = chartType === 'barlist' && (Boolean(topMatch) || dimension === 'merchant');
    return {
      message: `Here you go — ${name.toLowerCase()}${limit ? ` (top ${limit})` : ''}${filterNote} as a ${chartType === 'barlist' ? 'bar list with YoY deltas' : 'donut chart'}. Tweak anything in the Builder tab, or hit Save to add it to your card library.`,
      chartType,
      config: { dimension, metric: 'amount', agg: 'SUM', limit, rank, filters },
      suggestedName: name,
    };
  }

  return { message: `I couldn't map that to a chart yet — this POC copilot knows spend dimensions like industry, product, merchant, geography, vintage and segment.\n\n${SUGGESTIONS}` };
}
