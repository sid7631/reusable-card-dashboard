import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createRenderBatcher, RenderContext } from '../lib/render';
import { Link, useNavigate, useParams } from 'react-router-dom';
import RGL, { WidthProvider, type Layout } from 'react-grid-layout';
import { api } from '../lib/api';
import type { AppliedFilters, Card, CardData, ChartType, DashboardDetail, DashboardFilterDef, DashboardItem } from '../lib/types';
import { cardControlDims, dimensionLabel, initialValues, summarize, toApplied, type FilterValues } from '../lib/filters';
import ChartRenderer from '../components/ChartRenderer';
import CardFrame from '../components/CardFrame';
import PeriodSelect, { periodFromPreset, type Period } from '../components/PeriodSelect';
import FilterSelect from '../components/FilterSelect';
import FilterBar from '../components/FilterBar';
import DashboardFilterEditor from '../components/DashboardFilterEditor';
import type { CardContext } from '../components/CardActions';
import AssetBadges from '../components/AssetBadges';
import VersionHistory from '../components/VersionHistory';
import ShareDialog from '../components/ShareDialog';
import GovernanceBar from '../components/GovernanceBar';

const Grid = WidthProvider(RGL);

const DEFAULT_SIZE: Partial<Record<ChartType, { w: number; h: number }>> = {
  kpi: { w: 3, h: 2 },
};

