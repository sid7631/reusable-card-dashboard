export type ChartType = 'kpi' | 'barlist' | 'bar' | 'column' | 'line' | 'area' | 'donut' | 'table';

export interface CardFilter {
  field: string;
  value: string;
}

export interface CardConfig {
  /** Model measure name (semantic builder). Absent = ad-hoc `agg` of `metric`. */
  measure?: string;
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
    /** Dimensions viewers can re-filter on the card itself (override the dashboard). */
    filters?: string[];
    /** Legacy (pre-semantic) segment toggle — read as filters ['segment', 'sub_segment']. */
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
  /** Open change request that includes this asset. */
  pending_request_id: number | null;
  /** Set when this is a private copy of a global asset. */
  fork: ForkInfo | null;
}

export interface ForkInfo {
  asset_id: number;
  name: string;
  base_version_no: number;
  global_version_no: number;
  /** Global has moved on since this copy was made / last updated. */
  stale: boolean;
}

export interface Conflict {
  path: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
}

export interface RebasePreview {
  global_asset_id: number;
  base_version_no: number;
  global_version_no: number;
  stale: boolean;
  conflicts: Conflict[];
  incoming: SpecChange[];
  result: SpecChange[];
}

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface ChangeRequestSummary {
  id: number;
  status: RequestStatus;
  title: string;
  description: string;
  requested_by: number;
  requested_by_name: string;
  reviewed_by: number | null;
  reviewed_by_name: string | null;
  review_comment: string;
  root_asset_id: number;
  created_at: string;
  decided_at: string | null;
  root_kind?: 'card' | 'dashboard' | 'data_source';
  root_name?: string;
  item_count?: number;
}

export interface ChangeRequestItem {
  id: number;
  type: 'publish_new' | 'update_existing';
  kind: 'card' | 'dashboard' | 'data_source';
  position: number;
  source_asset_id: number;
  source_version_no: number;
  name: string;
  result_version_id: number | null;
  target_asset_id?: number;
  target_name?: string;
  base_version_no?: number;
  global_version_no?: number;
  stale: boolean;
  unchanged: boolean;
  changes: SpecChange[];
  conflicts: Conflict[];
}

export interface ChangeRequestDetail extends ChangeRequestSummary {
  items: ChangeRequestItem[];
  has_conflicts: boolean;
  can_approve: boolean;
  can_reject: boolean;
  can_withdraw: boolean;
  can_update: boolean;
}

export type MeasureRef = { name: string; label?: string } | { agg: 'SUM' | 'AVG' | 'COUNT' | 'MIN' | 'MAX' | 'COUNT_DISTINCT'; column?: string; label?: string };

/** Measures × dimensions in business terms — compiled server-side for the source's dialect. */
export interface SemanticQuery {
  mode: 'semantic';
  dataset: string;
  measures: MeasureRef[];
  dimensions: { name: string; grain?: 'day' | 'week' | 'month' | 'quarter' | 'year' }[];
  filters: { dimension: string; values: string[] }[];
  order?: 'value_desc' | 'value_asc' | 'label_asc' | 'label_desc';
  limit?: number;
}

export type CardQuery = { mode: 'sql'; sql: string } | SemanticQuery;

