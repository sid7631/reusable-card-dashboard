import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCardPreview, useCards } from '../lib/queries';
import type { Card } from '../lib/types';
import ChartRenderer from '../components/ChartRenderer';
import AssetBadges from '../components/AssetBadges';
import VersionHistory from '../components/VersionHistory';
import ShareDialog from '../components/ShareDialog';
import DeleteDialog, { DeletedList } from '../components/DeleteDialog';

type Tab = 'all' | 'global' | 'private' | 'shared' | 'deleted';
const TABS: [Tab, string][] = [['all', 'All'], ['global', 'Global library'], ['private', 'My cards'], ['shared', 'Shared with me'], ['deleted', 'Deleted']];

const PREVIEW_WINDOW = { from: '2026-01-01', to: '2026-06-11' };
const EMPTY = { rows: [], meta: {} };

export function CardPreview({ card }: { card: Card }) {
  const { data = EMPTY, isPending: loading } = useCardPreview(card.id, card.version_no, PREVIEW_WINDOW);

  return (
    <div className="h-44">
      {loading ? (
        <div className="flex h-full items-center justify-center">
          <div className="size-5 animate-spin rounded-full border-2 border-line border-t-accent" />
        </div>
      ) : (
        <ChartRenderer chartType={card.chart_type} data={data} compact xKey={card.config.xKey} yKeys={card.config.yKeys} rank={card.config.rank} scheme={card.config.scheme} format={card.config.format} />
      )}
    </div>
  );
}

export default function CardsPage() {
  const [tab, setTab] = useState<Tab>('all');
  const [dialog, setDialog] = useState<{ type: 'history' | 'share' | 'delete'; card: Card } | null>(null);

  const { data: cards, isPending } = useCards(tab === 'all' ? undefined : tab);


  return (
    <div className="px-10 py-8">
      <div className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink">Card Library</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Every card is stored once — with its SQL and data-source mapping — and can power any number of dashboards.
            Each save creates a new version.
          </p>
        </div>
        <Link to="/cards/new" className="rounded-xl bg-accent px-5 py-2.5 font-display text-sm font-semibold text-white shadow-sm transition hover:bg-accent-deep">
          + New card
        </Link>
      </div>

      <div className="mb-6 flex gap-1 border-b border-line">
        {TABS.map(([id, text]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`relative px-3.5 py-2.5 font-display text-sm font-semibold transition ${tab === id ? 'text-accent' : 'text-ink-soft hover:text-ink'}`}>
            {text}
            {tab === id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        ))}
      </div>

      {tab === 'deleted' ? <DeletedList kind="cards" items={cards} /> : (
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {cards?.map((c, i) => (
          <div key={c.id} className="rise-in group rounded-2xl border border-line bg-white p-4 shadow-sm transition hover:shadow-lg" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate font-display text-base font-bold text-ink">{c.name}</h2>
                <p className="truncate text-xs text-ink-faint">{c.description}</p>
              </div>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <AssetBadges asset={c} />
                {c.pending_request_id && (
                  <Link to={`/requests/${c.pending_request_id}`} className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 hover:underline">
                    In review
                  </Link>
                )}
                {c.fork?.stale && <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">Global updated</span>}
              </span>
            </div>
            <CardPreview card={c} />
            <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
              <span className="font-mono text-[11px] text-ink-faint">{c.chart_type} · via {c.created_via}{c.owner_name ? ` · ${c.owner_name}` : ''}</span>
              <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                <button onClick={() => setDialog({ type: 'history', card: c })} className="rounded-lg px-2.5 py-1 text-xs font-semibold text-ink-soft transition hover:bg-canvas hover:text-ink">
                  History
                </button>
                {c.access === 'owner' && (
                  <button onClick={() => setDialog({ type: 'share', card: c })} className="rounded-lg px-2.5 py-1 text-xs font-semibold text-ink-soft transition hover:bg-canvas hover:text-ink">
                    Share
                  </button>
                )}
                <Link to={`/cards/${c.id}/edit`} className="rounded-lg px-2.5 py-1 text-xs font-semibold text-accent transition hover:bg-accent-soft">
                  {c.can_edit ? 'Edit' : 'Open'}
                </Link>
                {(c.access === 'owner' || c.access === 'admin') && (
                  <button onClick={() => setDialog({ type: 'delete', card: c })} className="rounded-lg px-2.5 py-1 text-xs font-semibold text-negative transition hover:bg-negative/10">
                    Delete
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
        {isPending && <div className="col-span-full flex justify-center py-12"><div className="size-5 animate-spin rounded-full border-2 border-line border-t-accent" /></div>}
        {cards && !cards.length && (
          <div className="col-span-full rounded-2xl border border-dashed border-line bg-white/50 p-12 text-center text-sm text-ink-faint">
            {tab === 'shared' ? 'Nothing has been shared with you yet.' : 'No cards here yet — build your first one.'}
          </div>
        )}
      </div>
      )}

      {dialog?.type === 'history' && (
        <VersionHistory kind="cards" assetId={dialog.card.id} assetName={dialog.card.name} canEdit={dialog.card.can_edit}
          onClose={() => setDialog(null)} />
      )}
      {dialog?.type === 'delete' && <DeleteDialog kind="cards" asset={dialog.card} onClose={() => setDialog(null)} />}
      {dialog?.type === 'share' && (
        <ShareDialog kind="cards" assetId={dialog.card.id} assetName={dialog.card.name} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
