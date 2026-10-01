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

export type Scope = 'private' | 'global';
export type Access = 'admin' | 'owner' | 'edit' | 'view' | null;

/** Governance metadata shared by every versioned asset (cards, dashboards, data sources). */
export interface AssetMeta {
  id: number;
  name: string;
  description: string;
  scope: Scope;
  owner_id: number | null;
  owner_name: string | null;
  /** The caller's access level — drives what the UI lets them do. */
  access: Access;
  can_edit: boolean;
  version_id: number;
  version_no: number;
  head_version_id: number;
  forked_from_asset_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface Card extends AssetMeta {
  chart_type: ChartType;
  dataset: string;
  data_source_id: number;
  data_source_version_id: number;
  config: CardConfig;
  sql_text: string;
  created_via: 'builder' | 'sql' | 'copilot';
}

export interface Dashboard extends AssetMeta {
  card_count?: number;
}

export interface DashboardItem extends Card {
  /** Stable id of the placement within the dashboard. */
  item_id?: string;
  /** Card version pinned by this dashboard version. */
  card_version_id?: number;
  latest_version_id?: number;
  update_available?: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardDetail extends Dashboard {
  items: DashboardItem[];
}

export interface VersionInfo {
  id: number;
  version_no: number;
  name: string;
  change_note: string;
  created_by: number;
  created_by_name: string;
  created_at: string;
}

export interface Dataset {
  /** Data-source asset id. */
  id: number;
  version_id: number;
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
