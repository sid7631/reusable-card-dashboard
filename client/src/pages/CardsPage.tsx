import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { Card, CardData } from '../lib/types';
import ChartRenderer from '../components/ChartRenderer';

function CardPreview({ card }: { card: Card }) {
  const [data, setData] = useState<CardData>({ rows: [], meta: {} });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.cardData(card.id, { from: '2026-01-01', to: '2026-06-11' })
      .then(setData)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [card.id]);

  return (
    <div className="h-44">
      {loading ? (
        <div className="flex h-full items-center justify-center">
          <div className="size-5 animate-spin rounded-full border-2 border-line border-t-accent" />
        </div>
      ) : (
        <ChartRenderer chartType={card.chart_type} data={data} compact xKey={card.config.xKey} yKeys={card.config.yKeys} />
      )}
    </div>
  );
}

export default function CardsPage() {
  const [cards, setCards] = useState<Card[]>([]);

  const load = () => api.cards().then(setCards).catch(console.error);
  useEffect(() => { load(); }, []);

  const remove = async (card: Card) => {
    if (!confirm(`Delete card “${card.name}”? It will be removed from every dashboard that uses it.`)) return;
    await api.deleteCard(card.id);
    load();
  };

  return (
    <div className="px-10 py-8">
      <div className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink">Card Library</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Every card is stored once — with its SQL and data-source mapping — and can power any number of dashboards.
          </p>
        </div>
        <Link to="/cards/new" className="rounded-xl bg-accent px-5 py-2.5 font-display text-sm font-semibold text-white shadow-sm transition hover:bg-accent-deep">
          + New card
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((c, i) => (
          <div key={c.id} className="rise-in group rounded-2xl border border-line bg-white p-4 shadow-sm transition hover:shadow-lg" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate font-display text-base font-bold text-ink">{c.name}</h2>
                <p className="truncate text-xs text-ink-faint">{c.description}</p>
              </div>
              <span className="shrink-0 rounded-md bg-accent-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                {c.created_via}
              </span>
            </div>
            <CardPreview card={c} />
            <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
              <span className="font-mono text-[11px] text-ink-faint">{c.chart_type} · {c.dataset}</span>
              <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                <Link to={`/cards/${c.id}/edit`} className="rounded-lg px-2.5 py-1 text-xs font-semibold text-accent transition hover:bg-accent-soft">
                  Edit
                </Link>
                <button onClick={() => remove(c)} className="rounded-lg px-2.5 py-1 text-xs font-semibold text-negative transition hover:bg-negative/10">
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
        {!cards.length && (
          <div className="col-span-full rounded-2xl border border-dashed border-line bg-white/50 p-12 text-center text-sm text-ink-faint">
            No cards yet — build your first one.
          </div>
        )}
      </div>
    </div>
  );
}
