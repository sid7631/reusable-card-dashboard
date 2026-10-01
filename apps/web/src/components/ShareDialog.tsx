import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { AssetKind, DirectoryEntry, Share } from '../lib/types';
import Modal from './Modal';

interface Props {
  kind: AssetKind;
  assetId: number;
  assetName: string;
  onClose: () => void;
}

const PERMISSIONS: [Share['permission'], string][] = [['view', 'Can view'], ['edit', 'Can edit']];

const initials = (name: string) => name.split(' ').map((p) => p[0]).join('').slice(0, 2);

/** Owner-only: grant specific people view or edit access to a private asset. */
export default function ShareDialog({ kind, assetId, assetName, onClose }: Props) {
  const [shares, setShares] = useState<Share[]>([]);
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<DirectoryEntry[]>([]);
  const [permission, setPermission] = useState<Share['permission']>('view');
  const [error, setError] = useState<string>();

  const load = useCallback(() => api.shares(kind, assetId).then(setShares).catch((e) => setError(e.message)), [kind, assetId]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const t = setTimeout(() => api.users(query).then(setPeople).catch(() => setPeople([])), 200);
    return () => clearTimeout(t);
  }, [query]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const sharedIds = new Set(shares.map((s) => s.user_id));
  const candidates = people.filter((p) => !sharedIds.has(p.id));
  const noun = kind === 'dashboards' ? 'dashboard' : kind === 'cards' ? 'card' : 'data source';

  return (
    <Modal wide title={`Share “${assetName}”`} subtitle={`Only people you add can see this private ${noun}. Changes take effect immediately.`} onClose={onClose}>
      <div className="space-y-5">
        <div>
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-soft">Add people</span>
          <div className="flex gap-2">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or email"
              className="w-full rounded-lg border border-line px-3 py-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20" />
            <select value={permission} onChange={(e) => setPermission(e.target.value as Share['permission'])} aria-label="Permission for new people"
              className="rounded-lg border border-line px-2 text-sm outline-none focus:border-accent">
              {PERMISSIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
          </div>
          <ul className="mt-2 max-h-40 space-y-1 overflow-auto">
            {candidates.map((p) => (
              <li key={p.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-canvas">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-bold text-accent">{initials(p.name)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">{p.name}</span>
                  <span className="block truncate text-[11px] text-ink-faint">{p.email}</span>
                </span>
                <button onClick={() => run(() => api.share(kind, assetId, p.id, permission))}
                  className="rounded-lg border border-accent px-3 py-1 text-xs font-semibold text-accent transition hover:bg-accent-soft">
                  Share
                </button>
              </li>
            ))}
            {!candidates.length && <li className="px-2 py-2 text-xs text-ink-faint">{query ? 'No matching people.' : 'Everyone in the directory already has access.'}</li>}
          </ul>
        </div>

        <div>
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-soft">People with access</span>
          <ul className="divide-y divide-line rounded-xl border border-line">
            <li className="flex items-center gap-3 px-3 py-2.5 text-sm text-ink-soft">
              <span className="flex size-7 items-center justify-center rounded-full bg-accent text-[11px] font-bold text-white">You</span>
              <span className="flex-1">You (owner)</span>
            </li>
            {shares.map((s) => (
              <li key={s.user_id} className="flex items-center gap-3 px-3 py-2.5">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-bold text-accent">{initials(s.name)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">{s.name}</span>
                  <span className="block truncate text-[11px] text-ink-faint">{s.email}</span>
                </span>
                <select value={s.permission} aria-label={`Permission for ${s.name}`}
                  onChange={(e) => run(() => api.share(kind, assetId, s.user_id, e.target.value as Share['permission']))}
                  className="rounded-lg border border-line px-2 py-1 text-xs outline-none focus:border-accent">
                  {PERMISSIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                </select>
                <button onClick={() => run(() => api.unshare(kind, assetId, s.user_id))} aria-label={`Remove ${s.name}`}
                  className="rounded-lg p-1.5 text-ink-faint transition hover:bg-negative/10 hover:text-negative">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 3l10 10M13 3L3 13" /></svg>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-ink-faint">
            Viewers can open and render it. Editors can also save new versions — only you can share, publish or delete.
          </p>
        </div>
        {error && <p className="text-sm text-negative">{error}</p>}
      </div>
    </Modal>
  );
}
