import type { Layout } from 'react-grid-layout';
import { periodFromPreset, type Period } from '../components/PeriodSelect';
import { initialValues, type FilterValues } from './filters';
import type { Card, ChartType, DashboardDetail, DashboardItem } from './types';

/**
 * A dashboard page's local state: the layout being edited and the viewer's filter selections.
 * The dashboard itself comes from the query cache and arrives here through `loaded`.
 */
export interface DashboardEditorState {
  dashboard: DashboardDetail | null;
  items: DashboardItem[];
  /** Unsaved layout changes — server refreshes leave the layout alone while set. */
  dirty: boolean;
  editMode: boolean;
  filterValues: FilterValues;
  period: Period | null;
  /** Filter definitions the selections were initialised from; new definitions reset them. */
  filtersKey: string;
}

export type DashboardEditorAction =
  | { type: 'loaded'; dashboard: DashboardDetail }
  | { type: 'saved'; dashboard: DashboardDetail }
  | { type: 'setEditMode'; on: boolean }
  | { type: 'layoutChanged'; layout: Layout[] }
  | { type: 'addCard'; card: Card }
  | { type: 'removeCard'; cardId: number }
  | { type: 'setFilterValues'; values: FilterValues | ((v: FilterValues) => FilterValues) }
  | { type: 'setPeriod'; period: Period };

export const initialDashboardEditor: DashboardEditorState = {
  dashboard: null, items: [], dirty: false, editMode: false, filterValues: {}, period: null, filtersKey: '',
};

const DEFAULT_SIZE: Partial<Record<ChartType, { w: number; h: number }>> = {
  kpi: { w: 3, h: 2 },
};

const COLS = 12;

/** Top-left-most place on the 12-column grid where a w×h card fits without overlapping anything. */
export function firstFreeSpot(items: { x: number; y: number; w: number; h: number }[], { w, h }: { w: number; h: number }) {
  const bottom = items.reduce((m, it) => Math.max(m, it.y + it.h), 0);
  const free = (x: number, y: number) =>
    !items.some((it) => x < it.x + it.w && it.x < x + w && y < it.y + it.h && it.y < y + h);
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x + w <= COLS; x++) if (free(x, y)) return { x, y };
  }
  return { x: 0, y: bottom };
}

function withFilterDefaults(state: DashboardEditorState, d: DashboardDetail): DashboardEditorState {
  const key = JSON.stringify(d.filters);
  if (key === state.filtersKey) return state;
  const p = d.filters.find((f) => f.kind === 'period');
  return { ...state, filtersKey: key, filterValues: initialValues(d.filters), period: p ? periodFromPreset(p.default[0]) : null };
}

export function dashboardEditor(state: DashboardEditorState, action: DashboardEditorAction): DashboardEditorState {
  switch (action.type) {
    case 'loaded': {
      // Background refreshes update everything except a layout the user is still editing
      const next = { ...state, dashboard: action.dashboard, items: state.dirty ? state.items : action.dashboard.items };
      return withFilterDefaults(next, action.dashboard);
    }
    case 'saved':
      return withFilterDefaults({ ...state, dashboard: action.dashboard, items: action.dashboard.items, dirty: false }, action.dashboard);
    case 'setEditMode':
      return { ...state, editMode: action.on };
    case 'layoutChanged': {
      if (!state.editMode) return state;
      let changed = false;
      const items = state.items.map((it) => {
        const l = action.layout.find((n) => n.i === String(it.id));
        if (!l || (l.x === it.x && l.y === it.y && l.w === it.w && l.h === it.h)) return it;
        changed = true;
        return { ...it, x: l.x, y: l.y, w: l.w, h: l.h };
      });
      return changed ? { ...state, items, dirty: true } : state;
    }
    case 'addCard': {
      const size = DEFAULT_SIZE[action.card.chart_type] ?? { w: 4, h: 4 };
      return { ...state, items: [...state.items, { ...action.card, ...firstFreeSpot(state.items, size), ...size }], dirty: true };
    }
    case 'removeCard':
      return { ...state, items: state.items.filter((it) => it.id !== action.cardId), dirty: true };
    case 'setFilterValues':
      return { ...state, filterValues: typeof action.values === 'function' ? action.values(state.filterValues) : action.values };
    case 'setPeriod':
      return { ...state, period: action.period };
  }
}
