import { useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createRenderBatcher, RenderContext } from '../lib/render';
import { Link, useLocation, useParams } from 'react-router-dom';
import RGL, { WidthProvider, type Layout } from 'react-grid-layout';
import { api } from '../lib/api';
import { keys, queryClient, useCards, useDashboard } from '../lib/queries';
import { dashboardEditor, initialDashboardEditor } from '../lib/dashboardEditor';
import type { AppliedFilters, CardData, DashboardDetail, DashboardFilterDef, DashboardItem } from '../lib/types';
import { cardControlDims, dimensionLabel, setFilter, summarize, toApplied } from '../lib/filters';
import ChartRenderer from '../components/ChartRenderer';
import CardFrame from '../components/CardFrame';
import PeriodSelect, { type Period } from '../components/PeriodSelect';
import FilterSelect from '../components/FilterSelect';
import FilterBar from '../components/FilterBar';
import DashboardFilterEditor from '../components/DashboardFilterEditor';
import AssistantWidget from '../components/AssistantWidget';
import type { CardContext } from '../components/CardActions';
import AssetBadges from '../components/AssetBadges';
import VersionHistory from '../components/VersionHistory';
import ShareDialog from '../components/ShareDialog';
import GovernanceBar from '../components/GovernanceBar';
import CardUpdateDialog from '../components/CardUpdateDialog';
import NotFound from '../components/NotFound';

const Grid = WidthProvider(RGL);

function DashboardCard({ card, dashboardId, defs, applied, period, editMode, onRemove, onShowUpdate }: {
  card: DashboardItem;
  dashboardId: number;
  defs: DashboardFilterDef[];
  /** Dashboard-level filters (business dimension names) — the card may override unlocked ones. */
  applied: AppliedFilters;
  period: Period | null;
  editMode: boolean;
  onRemove: () => void;
  /** Open the "what changed / update this card" dialog. */
  onShowUpdate: () => void;
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
  // A saved placement renders the card version the dashboard pins. A card just added in edit mode has
  // no placement yet, so it renders the card's own current version (as anyone with the card can)
  const source = card.item_id ? { versionId: card.card_version_id, dashboardId } : { versionId: card.version_id };

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
      : api.cardData(card.id, filters, card.item_id ? { versionId: card.card_version_id, dashboardId } : { versionId: card.version_id });
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
  }, [card.id, card.item_id, card.card_version_id, card.version_id, dashboardId, effectiveKey, batcher, recheck]);

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
              load={() => api.cardFilterOptions(card.id, dim, narrowing, source).then((r) => r.values)}
              optionsKey={['card', card.id, source.versionId, source.dashboardId, dim, narrowing]}
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
    ...(card.deleted ? [{
      label: 'Deleted',
      title: 'This card was deleted from the library. It still works here, but gets no updates and can’t be added to other dashboards. Remove or replace it when convenient.',
    }] : []),
    ...(card.update_available ? [{
      label: 'Update',
      title: `This dashboard shows v${card.version} — see what changed in v${card.latest_version ?? 'the latest version'}`,
      onClick: onShowUpdate,
    }] : []),
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
      <ChartRenderer chartType={card.chart_type} data={data} compact={card.w <= 3} xKey={card.config.xKey} yKeys={card.config.yKeys} rank={card.config.rank} scheme={card.config.scheme} format={card.config.format} />
    </CardFrame>
  );
}

