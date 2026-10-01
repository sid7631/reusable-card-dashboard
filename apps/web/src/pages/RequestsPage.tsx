import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { timeAgo } from '../lib/format';
import type { ChangeRequestSummary, RequestStatus } from '../lib/types';
import RequestStatusChip from '../components/RequestStatus';

const TABS: [RequestStatus | 'all', string][] = [
  ['pending', 'In review'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['withdrawn', 'Withdrawn'], ['all', 'All'],
];
const KIND_LABEL = { card: 'Card', dashboard: 'Dashboard', data_source: 'Data source' } as const;

/** Admins: the approval queue for everyone's requests. Users: their own requests. */
export default function RequestsPage() {
  const { user } = useAuth();
  const admin = user.role === 'admin';
  const [tab, setTab] = useState<RequestStatus | 'all'>('pending');
  const [requests, setRequests] = useState<ChangeRequestSummary[]>();

  useEffect(() => {
    setRequests(undefined);
    api.changeRequests(tab).then(setRequests).catch(console.error);
  }, [tab]);

  return (
    <div className="px-10 py-8">
      <div className="mb-8">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink">{admin ? 'Approvals' : 'My requests'}</h1>
        <p className="mt-1 text-sm text-ink-soft">
          {admin
            ? 'Review proposals to publish or change global cards, dashboards and data sources.'
            : 'Your proposals to publish to, or change, the global library.'}
        </p>
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

      <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-sm">
        {requests?.map((r) => (
          <Link key={r.id} to={`/requests/${r.id}`}
            className="flex items-center gap-4 border-b border-line px-5 py-4 transition last:border-0 hover:bg-canvas/60">
            <span className="w-12 shrink-0 font-mono text-xs text-ink-faint">#{r.id}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-display text-sm font-bold text-ink">{r.title}</p>
              <p className="truncate text-xs text-ink-faint">
                {r.root_kind && KIND_LABEL[r.root_kind]} “{r.root_name}”
                {r.item_count && r.item_count > 1 ? ` + ${r.item_count - 1} dependenc${r.item_count === 2 ? 'y' : 'ies'}` : ''}
                {admin && ` · by ${r.requested_by_name}`}
              </p>
            </div>
            <span className="shrink-0 text-xs text-ink-faint" title={new Date(r.created_at).toLocaleString()}>{timeAgo(r.created_at)}</span>
            <RequestStatusChip status={r.status} />
          </Link>
        ))}
        {requests && !requests.length && (
          <p className="px-5 py-12 text-center text-sm text-ink-faint">
            {tab === 'pending' ? (admin ? 'Nothing waiting for review.' : 'You have nothing in review.') : 'No requests.'}
          </p>
        )}
        {!requests && <div className="flex justify-center py-12"><div className="size-5 animate-spin rounded-full border-2 border-line border-t-accent" /></div>}
      </div>
    </div>
  );
}