export interface Card extends AssetMeta {
  chart_type: ChartType;
  query: CardQuery;
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
  /** What the card's source can be filtered by. */
  filterable?: { dimensions: string[]; time: boolean };
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A dashboard filter control bound to a semantic dimension. */
export interface DashboardFilterDef {
  id: string;
  kind: 'select' | 'multi' | 'period';
  dimension: string;
  label: string;
  /** Cascading: options narrow to the parent's selection. */
  parent: string | null;
  source_id: number | null;
  default: string[];
  /** Cards may not override a locked filter. */
  locked: boolean;
}

export interface DashboardDetail extends Dashboard {
  items: DashboardItem[];
  filters: DashboardFilterDef[];
}

export interface VersionInfo {
  id: number;
  version_no: number;
  name: string;
  change_note: string;
  created_by: number;
  created_by_name: string;
  created_at: string;
  is_head: boolean;
}

export interface VersionDetail extends VersionInfo {
  description: string;
  spec: Record<string, unknown>;
}

export interface SpecChange {
  path: string;
  op: 'added' | 'removed' | 'changed';
  before: unknown;
  after: unknown;
  /** Unified line diff for multi-line text such as SQL. */
  lines: string[];
}

export interface VersionDiff {
  from: number;
  to: number;
  changes: SpecChange[];
  /** Dashboard placement id → card name. */
  labels: Record<string, string>;
}

export interface Share {
  user_id: number;
  name: string;
  email: string;
  permission: 'view' | 'edit';
  created_at: string;
}

export interface DirectoryEntry {
  id: number;
  name: string;
  email: string;
  role: string;
}

/** URL segment for each versioned asset kind. */
export type AssetKind = 'cards' | 'dashboards' | 'data-sources';

// ---------------------------------------------------------------- data sources
export type SourceType = 'postgres' | 'rest' | 'file' | 'bigquery';

export interface ColumnInfo { name: string; type: string }
export interface TableInfo { name: string; row_count: number; columns: ColumnInfo[] }

export interface Dimension { name: string; column: string; type: 'string' | 'number' | 'date' | 'datetime' | 'timestamp' | 'boolean'; label: string; description: string }
export const TEMPORAL_TYPES = ['date', 'datetime', 'timestamp'] as const;
export interface Measure { name: string; expr: string; label: string; description: string; format: 'number' | 'currency' | 'percent' }
export interface SemanticDataset {
  name: string;
  label: string;
  description: string;
  time_dimension: string | null;
  dimensions: Dimension[];
  measures: Measure[];
}
export interface SemanticModel { datasets: SemanticDataset[] }

export interface DataSourceSpec {
  type: SourceType;
  connection?: { host: string; port: number | string; database: string; user: string; secret_ref?: string | null } | null;
  rest?: {
    url: string;
    headers: Record<string, string>;
    query: Record<string, string>;
    auth: { type: 'none' | 'bearer' | 'api_key' | 'basic'; header: string; username: string; secret_ref?: string | null };
    records_path: string;
    pagination: { type: 'none' | 'page'; page_param: string; size_param: string | null; page_size: number; max_pages: number };
    table: string;
  } | null;
  file?: { file_id: number } | null;
  bigquery?: {
    project: string;
    dataset: string;
    location?: string | null;
    /** service_account: key JSON stored as a secret · adc: the server's own Google identity (admins only) */
    auth: 'service_account' | 'adc';
    secret_ref?: string | null;
    maximum_bytes_billed: number;
  } | null;
  execution: { max_concurrency: number; timeout_s: number; cache_ttl_s: number };
  model: SemanticModel;
}

export interface DataSource extends AssetMeta {
  type: SourceType;
  spec: DataSourceSpec;
  has_credentials: boolean;
}

export interface SourceTestResult {
  ok: boolean;
  tables: TableInfo[];
  sample?: Row[];
  suggested_model: SemanticModel;
}

export interface UploadResult {
  id: number;
  filename: string;
  format: 'csv' | 'xlsx' | 'json';
  size: number;
  tables: TableInfo[];
  suggested_model: SemanticModel;
}

export interface Dataset {
  /** Data-source asset id. */
  id: number;
  version_id: number;
  type: SourceType;
  dialect: 'postgres' | 'duckdb' | 'bigquery';
  tables: TableInfo[];
  model: SemanticModel;
  /** Set when the source could not be reached. */
  error?: string;
  /** Primary table. */
  name: string;
  label: string;
  rowCount: number;
  columns: { name: string; type: string }[];
  dimensionValues: Record<string, string[]>;
}

export type Row = Record<string, unknown>;

export interface CardData {
  rows: Row[];
  /** When the result was computed (epoch seconds) and whether it is past its freshness window. */
  as_of?: number;
  stale?: boolean;
  cached?: boolean;
  meta: {
    prevValue?: number;
    deltaAbs?: number;
    deltaPct?: number;
    /** Same query run over the prior-year window — powers per-row YoY deltas. */
    prevRows?: Row[];
    /** Filters the card's source could bind / could not bind (dimension names, or "period"). */
    applied?: string[];
    ignored?: string[];
  };
}

/** Filters applied to a card request: dimension values (business names) plus a time window. */
export interface AppliedFilters {
  dims: Record<string, string[]>;
  from?: string;
  to?: string;
}
