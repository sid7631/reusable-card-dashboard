import type { AppliedFilters, Card, DashboardFilterDef } from './types';
import type { Period } from '../components/PeriodSelect';

/** Selected values per filter id. Empty = all. */
export type FilterValues = Record<string, string[]>;

export function initialValues(defs: DashboardFilterDef[]): FilterValues {
  return Object.fromEntries(defs.filter((d) => d.kind !== 'period').map((d) => [d.id, d.default]));
}

export function ancestors(defs: DashboardFilterDef[], id: string): DashboardFilterDef[] {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const out: DashboardFilterDef[] = [];
  let cur = byId.get(id)?.parent;
  while (cur && byId.has(cur) && !out.some((d) => d.id === cur)) {
    out.push(byId.get(cur)!);
    cur = byId.get(cur)!.parent;
  }
  return out;
}

export function descendants(defs: DashboardFilterDef[], id: string): string[] {
  const kids = defs.filter((d) => d.parent === id).map((d) => d.id);
  return [...kids, ...kids.flatMap((k) => descendants(defs, k))];
}

/** Changing a filter clears its descendants — their options were narrowed by the old value. */
export function setFilter(defs: DashboardFilterDef[], values: FilterValues, id: string, next: string[]): FilterValues {
  const out = { ...values, [id]: next };
  for (const d of descendants(defs, id)) out[d] = [];
  return out;
}

export function toApplied(defs: DashboardFilterDef[], values: FilterValues, period: Period | null): AppliedFilters {
  const dims: Record<string, string[]> = {};
  for (const d of defs) {
    if (d.kind !== 'period' && values[d.id]?.length) dims[d.dimension] = values[d.id];
  }
  return { dims, from: period?.from, to: period?.to };
}

/** Dimensions a card lets viewers re-filter on the card itself. */
export function cardControlDims(card: Pick<Card, 'config'>): string[] {
  const c = card.config.controls;
  if (c?.filters?.length) return c.filters;
  return c?.segment ? ['segment', 'sub_segment'] : [];
}

export function summarize(dims: Record<string, string[]>): string {
  const parts = Object.entries(dims).filter(([, v]) => v.length).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v.join(', ')}`);
  return parts.length ? parts.join(' · ') : 'All';
}

export const dimensionLabel = (name: string) => name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
