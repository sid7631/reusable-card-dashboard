import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { Dashboard } from '../lib/types';
import Modal from '../components/Modal';
import AssetBadges from '../components/AssetBadges';

type Tab = 'all' | 'global' | 'private' | 'shared';
const TABS: [Tab, string][] = [['all', 'All'], ['global', 'Global library'], ['private', 'My dashboards'], ['shared', 'Shared with me']];

export default function DashboardsPage() {
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<Tab>('all');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const navigate = useNavigate();

  const load = () => api.dashboards(tab === 'all' ? undefined : tab).then(setDashboards).catch(console.error);
  useEffect(() => { load(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const d = await api.createDashboard({ name, description });
    navigate(`/dashboards/${d.id}`);
  };

  const remove = async (d: Dashboard) => {
    if (!confirm(`Delete dashboard “${d.name}”? Cards stay in the library.`)) return;
    await api.deleteDashboard(d.id);
    load();
  };

  return (
    <div className="px-10 py-8">
      <div className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink">Dashboards</h1>
          <p className="mt-1 text-sm text-ink-soft">Compose reusable cards into live views — drag, resize, filter. New dashboards start in your private space.</p>
        </div>
        <button
          onClick={() => { setName(''); setDescription(''); setCreating(true); }}
          className="rounded-xl bg-accent px-5 py-2.5 font-display text-sm font-semibold text-white shadow-sm transition hover:bg-accent-deep"
        >
          + New dashboard
        </button>
      </div>

      <div className="mb-6 flex gap-1 border-b border-line">
        {TABS.map(([tid, text]) => (
          <button key={tid} onClick={() => setTab(tid)}
            className={`relative px-3.5 py-2.5 font-display text-sm font-semibold transition ${tab === tid ? 'text-accent' : 'text-ink-soft hover:text-ink'}`}>
            {text}
            {tab === tid && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {dashboards.map((d, i) => (
          <Link
            key={d.id}
            to={`/dashboards/${d.id}`}
            className="rise-in group relative overflow-hidden rounded-2xl border border-line bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-lg"
            style={{ animationDelay: `${i * 50}ms` }}
          >
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-accent to-accent-deep opacity-0 transition group-hover:opacity-100" />
            <div className="flex items-start justify-between gap-2">
              <h2 className="font-display text-lg font-bold text-ink">{d.name}</h2>
              <AssetBadges asset={d} className="mt-1" />
            </div>
            <p className="mt-1 line-clamp-2 min-h-10 text-sm text-ink-soft">{d.description || 'No description'}</p>
            <div className="mt-4 flex items-center justify-between">
              <span className="rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent">
                {d.card_count ?? 0} card{(d.card_count ?? 0) === 1 ? '' : 's'}
              </span>
              {(d.access === 'owner' || d.access === 'admin') && <button
                onClick={(e) => { e.preventDefault(); remove(d); }}
                className="rounded-lg p-1.5 text-ink-faint opacity-0 transition hover:bg-negative/10 hover:text-negative group-hover:opacity-100"
                aria-label="Delete dashboard"
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M3 5h10M6 5V3h4v2m-5 0v8m4-8v8M4 5l1 9h6l1-9" /></svg>
              </button>}
            </div>
          </Link>
        ))}
        {!dashboards.length && (
          <div className="col-span-full rounded-2xl border border-dashed border-line bg-white/50 p-12 text-center text-sm text-ink-faint">
            {tab === 'shared' ? 'Nothing has been shared with you yet.' : 'No dashboards here yet — create one and start adding cards.'}
          </div>
        )}
      </div>

      {creating && (
        <Modal title="New dashboard" subtitle="Give it a name — you'll add cards next." onClose={() => setCreating(false)}>
          <form onSubmit={create} className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-soft">Name</label>
              <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Enterprise Spend Overview"
                className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-soft">Description</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional"
                className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20" />
            </div>
            <button type="submit" className="w-full rounded-lg bg-accent py-2.5 font-display text-sm font-semibold text-white transition hover:bg-accent-deep">
              Create dashboard
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