export default function DashboardPage() {
  const { id } = useParams();
  const dashboardQuery = useDashboard(id);
  const [state, dispatch] = useReducer(dashboardEditor, initialDashboardEditor);
  const { dashboard, items, dirty, editMode, filterValues, period } = state;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [dialog, setDialog] = useState<'history' | 'share' | null>(null);
  // Placement whose "update available" dialog is open
  const [updating, setUpdating] = useState<string | null>(null);
  const library = useCards(undefined, drawerOpen).data ?? [];
  const batcher = useMemo(() => (id ? createRenderBatcher(Number(id)) : null), [id]);

  useEffect(() => { if (dashboardQuery.data) dispatch({ type: 'loaded', dashboard: dashboardQuery.data }); }, [dashboardQuery.data]);

  // A card link (#card-<placement>, from "Copy link") scrolls to that card once it is on the page and outlines it
  const { hash } = useLocation();
  const scrolledTo = useRef<string>();
  useEffect(() => {
    const target = hash.startsWith('#card-') ? hash.slice(1) : '';
    const el = target && scrolledTo.current !== target ? document.getElementById(target) : null;
    if (!el) return;
    scrolledTo.current = target;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ring-2', 'ring-accent', 'rounded-2xl');
    const t = setTimeout(() => el.classList.remove('ring-2', 'ring-accent'), 2500);
    return () => clearTimeout(t);
  }, [hash, items]);

  /** A write returned the new dashboard: show it now (the cache refresh that follows agrees). */
  const saved = (d: DashboardDetail) => {
    queryClient.setQueryData(keys.dashboard(id!), d);
    dispatch({ type: 'saved', dashboard: d });
  };

  const layout: Layout[] = useMemo(
    () => items.map((it) => ({ i: String(it.id), x: it.x, y: it.y, w: it.w, h: it.h, minW: 2, minH: 2 })),
    [items],
  );

  const onLayoutChange = useCallback((next: Layout[]) => dispatch({ type: 'layoutChanged', layout: next }), []);

  const save = async () => {
    setSaving(true);
    setSaveError(undefined);
    try {
      // Existing placements keep their pinned card version; new ones pin the card's latest version
      saved(await api.saveDashboardItems(id!, items.map((it) => ({ item_id: it.item_id, card_id: it.id, x: it.x, y: it.y, w: it.w, h: it.h }))));
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const applyUpdates = async () => {
    try {
      saved(await api.applyUpdates(dashboard!.id));
    } catch (e) {
      alert((e as Error).message);
    }
  };

  if (dashboardQuery.isError && !dashboard) {
    return <NotFound noun="dashboard" back="/dashboards" backLabel="Back to dashboards" detail={dashboardQuery.error.message} />;
  }
  if (!dashboard) {
    return <div className="flex h-screen items-center justify-center"><div className="size-6 animate-spin rounded-full border-2 border-line border-t-accent" /></div>;
  }

  const onDashboard = new Set(items.map((it) => it.id));
  const applied = toApplied(dashboard.filters, filterValues, period);
  const filterSummary = [
    ...dashboard.filters.filter((f) => f.kind !== 'period' && filterValues[f.id]?.length)
      .map((f) => `${f.label || f.dimension}: ${filterValues[f.id].join(', ')}`),
    period?.label ?? '',
  ].filter(Boolean).join(' · ') || 'All data';

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
          <div className="ml-10 mt-2"><GovernanceBar kind="dashboards" asset={dashboard} /></div>
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
                  onClick={() => { dispatch({ type: 'setEditMode', on: mode === 'Edit' }); if (mode === 'View') setDrawerOpen(false); }}
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
          onValues={(values) => dispatch({ type: 'setFilterValues', values })} onPeriod={(p) => dispatch({ type: 'setPeriod', period: p })} />
        {editMode && (
          <div className="flex items-center gap-2">
            {saveError && <span className="max-w-xs text-xs font-medium text-negative" role="alert">Couldn't save: {saveError}</span>}
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
            {items.filter((it) => it.update_available).map((it, i) => (
              <span key={it.item_id}>
                {i > 0 && ', '}
                <button onClick={() => setUpdating(it.item_id!)} className="font-semibold underline decoration-amber-400 underline-offset-2 hover:text-amber-700"
                  title="See what changed and update just this card">
                  {it.name} (v{it.version} → v{it.latest_version})
                </button>
              </span>
            ))}. This dashboard keeps showing the pinned versions until you update — one card at a time or all at once.
          </span>
          <button onClick={applyUpdates} className="shrink-0 rounded-lg bg-amber-500 px-3 py-1.5 font-semibold text-white transition hover:bg-amber-600">
            Update all
          </button>
        </div>
      )}

      {editMode && (
        <p className="mb-4 rounded-xl border border-accent/30 bg-accent-soft px-4 py-2.5 text-xs font-medium text-accent-deep">
          Edit mode — drag cards by their header, resize from the corner, and add widgets from the library. Saving creates
          a new version; cards stay pinned to the versions they were added with.
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
          <div key={String(it.id)} id={it.item_id ? `card-${it.item_id}` : undefined}>
            <DashboardCard card={it} dashboardId={dashboard.id} defs={dashboard.filters} applied={applied} period={period} editMode={editMode}
              onRemove={() => dispatch({ type: 'removeCard', cardId: it.id })} onShowUpdate={() => setUpdating(it.item_id ?? null)} />
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

      <AssistantWidget dashboardId={dashboard.id} dashboardName={dashboard.name} items={items} applied={applied}
        filterSummary={filterSummary}
        onApplyFilter={(filterId, values) => dispatch({ type: 'setFilterValues', values: (v) => setFilter(dashboard.filters, v, filterId, values) })} />

      {filtersOpen && (
        <DashboardFilterEditor dashboard={dashboard} onClose={() => setFiltersOpen(false)}
          onSaved={(d) => { saved(d); setFiltersOpen(false); }} />
      )}
      {dialog === 'history' && (
        <VersionHistory kind="dashboards" assetId={dashboard.id} assetName={dashboard.name} canEdit={dashboard.can_edit}
          onClose={() => setDialog(null)} />
      )}
      {updating && items.find((it) => it.item_id === updating) && (
        <CardUpdateDialog dashboardId={dashboard.id} item={items.find((it) => it.item_id === updating)!}
          canApply={dashboard.can_edit && !dirty}
          blockedReason={!dashboard.can_edit
            ? (dashboard.scope === 'global' ? 'Global dashboards are updated by admins.' : 'You have view-only access to this dashboard.')
            : 'Save your layout changes first.'}
          onClose={() => setUpdating(null)} onApplied={saved} />
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
                      <p className="truncate text-xs text-ink-faint">{c.chart_type.toUpperCase()} · {c.scope === 'global' ? 'Global' : c.owner_name ?? 'Private'} · v{c.version}</p>
                    </div>
                    <button
                      disabled={used}
                      onClick={() => dispatch({ type: 'addCard', card: c })}
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
