import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import RGL, { WidthProvider, type Layout } from 'react-grid-layout';
import { api } from '../lib/api';
import type { Card, CardData, ChartType, DashboardDetail, DashboardItem } from '../lib/types';
import ChartRenderer from '../components/ChartRenderer';
import CardFrame from '../components/CardFrame';
import SegmentToggles from '../components/SegmentToggles';
import PeriodSelect, { PERIODS, type Period } from '../components/PeriodSelect';

const Grid = WidthProvider(RGL);

const DEFAULT_SIZE: Partial<Record<ChartType, { w: number; h: number }>> = {
  kpi: { w: 3, h: 2 },
};

function DashboardCard({ card, segment, period, editMode, onRemove }: {
  card: DashboardItem;
  segment: string;
  period: Period;
  editMode: boolean;
  onRemove: () => void;
}) {
  const [data, setData] = useState<CardData>({ rows: [], meta: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(undefined);
    api.cardData(card.id, { segment, from: period.from, to: period.to })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [card.id, segment, period]);

  return (
    <CardFrame card={card} rows={data.rows} editMode={editMode} onRemove={onRemove} loading={loading} error={error}>
      <ChartRenderer chartType={card.chart_type} data={data} compact={card.w <= 3} />
    </CardFrame>
  );
}

export default function DashboardPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState<DashboardDetail | null>(null);
  const [items, setItems] = useState<DashboardItem[]>([]);
  const [segment, setSegment] = useState('ALL');
  const [period, setPeriod] = useState<Period>(PERIODS[0]);
  const [adminMode, setAdminMode] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [library, setLibrary] = useState<Card[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.dashboard(id!)
      .then((d) => { setDashboard(d); setItems(d.items); })
      .catch(() => navigate('/dashboards'));
  }, [id, navigate]);

  useEffect(() => {
    if (drawerOpen) api.cards().then(setLibrary).catch(console.error);
  }, [drawerOpen]);

  const layout: Layout[] = useMemo(
    () => items.map((it) => ({ i: String(it.id), x: it.x, y: it.y, w: it.w, h: it.h, minW: 2, minH: 2 })),
    [items],
  );

  const onLayoutChange = useCallback((next: Layout[]) => {
    if (!adminMode) return;
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
  }, [adminMode]);

  const addCard = (card: Card) => {
    const size = DEFAULT_SIZE[card.chart_type] ?? { w: 4, h: 4 };
    const bottom = items.reduce((m, it) => Math.max(m, it.y + it.h), 0);
    setItems((prev) => [...prev, { ...card, item_id: -Date.now(), x: 0, y: bottom, ...size }]);
    setDirty(true);
  };

  const removeCard = (cardId: number) => {
    setItems((prev) => prev.filter((it) => it.id !== cardId));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.saveDashboardItems(id!, items.map((it) => ({ card_id: it.id, x: it.x, y: it.y, w: it.w, h: it.h })));
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  if (!dashboard) {
    return <div className="flex h-screen items-center justify-center"><div className="size-6 animate-spin rounded-full border-2 border-line border-t-accent" /></div>;
  }

  const onDashboard = new Set(items.map((it) => it.id));

  return (
    <div className="px-8 py-7">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Link to="/dashboards" className="rounded-lg p-1.5 text-ink-faint transition hover:bg-white hover:text-ink" aria-label="Back to dashboards">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 3L5 8l5 5" /></svg>
            </Link>
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-ink">{dashboard.name}</h1>
          </div>
          <p className="ml-10 mt-0.5 text-sm text-ink-soft">{dashboard.description}</p>
        </div>
        <div className="flex items-center gap-3">
          {/* User / Admin toggle, as in the mockups */}
          <div className="flex items-center rounded-full border border-line bg-white p-1 shadow-sm">
            {(['User', 'Admin'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => { setAdminMode(mode === 'Admin'); if (mode === 'User') setDrawerOpen(false); }}
                className={`rounded-full px-4 py-1.5 font-display text-sm font-semibold transition ${
                  (mode === 'Admin') === adminMode ? 'bg-accent text-white shadow' : 'text-ink-soft hover:text-ink'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
          <PeriodSelect value={period} onChange={setPeriod} />
        </div>
      </div>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <SegmentToggles value={segment} onChange={setSegment} />
        {adminMode && (
          <div className="flex items-center gap-2">
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

      {adminMode && (
        <p className="mb-4 rounded-xl border border-accent/30 bg-accent-soft px-4 py-2.5 text-xs font-medium text-accent-deep">
          Admin view — drag cards by their header, resize from the corner, and add widgets from the library. Don't forget to save.
        </p>
      )}

      <Grid
        layout={layout}
        cols={12}
        rowHeight={72}
        margin={[14, 14]}
        containerPadding={[0, 0]}
        isDraggable={adminMode}
        isResizable={adminMode}
        draggableHandle=".drag-handle"
        onLayoutChange={onLayoutChange}
      >
        {items.map((it) => (
          <div key={String(it.id)}>
            <DashboardCard card={it} segment={segment} period={period} editMode={adminMode} onRemove={() => removeCard(it.id)} />
          </div>
        ))}
      </Grid>

      {!items.length && (
        <div className="rounded-2xl border border-dashed border-line bg-white/50 p-16 text-center">
          <p className="font-display font-semibold text-ink">This dashboard is empty</p>
          <p className="mt-1 text-sm text-ink-faint">Switch to Admin and add widgets from your card library.</p>
        </div>
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
                      <p className="truncate text-xs text-ink-faint">{c.chart_type.toUpperCase()} · via {c.created_via}</p>
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
