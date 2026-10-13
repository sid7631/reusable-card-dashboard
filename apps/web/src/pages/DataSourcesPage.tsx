import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDataSources } from '../lib/queries';
import { timeAgo } from '../lib/format';
import AssetBadges from '../components/AssetBadges';
import DeleteDialog, { DeletedList } from '../components/DeleteDialog';
import type { DataSource } from '../lib/types';

type Tab = 'all' | 'global' | 'private' | 'shared' | 'deleted';
const TABS: [Tab, string][] = [['all', 'All'], ['global', 'Global'], ['private', 'My sources'], ['shared', 'Shared with me'], ['deleted', 'Deleted']];
export const SOURCE_TYPE_LABEL = { postgres: 'Postgres', rest: 'REST API', file: 'File', bigquery: 'BigQuery' } as const;

export default function DataSourcesPage() {
  const [tab, setTab] = useState<Tab>('all');
  const { data: sources } = useDataSources(tab === 'all' ? undefined : tab);
  const [deleting, setDeleting] = useState<DataSource | null>(null);

  return (
    <div className="px-10 py-8">
      <div className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink">Data Sources</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Connect databases, APIs and files, and describe them in business terms. New sources are private until an admin publishes them.
          </p>
        </div>
        <Link to="/data-sources/new" className="rounded-xl bg-accent px-5 py-2.5 font-display text-sm font-semibold text-white shadow-sm transition hover:bg-accent-deep">
          + New data source
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

      {tab === 'deleted' ? <DeletedList kind="data-sources" items={sources} /> : (
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {sources?.map((s) => (
          <Link key={s.id} to={`/data-sources/${s.id}`}
            className="group rounded-2xl border border-line bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-lg">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate font-display text-base font-bold text-ink">{s.name}</h2>
                <p className="line-clamp-2 min-h-8 text-xs text-ink-faint">{s.description || 'No description'}</p>
              </div>
              <AssetBadges asset={s} />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px]">
              <span className="rounded-md bg-accent-soft px-2 py-0.5 font-semibold text-accent">{SOURCE_TYPE_LABEL[s.type]}</span>
              <span className="text-ink-faint">
                {s.spec.model.datasets.length} table{s.spec.model.datasets.length === 1 ? '' : 's'} modelled
              </span>
              {s.pending_request_id && <span className="rounded-md bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800">In review</span>}
              <span className="ml-auto text-ink-faint">{s.owner_name ?? 'Global'} · {timeAgo(s.updated_at)}</span>
              {(s.access === 'owner' || s.access === 'admin') && (
                <button onClick={(e) => { e.preventDefault(); setDeleting(s); }} aria-label="Delete data source"
                  className="rounded-lg p-1 text-ink-faint opacity-0 transition hover:bg-negative/10 hover:text-negative group-hover:opacity-100">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M3 5h10M6 5V3h4v2m-5 0v8m4-8v8M4 5l1 9h6l1-9" /></svg>
                </button>
              )}
            </div>
          </Link>
        ))}
        {sources && !sources.length && (
          <div className="col-span-full rounded-2xl border border-dashed border-line bg-white/50 p-12 text-center text-sm text-ink-faint">
            No data sources here yet.
          </div>
        )}
      </div>
      )}
      {deleting && <DeleteDialog kind="data-sources" asset={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}