function DashboardCard({ card, dashboardId, defs, applied, period, editMode, onRemove }: {
  card: DashboardItem;
  dashboardId: number;
  defs: DashboardFilterDef[];
  /** Dashboard-level filters (business dimension names) — the card may override unlocked ones. */
  applied: AppliedFilters;
  period: Period | null;
  editMode: boolean;
  onRemove: () => void;
}) {
  const [data, setData] = useState<CardData>({ rows: [], meta: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const batcher = useContext(RenderContext);
  const [recheck, setRecheck] = useState(0);

  // Card-level overrides (absent = follow the dashboard); reset whenever the dashboard filters change
  const [dimOverrides, setDimOverrides] = useState<Record<string, string[]>>({});
  const [perOverride, setPerOverride] = useState<Period | null>(null);
  const appliedKey = JSON.stringify(applied);
  useEffect(() => { setDimOverrides({}); setPerOverride(null); }, [appliedKey]);

  const lockedDims = new Set(defs.filter((d) => d.locked && d.kind !== 'period').map((d) => d.dimension));
  const periodLocked = defs.some((d) => d.kind === 'period' && d.locked);
  const controls_ = card.config.controls;
  const controlDims = cardControlDims(card).filter((d) => card.filterable?.dimensions.includes(d) ?? true);

  const effDims = { ...applied.dims };
  for (const [dim, values] of Object.entries(dimOverrides)) {
    if (lockedDims.has(dim)) continue;
    if (values.length) effDims[dim] = values;
    else delete effDims[dim];
  }
  const effPeriod = (!periodLocked && perOverride) || period;
  const effective: AppliedFilters = { dims: effDims, from: effPeriod?.from, to: effPeriod?.to };
  const effectiveKey = JSON.stringify(effective);

  useEffect(() => { setRecheck(0); }, [effectiveKey]);

  useEffect(() => {
    let alive = true;
    if (recheck === 0) setLoading(true);
    setError(undefined);
    const filters = JSON.parse(effectiveKey) as AppliedFilters;
    // Saved placements render through the dashboard's single streamed request; cards just added in
    // edit mode (not saved yet) load on their own
    const request = batcher && card.item_id
      ? batcher.load(card.item_id, filters)
      : api.cardData(card.id, filters, { versionId: card.card_version_id, dashboardId });
    let timer: ReturnType<typeof setTimeout> | undefined;
    request
      .then((d) => {
        if (!alive) return;
        setData(d);
        // A stale result is being refreshed in the background — look again shortly
        if (d.stale && recheck < 3) timer = setTimeout(() => setRecheck((n) => n + 1), 2500);
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; clearTimeout(timer); };
  }, [card.id, card.item_id, card.card_version_id, dashboardId, effectiveKey, batcher, recheck]);

  const setOverride = (dim: string, values: string[]) => setDimOverrides((o) => {
    const next = { ...o, [dim]: values };
    // A child dimension shown on the same card (e.g. sub_segment under segment) resets with its parent
    const childIdx = controlDims.indexOf(dim) + 1;
    if (childIdx > 0 && childIdx < controlDims.length) next[controlDims[childIdx]] = [];
    return next;
  });

  const controls = (controlDims.length || controls_?.period) ? (
    <>
      <div className="flex flex-wrap gap-1">
        {controlDims.map((dim, i) => {
          const narrowing = Object.fromEntries(controlDims.slice(0, i).filter((d) => effDims[d]?.length).map((d) => [d, effDims[d]]));
          const def = defs.find((d) => d.dimension === dim);
          return (
            <FilterSelect key={dim} compact label={def?.label || dimensionLabel(dim)} scheme={card.config.scheme}
              multi={def ? def.kind === 'multi' : i > 0} value={effDims[dim] ?? []} onChange={(v) => setOverride(dim, v)}
              allowed={dim === 'segment' ? controls_?.segmentOptions?.filter((o) => o !== 'ALL') : undefined}
              load={() => api.cardFilterOptions(card.id, dim, narrowing, { versionId: card.card_version_id, dashboardId }).then((r) => r.values)}
              loadKey={JSON.stringify(narrowing)}
              disabled={lockedDims.has(dim)} title={lockedDims.has(dim) ? 'Locked by the dashboard' : undefined} />
          );
        })}
      </div>
      {controls_?.period && effPeriod && (
        <PeriodSelect compact value={effPeriod} onChange={setPerOverride} options={controls_.periodOptions} scheme={card.config.scheme} />
      )}
    </>
  ) : undefined;

  const ignored = (data.meta.ignored ?? []).map((d) => (d === 'period' ? 'period' : defs.find((f) => f.dimension === d)?.label || dimensionLabel(d)));
  const notices = [
    ...(card.update_available ? [{ label: 'Update', title: 'A newer version of this card exists' }] : []),
    ...(ignored.length ? [{ label: 'Partly filtered', title: `Not filtered by ${ignored.join(', ')} — the card's source doesn't have ${ignored.length === 1 ? 'that field' : 'those fields'}` }] : []),
  ];

  const context: CardContext = {
    segmentLabel: summarize(effDims),
    periodLabel: effPeriod?.label ?? 'All time',
    filters: (card.config.filters ?? []).map((f) => `${f.field} = '${f.value}'`),
  };

  return (
    <CardFrame card={card} rows={data.rows} controls={controls} notices={notices} context={context} editMode={editMode}
      asOf={data.as_of} stale={data.stale}
      onRemove={onRemove} loading={loading} error={error}>
      <ChartRenderer chartType={card.chart_type} data={data} compact={card.w <= 3} xKey={card.config.xKey} yKeys={card.config.yKeys} rank={card.config.rank} scheme={card.config.scheme} />
    </CardFrame>
  );
}

export default function DashboardPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState<DashboardDetail | null>(null);
  const [items, setItems] = useState<DashboardItem[]>([]);
  const [filterValues, setFilterValues] = useState<FilterValues>({});
  const [period, setPeriod] = useState<Period | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [library, setLibrary] = useState<Card[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<'history' | 'share' | null>(null);
  const batcher = useMemo(() => (id ? createRenderBatcher(Number(id)) : null), [id]);

  // Filter state starts from the dashboard's defaults
  const resetFilters = (d: DashboardDetail) => {
    setFilterValues(initialValues(d.filters));
    const p = d.filters.find((f) => f.kind === 'period');
    setPeriod(p ? periodFromPreset(p.default[0]) : null);
  };

  const loadDashboard = useCallback(() => {
    api.dashboard(id!)
      .then((d) => { setDashboard(d); setItems(d.items); setDirty(false); resetFilters(d); })
      .catch(() => navigate('/dashboards'));
  }, [id, navigate]);
  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  useEffect(() => {
    if (drawerOpen) api.cards().then(setLibrary).catch(console.error);
  }, [drawerOpen]);

  const layout: Layout[] = useMemo(
    () => items.map((it) => ({ i: String(it.id), x: it.x, y: it.y, w: it.w, h: it.h, minW: 2, minH: 2 })),
    [items],
  );

  const onLayoutChange = useCallback((next: Layout[]) => {
    if (!editMode) return;
    setItems((prev) => {
      let changed = false;
      const updated = prev.map((it) => {
        const l = next.find((n) => n.i === String(it.id));
        if (!l) return it;
        if (l.x !== it.x || l.y !== it.y || l.w !== it.w || l.h !== it.h) changed = true;
        return { ...it, x: l.x, y: l.y, w: l.w, h: l.h };
      });
      if (changed) setDirty(true);
      return changed ? updated : prev;
    });
  }, [editMode]);

  const addCard = (card: Card) => {
    const size = DEFAULT_SIZE[card.chart_type] ?? { w: 4, h: 4 };
    const bottom = items.reduce((m, it) => Math.max(m, it.y + it.h), 0);
    setItems((prev) => [...prev, { ...card, x: 0, y: bottom, ...size }]);
    setDirty(true);
  };

  const removeCard = (cardId: number) => {
    setItems((prev) => prev.filter((it) => it.id !== cardId));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      // Existing placements keep their pinned card version; new ones pin the card's latest version
      const saved = await api.saveDashboardItems(id!, items.map((it) => ({ item_id: it.item_id, card_id: it.id, x: it.x, y: it.y, w: it.w, h: it.h })));
      setDashboard(saved);
      setItems(saved.items);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const applyUpdates = async () => {
    try {
      const updated = await api.applyUpdates(dashboard!.id);
      setDashboard(updated);
      setItems(updated.items);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  if (!dashboard) {
    return <div className="flex h-screen items-center justify-center"><div className="size-6 animate-spin rounded-full border-2 border-line border-t-accent" /></div>;
  }

  const onDashboard = new Set(items.map((it) => it.id));
  const applied = toApplied(dashboard.filters, filterValues, period);

  return (
    <div className="px-8 py-7">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Link to="/dashboards" className="rounded-lg p-1.5 text-ink-faint transition hover:bg-white hover:text-ink" aria-label="Back to dashboards">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 3L5 8l5 5" /></svg>
            </Link>
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-ink">{dashboard.name}</h1>
            <AssetBadges asset={dashboard} />
          </div>
          <p className="ml-10 mt-0.5 text-sm text-ink-soft">{dashboard.description}</p>
          <div className="ml-10 mt-2"><GovernanceBar kind="dashboards" asset={dashboard} onChanged={loadDashboard} /></div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setDialog('history')}
            className="rounded-full border border-line bg-white px-4 py-2 text-xs font-semibold text-ink-soft shadow-sm transition hover:border-accent/50 hover:text-ink">
            History
          </button>
          {dashboard.access === 'owner' && (
            <button onClick={() => setDialog('share')}
              className="rounded-full border border-line bg-white px-4 py-2 text-xs font-semibold text-ink-soft shadow-sm transition hover:border-accent/50 hover:text-ink">
              Share
            </button>
          )}
          {dashboard.can_edit ? (
            <div className="flex items-center rounded-full border border-line bg-white p-1 shadow-sm">
              {(['View', 'Edit'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => { setEditMode(mode === 'Edit'); if (mode === 'View') setDrawerOpen(false); }}
                  className={`rounded-full px-4 py-1.5 font-display text-sm font-semibold transition ${
                    (mode === 'Edit') === editMode ? 'bg-accent text-white shadow' : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          ) : (
            <span className="rounded-full border border-line bg-white px-4 py-2 text-xs font-semibold text-ink-soft"
              title={dashboard.scope === 'global' ? 'Global dashboards are edited by admins or through change requests' : 'Shared with you as view-only'}>
              Read-only
            </span>
          )}
        </div>
      </div>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <FilterBar dashboardId={dashboard.id} defs={dashboard.filters} values={filterValues} period={period}
          onValues={setFilterValues} onPeriod={setPeriod} />
        {editMode && (
          <div className="flex items-center gap-2">
            <button onClick={() => setFiltersOpen(true)}
              className="rounded-xl border border-line bg-white px-4 py-2 font-display text-sm font-semibold text-ink-soft transition hover:border-accent/50 hover:text-ink">
              Filters
            </button>
            <button
              onClick={() => setDrawerOpen(true)}
              className="rounded-xl border border-accent bg-white px-4 py-2 font-display text-sm font-semibold text-accent transition hover:bg-accent-soft"
            >
              + Add widget
            </button>
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="rounded-xl bg-accent px-4 py-2 font-display text-sm font-semibold text-white transition enabled:hover:bg-accent-deep disabled:opacity-40"
            >
              {saving ? 'Saving…' : dirty ? 'Save layout' : 'Saved'}
            </button>
          </div>
        )}
      </div>

      {dashboard.can_edit && !dirty && items.some((it) => it.update_available) && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
          <span>
            <span className="font-semibold">{items.filter((it) => it.update_available).length} card(s) have newer versions:</span>{' '}
            {items.filter((it) => it.update_available).map((it) => it.name).join(', ')}. This dashboard keeps showing the pinned versions until you update.
          </span>
          <button onClick={applyUpdates} className="shrink-0 rounded-lg bg-amber-500 px-3 py-1.5 font-semibold text-white transition hover:bg-amber-600">
            Update all
          </button>
        </div>
      )}

      {editMode && (
        <p className="mb-4 rounded-xl border border-accent/30 bg-accent-soft px-4 py-2.5 text-xs font-medium text-accent-deep">
          Edit mode — drag cards by their header, resize from the corner, and add widgets from the library. Saving creates
          version v{dashboard.version_no + 1}; cards stay pinned to the versions they were added with.
        </p>
      )}

      <RenderContext.Provider value={batcher}>
      <Grid
        layout={layout}
        cols={12}
        rowHeight={72}
        margin={[14, 14]}
        containerPadding={[0, 0]}
        isDraggable={editMode}
        isResizable={editMode}
        draggableHandle=".drag-handle"
        onLayoutChange={onLayoutChange}
      >
        {items.map((it) => (
          <div key={String(it.id)}>
            <DashboardCard card={it} dashboardId={dashboard.id} defs={dashboard.filters} applied={applied} period={period} editMode={editMode} onRemove={() => removeCard(it.id)} />
          </div>
        ))}
      </Grid>
      </RenderContext.Provider>

      {!items.length && (
        <div className="rounded-2xl border border-dashed border-line bg-white/50 p-16 text-center">
          <p className="font-display font-semibold text-ink">This dashboard is empty</p>
          <p className="mt-1 text-sm text-ink-faint">{dashboard.can_edit ? 'Switch to Edit and add widgets from your card library.' : 'Nothing has been added yet.'}</p>
        </div>
      )}

      {filtersOpen && (
        <DashboardFilterEditor dashboard={dashboard} onClose={() => setFiltersOpen(false)}
          onSaved={(d) => { setDashboard(d); setItems(d.items); resetFilters(d); setFiltersOpen(false); }} />
      )}
      {dialog === 'history' && (
        <VersionHistory kind="dashboards" assetId={dashboard.id} assetName={dashboard.name} canEdit={dashboard.can_edit}
          onClose={() => setDialog(null)} onRestored={loadDashboard} />
      )}
      {dialog === 'share' && (
        <ShareDialog kind="dashboards" assetId={dashboard.id} assetName={dashboard.name} onClose={() => setDialog(null)} />
      )}

      {/* Add-widget drawer */}
      {drawerOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-accent-deep/30 backdrop-blur-[2px]" onClick={() => setDrawerOpen(false)} />
          <aside className="rise-in fixed inset-y-0 right-0 z-50 flex w-96 flex-col bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <div>
                <h2 className="font-display text-lg font-bold text-ink">Card library</h2>
                <p className="text-xs text-ink-soft">Reusable cards — add any of them to this dashboard.</p>
              </div>
              <button onClick={() => setDrawerOpen(false)} className="rounded-lg p-1.5 text-ink-faint transition hover:bg-canvas hover:text-ink" aria-label="Close drawer">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 3l10 10M13 3L3 13" /></svg>
              </button>
            </div>
            <div className="flex-1 space-y-2.5 overflow-auto p-4">
              {library.map((c) => {
                const used = onDashboard.has(c.id);
                return (
                  <div key={c.id} className={`flex items-center justify-between gap-3 rounded-xl border p-3.5 transition ${used ? 'border-line bg-canvas/60 opacity-60' : 'border-line bg-white hover:border-accent/50 hover:shadow-sm'}`}>
                    <div className="min-w-0">
                      <p className="truncate font-display text-sm font-bold text-ink">{c.name}</p>
                      <p className="truncate text-xs text-ink-faint">{c.chart_type.toUpperCase()} · {c.scope === 'global' ? 'Global' : c.owner_name ?? 'Private'} · v{c.version_no}</p>
                    </div>
                    <button
                      disabled={used}
                      onClick={() => addCard(c)}
                      className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition enabled:hover:bg-accent-deep disabled:bg-line disabled:text-ink-faint"
                    >
                      {used ? 'Added' : '+ Add'}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="border-t border-line p-4">
              <Link to="/cards/new" className="block rounded-xl border border-accent py-2.5 text-center font-display text-sm font-semibold text-accent transition hover:bg-accent-soft">
                Build a new card →
              </Link>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
