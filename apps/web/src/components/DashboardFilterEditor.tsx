import { useState } from 'react';
import { api } from '../lib/api';
import { useFilterable } from '../lib/queries';
import { dimensionLabel } from '../lib/filters';
import type { DashboardDetail, DashboardFilterDef } from '../lib/types';
import Modal from './Modal';

const PERIOD_DEFAULTS: [string, string][] = [['ytd', '2026 YTD'], ['all', 'All time'], ["Q1 '26", "Q1 '26"], ["Q2 '26", "Q2 '26"], ["FY '25", "FY '25"]];
const field = 'w-full rounded-md border border-line bg-white px-2 py-1.5 text-xs outline-none focus:border-accent';

/** Define the dashboard's filters: dimension, single/multi, parent (cascading), lock, defaults. */
export default function DashboardFilterEditor({ dashboard, onClose, onSaved }: {
  dashboard: DashboardDetail; onClose: () => void; onSaved: (d: DashboardDetail) => void;
}) {
  const [defs, setDefs] = useState<DashboardFilterDef[]>(dashboard.filters);
  const filterable = useFilterable(dashboard.id);
  const dims = filterable.data?.dimensions ?? [];
  const [saveError, setError] = useState<string>();
  const error = saveError ?? filterable.error?.message;
  const [saving, setSaving] = useState(false);


  const autoLabel = (dimension: string) => dims.find((x) => x.name === dimension)?.label ?? dimensionLabel(dimension);

  const period = defs.find((d) => d.kind === 'period');
  const dimensionFilters = defs.filter((d) => d.kind !== 'period');
  const update = (id: string, patch: Partial<DashboardFilterDef>) => setDefs((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const remove = (id: string) => setDefs((ds) => ds.filter((d) => d.id !== id).map((d) => (d.parent === id ? { ...d, parent: null } : d)));

  const add = () => {
    const unused = dims.find((d) => !defs.some((f) => f.dimension === d.name));
    if (!unused) return;
    let id = unused.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 40);
    while (defs.some((d) => d.id === id)) id += '_2';
    setDefs((ds) => [...ds.filter((d) => d.kind !== 'period'),
      { id, kind: 'select', dimension: unused.name, label: unused.label, parent: null, source_id: null, default: [], locked: false },
      ...ds.filter((d) => d.kind === 'period')]);
  };

  const togglePeriod = (on: boolean) => setDefs((ds) => on
    ? [...ds, { id: 'period', kind: 'period', dimension: '', label: 'Period', parent: null, source_id: null, default: ['ytd'], locked: false }]
    : ds.filter((d) => d.kind !== 'period'));

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      onSaved(await api.saveDashboardFilters(dashboard.id, defs));
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Modal xl title="Dashboard filters" subtitle="Filters apply to every card whose source has the dimension. Saving creates a new dashboard version." onClose={onClose}>
      <div className="max-h-[60vh] space-y-3 overflow-auto pr-1">
        {dimensionFilters.map((d) => (
          <div key={d.id} className="grid grid-cols-[1.2fr_1.2fr_0.9fr_1.1fr_auto_auto] items-end gap-2 rounded-xl border border-line p-3">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Label
              <input value={d.label} onChange={(e) => update(d.id, { label: e.target.value })} className={`${field} mt-1 normal-case`} />
            </label>
            <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Dimension
              <select value={d.dimension} onChange={(e) => update(d.id, {
                dimension: e.target.value, default: [],
                // A label that was just the old dimension's name follows the new one; a typed label stays
                ...(d.label === autoLabel(d.dimension) || !d.label ? { label: autoLabel(e.target.value) } : {}),
              })} className={`${field} mt-1 normal-case`}>
                {[...dims, ...(dims.some((x) => x.name === d.dimension) ? [] : [{ name: d.dimension, label: dimensionLabel(d.dimension), sources: [] }])].map((x) => (
                  <option key={x.name} value={x.name}>{x.label}{x.sources.length > 1 ? ` (${x.sources.length} sources)` : ''}</option>
                ))}
              </select>
            </label>
            <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Selection
              <select value={d.kind} onChange={(e) => update(d.id, { kind: e.target.value as 'select' | 'multi', default: d.default.slice(0, 1) })} className={`${field} mt-1 normal-case`}>
                <option value="select">Single</option><option value="multi">Multiple</option>
              </select>
            </label>
            <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Narrowed by
              <select value={d.parent ?? ''} onChange={(e) => update(d.id, { parent: e.target.value || null })} className={`${field} mt-1 normal-case`}>
                <option value="">— (top level)</option>
                {dimensionFilters.filter((p) => p.id !== d.id).map((p) => <option key={p.id} value={p.id}>{p.label || p.dimension}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5 pb-1.5 text-xs font-semibold text-ink-soft" title="Cards can't override a locked filter">
              <input type="checkbox" checked={d.locked} onChange={(e) => update(d.id, { locked: e.target.checked })} /> Lock
            </label>
            <button onClick={() => remove(d.id)} aria-label={`Remove ${d.label}`} className="mb-1 rounded-md p-1 text-ink-faint hover:bg-negative/10 hover:text-negative">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 3l10 10M13 3L3 13" /></svg>
            </button>
          </div>
        ))}
        <button onClick={add} disabled={!dims.some((d) => !defs.some((f) => f.dimension === d.name))}
          className="w-full rounded-xl border border-dashed border-accent/50 py-2 text-xs font-semibold text-accent transition enabled:hover:bg-accent-soft disabled:opacity-40">
          + Add filter
        </button>

        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
          <label className="flex items-center gap-2 text-sm font-semibold text-ink">
            <input type="checkbox" checked={Boolean(period)} onChange={(e) => togglePeriod(e.target.checked)} /> Period filter
          </label>
          {period && (
            <>
              <span className="text-xs text-ink-soft">Default</span>
              <select value={period.default[0] ?? 'ytd'} onChange={(e) => update(period.id, { default: [e.target.value] })} className={`${field} !w-auto`}>
                {PERIOD_DEFAULTS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
              <label className="flex items-center gap-1.5 text-xs font-semibold text-ink-soft">
                <input type="checkbox" checked={period.locked} onChange={(e) => update(period.id, { locked: e.target.checked })} /> Lock
              </label>
              <span className="text-[11px] text-ink-faint">Applies to each source's time dimension; also drives YoY.</span>
            </>
          )}
        </div>
      </div>
      {error && <p className="mt-3 text-sm text-negative">{error}</p>}
      <div className="mt-4 flex justify-end border-t border-line pt-4">
        <button onClick={save} disabled={saving} className="rounded-lg bg-accent px-5 py-2 font-display text-sm font-semibold text-white transition enabled:hover:bg-accent-deep disabled:opacity-50">
          {saving ? 'Saving…' : 'Save filters'}
        </button>
      </div>
    </Modal>
  );
}
