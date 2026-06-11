export type ChartType = 'kpi' | 'barlist' | 'bar' | 'column' | 'line' | 'area' | 'donut' | 'table';

export interface CardFilter {
  field: string;
  value: string;
}

export interface CardConfig {
  dimension?: string;
  /** Optional secondary category for bar lists (e.g. industry → sub-industry). */
  dimension2?: string;
  /** Show rank circles in bar lists (Top Merchants style). */
  rank?: boolean;
  timeGrain?: 'day' | 'month';
  metric?: string;
  agg?: 'SUM' | 'AVG' | 'COUNT';
  limit?: number;
  filters?: CardFilter[];
  /** Explicit axis mapping (set in SQL mode); falls back to inference when absent. */
  xKey?: string;
  yKeys?: string[];
  /** Color scheme id from SCHEMES; default 'classic'. */
  scheme?: string;
  /** Interactive filter controls rendered on the card itself. */
  controls?: {
    segment?: boolean;
    /** Which segment chips the toggle offers, e.g. ['ALL','GCS','ICS']. Default: all. */
    segmentOptions?: string[];
    period?: boolean;
    /** Which period granularities the dropdown offers. Default: all. */
    periodOptions?: ('month' | 'quarter' | 'year' | 'ytd')[];
  };
}

export interface Card {
  id: number;
  name: string;
  description: string;
  chart_type: ChartType;
  dataset: string;
  config: CardConfig;
  sql_text: string;
  created_via: 'builder' | 'sql' | 'copilot';
  created_at: string;
}

export interface Dashboard {
  id: number;
  name: string;
  description: string;
  created_at: string;
  card_count?: number;
}

export interface DashboardItem extends Card {
  item_id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardDetail extends Dashboard {
  items: DashboardItem[];
}

export interface Dataset {
  name: string;
  label: string;
  rowCount: number;
  columns: { name: string; type: string }[];
  dimensionValues: Record<string, string[]>;
}

export type Row = Record<string, unknown>;

export interface CardData {
  rows: Row[];
  meta: {
    prevValue?: number;
    deltaAbs?: number;
    deltaPct?: number;
    /** Same query run over the prior-year window — powers per-row YoY deltas. */
    prevRows?: Row[];
  };
}

export interface GlobalFilters {
  segment: string; // 'ALL' | 'USCS' | 'GCS' | 'ICS'
  subSegments?: string[]; // multi-select within GCS / ICS
  from?: string;
  to?: string;
  periodLabel: string;
}
