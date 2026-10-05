import type { Dimension, Measure, SemanticDataset, SemanticModel, TableInfo } from '../lib/types';

/**
 * Edits the semantic model: which tables are exposed, and for each column its business role
 * (dimension, time, measure) plus label and description. These names are what the card builder,
 * dashboard filters and — later — LLM tools see instead of raw columns.
 */

type Role = 'dimension' | 'time' | 'sum' | 'avg' | 'hidden';

const ROLES: [Role, string][] = [
  ['dimension', 'Dimension'], ['time', 'Time'], ['sum', 'Measure · sum'], ['avg', 'Measure · average'], ['hidden', 'Hidden'],
];

const NUMERIC = /int|numeric|decimal|double|real|float|money/i;
const TEMPORAL = /date|time/i;

const quoted = (col: string) => `"${col}"`;
const simpleAgg = (expr: string, col: string): 'sum' | 'avg' | null => {
  const m = expr.replace(/\s+/g, '').match(/^(SUM|AVG)\("?([^")]+)"?\)$/i);
  return m && m[2] === col ? (m[1].toUpperCase() === 'SUM' ? 'sum' : 'avg') : null;
};
const label = (name: string) => name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function roleOf(ds: SemanticDataset, col: string): Role {
  if (ds.time_dimension === col) return 'time';
  if (ds.dimensions.some((d) => d.column === col)) return 'dimension';
  const agg = ds.measures.map((m) => simpleAgg(m.expr, col)).find(Boolean);
  return agg ?? 'hidden';
}

function columnMeta(ds: SemanticDataset, col: string): { label: string; description: string } {
  const d = ds.dimensions.find((x) => x.column === col);
  const m = ds.measures.find((x) => simpleAgg(x.expr, col));
  return { label: d?.label ?? m?.label ?? '', description: d?.description ?? m?.description ?? '' };
}

function setColumn(ds: SemanticDataset, col: string, type: string, role: Role, meta: { label: string; description: string }): SemanticDataset {
  const dimensions = ds.dimensions.filter((d) => d.column !== col);
  const measures = ds.measures.filter((m) => !simpleAgg(m.expr, col));
  let time_dimension = ds.time_dimension === col ? null : ds.time_dimension;
  if (role === 'dimension' || role === 'time') {
    const dim: Dimension = {
      name: col, column: col, label: meta.label, description: meta.description,
      // Time columns keep their real kind: BigQuery won't compare a TIMESTAMP or DATETIME with a DATE
      type: role === 'time' || TEMPORAL.test(type)
        ? (/timestamp/i.test(type) ? 'timestamp' : /datetime/i.test(type) ? 'datetime' : /^date$/i.test(type.trim()) ? 'date' : 'timestamp')
        : NUMERIC.test(type) ? 'number' : 'string',
    };
    dimensions.push(dim);
    if (role === 'time') time_dimension = col;
  } else if (role === 'sum' || role === 'avg') {
    const m: Measure = {
      name: `${role === 'sum' ? 'total' : 'avg'}_${col}`, expr: `${role.toUpperCase()}(${quoted(col)})`,
      label: meta.label, description: meta.description, format: 'number',
    };
    measures.push(m);
  }
  return { ...ds, dimensions, measures, time_dimension };
}

