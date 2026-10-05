import { api } from '../lib/api';
import { ancestors, setFilter, type FilterValues } from '../lib/filters';
import type { DashboardFilterDef } from '../lib/types';
import FilterSelect from './FilterSelect';
import PeriodSelect, { type Period } from './PeriodSelect';

/** Dashboard-level filters, rendered from the dashboard's filter definitions (cascading by parent). */
export default function FilterBar({ dashboardId, defs, values, period, onValues, onPeriod }: {
  dashboardId: number;
  defs: DashboardFilterDef[];
  values: FilterValues;
  period: Period | null;
  onValues: (v: FilterValues) => void;
  onPeriod: (p: Period) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {defs.map((def) => {
        if (def.kind === 'period') {
          return period && <PeriodSelect key={def.id} value={period} onChange={onPeriod} />;
        }
        const parents = ancestors(defs, def.id);
        const selections = Object.fromEntries(parents.filter((p) => values[p.id]?.length).map((p) => [p.id, values[p.id]]));
        return (
          <FilterSelect key={def.id} label={def.label || def.dimension} multi={def.kind === 'multi'}
            value={values[def.id] ?? []} onChange={(v) => onValues(setFilter(defs, values, def.id, v))}
            load={() => api.dashboardFilterOptions(dashboardId, def.id, selections).then((r) => r.values)}
            optionsKey={['dashboard', dashboardId, def.id, def.dimension, selections]}
            title={def.locked ? 'Locked — cards on this dashboard cannot override it' : undefined} />
        );
      })}
    </div>
  );
}
