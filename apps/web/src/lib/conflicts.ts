import type { Conflict } from './types';

/**
 * Merge conflicts as decisions people make. A card's builder settings (limit, dimension, measure…)
 * mirror its query, so when the query itself conflicts they follow its choice instead of being a
 * second, easy-to-mismatch question ("SQL says 10, the limit setting says 8").
 */
export interface ConflictGroup {
  /** Choices are recorded per path; picking a side for the group sets every path in it. */
  paths: string[];
  label: string;
  primary: Conflict;
  /** Settings that follow the primary choice. */
  linked: Conflict[];
}

const QUERY_MIRRORS = /^spec\.config\.(limit|dimension|dimension2|measure|metric|agg|filters|timeGrain)(\.|\[|$)/;

const LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  'spec.query.sql': 'SQL query',
  'spec.chart_type': 'Chart type',
  'spec.config.limit': 'Limit (top N)',
  'spec.config.scheme': 'Color scheme',
  'spec.config.dimension': 'Category',
  'spec.config.measure': 'Measure',
  'spec.data_source.version_id': 'Data source version',
};

export function conflictLabel(path: string): string {
  return LABELS[path]
    ?? path.replace(/^spec\./, '').replace(/^config\./, '').replace(/^query\./, 'Query › ').replaceAll('.', ' › ').replaceAll('_', ' ');
}

export function groupConflicts(conflicts: Conflict[]): ConflictGroup[] {
  const query = conflicts.find((c) => c.path === 'spec.query' || c.path.startsWith('spec.query.'));
  const groups: ConflictGroup[] = [];
  const queryGroup = query ? { paths: [query.path], label: conflictLabel(query.path), primary: query, linked: [] as Conflict[] } : null;
  for (const c of conflicts) {
    if (c === query) {
      groups.push(queryGroup!);
    } else if (queryGroup && QUERY_MIRRORS.test(c.path)) {
      queryGroup.linked.push(c);
      queryGroup.paths.push(c.path);
    } else {
      groups.push({ paths: [c.path], label: conflictLabel(c.path), primary: c, linked: [] });
    }
  }
  return groups;
}

/** Short display of one side's value. */
export function showValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