export default function ModelEditor({ tables, model, suggested, onChange }: {
  tables: { name: string; row_count: number; columns: { name: string; type: string }[] }[];
  model: SemanticModel;
  /** Fallback when a table is switched on for the first time. */
  suggested?: SemanticModel;
  onChange: (model: SemanticModel) => void;
}) {
  const byName = new Map(model.datasets.map((d) => [d.name, d]));

  const update = (name: string, fn: (ds: SemanticDataset) => SemanticDataset) =>
    onChange({ datasets: model.datasets.map((d) => (d.name === name ? fn(d) : d)) });

  const toggle = (t: TableInfo, on: boolean) => {
    if (!on) return onChange({ datasets: model.datasets.filter((d) => d.name !== t.name) });
    const seed = suggested?.datasets.find((d) => d.name === t.name)
      ?? { name: t.name, label: label(t.name), description: '', time_dimension: null, dimensions: [], measures: [] };
    onChange({ datasets: [...model.datasets, seed] });
  };

  const field = 'w-full rounded-md border border-line bg-white px-2 py-1 text-xs outline-none focus:border-accent';

  return (
    <div className="space-y-4">
      {tables.map((t) => {
        const ds = byName.get(t.name);
        const columnNames = new Set(t.columns.map((c) => c.name));
        const custom = ds?.measures.filter((m) => !t.columns.some((c) => simpleAgg(m.expr, c.name))) ?? [];
        return (
          <div key={t.name} className={`rounded-xl border ${ds ? 'border-accent/40' : 'border-line'} bg-white`}>
            <label className="flex cursor-pointer items-center gap-3 px-4 py-3">
              <input type="checkbox" checked={Boolean(ds)} onChange={(e) => toggle(t, e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
              <span className="font-mono text-sm font-semibold text-ink">{t.name}</span>
              <span className="text-xs text-ink-faint">{t.row_count.toLocaleString()} rows · {t.columns.length} columns</span>
              {!ds && <span className="ml-auto text-[11px] text-ink-faint">Not exposed</span>}
            </label>

            {ds && (
              <div className="border-t border-line px-4 pb-4 pt-3">
                <div className="mb-3 grid grid-cols-2 gap-2">
                  <input value={ds.label} onChange={(e) => update(t.name, (d) => ({ ...d, label: e.target.value }))} placeholder="Business name" className={field} />
                  <input value={ds.description} onChange={(e) => update(t.name, (d) => ({ ...d, description: e.target.value }))} placeholder="What is one row?" className={field} />
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-left text-xs">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wide text-ink-faint">
                        <th className="py-1 pr-2 font-semibold">Column</th>
                        <th className="py-1 pr-2 font-semibold">Role</th>
                        <th className="py-1 pr-2 font-semibold">Label</th>
                        <th className="py-1 font-semibold">Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.columns.map((c) => {
                        const role = roleOf(ds, c.name);
                        const meta = columnMeta(ds, c.name);
                        return (
                          <tr key={c.name} className={role === 'hidden' ? 'opacity-60' : ''}>
                            <td className="py-1 pr-2">
                              <span className="font-mono text-ink">{c.name}</span>
                              <span className="ml-1.5 font-mono text-[10px] text-ink-faint">{c.type.toLowerCase()}</span>
                            </td>
                            <td className="py-1 pr-2">
                              <select value={role} aria-label={`Role of ${c.name}`}
                                onChange={(e) => update(t.name, (d) => setColumn(d, c.name, c.type, e.target.value as Role, { label: meta.label || label(c.name), description: meta.description }))}
                                className={field}>
                                {ROLES.filter(([r]) => !['sum', 'avg'].includes(r) || NUMERIC.test(c.type)).map(([r, text]) => <option key={r} value={r}>{text}</option>)}
                              </select>
                            </td>
                            <td className="py-1 pr-2">
                              <input value={meta.label} disabled={role === 'hidden'} aria-label={`Label of ${c.name}`}
                                onChange={(e) => update(t.name, (d) => setColumn(d, c.name, c.type, role, { ...meta, label: e.target.value }))} className={field} />
                            </td>
                            <td className="py-1">
                              <input value={meta.description} disabled={role === 'hidden'} aria-label={`Description of ${c.name}`}
                                onChange={(e) => update(t.name, (d) => setColumn(d, c.name, c.type, role, { ...meta, description: e.target.value }))} className={field} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {custom.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Other measures</p>
                    <ul className="flex flex-wrap gap-1.5">
                      {custom.map((m) => (
                        <li key={m.name} className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs">
                          <span className="font-semibold text-ink">{m.label || m.name}</span>
                          <span className="font-mono text-[10px] text-ink-faint">{m.expr}</span>
                          <button aria-label={`Remove ${m.name}`} onClick={() => update(t.name, (d) => ({ ...d, measures: d.measures.filter((x) => x.name !== m.name) }))}
                            className="text-ink-faint hover:text-negative">×</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {[...ds.dimensions.map((d) => d.column)].some((c) => !columnNames.has(c)) && (
                  <p className="mt-2 text-[11px] text-amber-700">Some modelled columns no longer exist in this table.</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
