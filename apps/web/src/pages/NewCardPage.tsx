import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useCards, useDatasets } from '../lib/queries';
import type { Dataset } from '../lib/types';
import CardStudio from './CardStudio';
import { CardPreview } from './CardsPage';
import { SOURCE_TYPE_LABEL } from './DataSourcesPage';

/**
 * New card, step 1: choose the data source, then start from one of its example cards or from scratch.
 * Step 2 is the studio (`?source=<id>`, plus `&from=<card id>` when starting from an example).
 */
export default function NewCardPage() {
  const [params] = useSearchParams();
  const source = params.get('source');
  if (source) return <CardStudio key={`${source}:${params.get('from') ?? ''}`} />;
  return <SourcePicker />;
}

function SourcePicker() {
  const navigate = useNavigate();
  const { data: datasets, isPending } = useDatasets();
  const cards = useCards().data ?? [];
  const [chosen, setChosen] = useState<number>();
  const source = datasets?.find((d) => d.id === chosen);
  // Examples: global cards on the source first, then the user's own and shared ones
  const examples = cards
    .filter((c) => c.data_source_id === chosen)
    .sort((a, b) => Number(b.scope === 'global') - Number(a.scope === 'global'));
  const countFor = (id: number) => cards.filter((c) => c.data_source_id === id).length;

  const start = (fromCard?: number) => navigate(`/cards/new?source=${chosen}${fromCard ? `&from=${fromCard}` : ''}`);

  return (
    <div className="px-10 py-8">
      <Link to="/cards" className="text-xs font-semibold text-ink-soft hover:text-accent">← Card library</Link>
      <h1 className="mt-3 font-display text-3xl font-extrabold tracking-tight text-ink">New card</h1>
      <p className="mt-1 text-sm text-ink-soft">
        <span className="font-semibold text-ink">1. Choose a data source</span> — the card's fields, measures and filters come from it.
        <span className="ml-2 text-ink-faint">2. Start from an example or from scratch.</span>
      </p>

      <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {datasets?.map((d) => (
          <SourceTile key={d.id} source={d} active={d.id === chosen} cardCount={countFor(d.id)} onChoose={() => setChosen(d.id)} />
        ))}
        {isPending && <div className="col-span-full flex justify-center py-12"><div className="size-5 animate-spin rounded-full border-2 border-line border-t-accent" /></div>}
        {datasets && !datasets.length && (
          <div className="col-span-full rounded-2xl border border-dashed border-line bg-white/50 p-10 text-center text-sm text-ink-faint">
            No data sources yet — <Link to="/data-sources/new" className="font-semibold text-accent hover:underline">onboard one</Link> first.
          </div>
        )}
      </div>

      {source && (
        <section className="rise-in mt-8">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-bold text-ink">Start from an example on {source.label}</h2>
              <p className="text-xs text-ink-soft">
                Opens a new private card pre-filled from the example — the example itself is not changed.
              </p>
            </div>
            <button onClick={() => start()}
              className="rounded-xl bg-accent px-5 py-2.5 font-display text-sm font-semibold text-white shadow-sm transition hover:bg-accent-deep">
              Start blank →
            </button>
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {examples.map((c) => (
              <button key={c.id} onClick={() => start(c.id)}
                className="group rounded-2xl border border-line bg-white p-4 text-left shadow-sm transition hover:border-accent/50 hover:shadow-lg">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-display text-sm font-bold text-ink">{c.name}</h3>
                    <p className="truncate text-xs text-ink-faint">{c.description}</p>
                  </div>
                  <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    c.scope === 'global' ? 'bg-accent text-white' : 'bg-canvas text-ink-soft'}`}>
                    {c.scope === 'global' ? 'Global' : c.owner_name ?? 'Private'}
                  </span>
                </div>
                <CardPreview card={c} />
                <p className="mt-3 border-t border-line pt-3 font-mono text-[11px] text-ink-faint">
                  {c.chart_type} · via {c.created_via}
                  <span className="float-right font-sans font-semibold text-accent opacity-0 transition group-hover:opacity-100">Use as starting point →</span>
                </p>
              </button>
            ))}
            {!examples.length && (
              <div className="col-span-full rounded-2xl border border-dashed border-line bg-white/50 p-10 text-center text-sm text-ink-faint">
                No cards use this source yet — start blank.
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function SourceTile({ source, active, cardCount, onChoose }: { source: Dataset; active: boolean; cardCount: number; onChoose: () => void }) {
  const primary = source.model.datasets.find((d) => d.name === source.name) ?? source.model.datasets[0];
  return (
    <button onClick={onChoose} disabled={Boolean(source.error)} title={source.error}
      className={`rounded-2xl border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
        active ? 'border-accent bg-accent-soft/60 shadow-md ring-2 ring-accent/30' : 'border-line bg-white shadow-sm enabled:hover:border-accent/50 enabled:hover:shadow'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-display text-sm font-bold text-ink">{source.label}</span>
        <span className="shrink-0 rounded-md bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent">{SOURCE_TYPE_LABEL[source.type]}</span>
      </div>
      <p className="mt-1 truncate text-xs text-ink-soft">
        {source.loading ? 'Reading this source…' : source.error ? `Unavailable — ${source.error}` : (primary?.label || source.name)}
      </p>
      {!source.error && (
        <p className="mt-2 text-[11px] text-ink-faint">
          {source.rowCount.toLocaleString()} rows · {primary?.dimensions.length ?? 0} fields · {primary?.measures.length ?? 0} measures
          {' · '}{cardCount ? `${cardCount} example${cardCount === 1 ? '' : 's'}` : 'no cards yet'}
        </p>
      )}
      {Boolean(source.missing_tables?.length) && (
        <p className="mt-1.5 text-[11px] font-medium text-amber-700" title="Open the data source to remove it from the model">
          Model mentions a missing table: {source.missing_tables!.join(', ')}
        </p>
      )}
    </button>
  );
}
