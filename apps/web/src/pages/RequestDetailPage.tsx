import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { keys, queryClient, useChangeRequest, useRequestItemPreview } from '../lib/queries';
import type { ChangeRequestItem } from '../lib/types';
import { DEFAULT_PERIOD } from '../components/PeriodSelect';
import ChartRenderer from '../components/ChartRenderer';
import DiffList from '../components/DiffList';
import RequestStatusChip from '../components/RequestStatus';

const KIND_LABEL = { card: 'Card', dashboard: 'Dashboard', data_source: 'Data source' } as const;
const EDIT_PATH = { card: (id: number) => `/cards/${id}/edit`, dashboard: (id: number) => `/dashboards/${id}`, data_source: (id: number) => `/data-sources/${id}` };

export default function RequestDetailPage() {
  const { id } = useParams();
  const reqQuery = useChangeRequest(id);
  const req = reqQuery.data;
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const error = actionError ?? reqQuery.error?.message;

  const act = async (action: 'approve' | 'reject' | 'withdraw' | 'update') => {
    if (action === 'withdraw' && !confirm('Withdraw this request?')) return;
    setBusy(true);
    setActionError(undefined);
    try {
      queryClient.setQueryData(keys.request(id!), await api.decideChangeRequest(req!.id, action, comment));
      setComment('');
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!req) {
    return <div className="px-10 py-8">{error ? <p className="text-negative">{error}</p> : <div className="size-6 animate-spin rounded-full border-2 border-line border-t-accent" />}</div>;
  }

  const root = req.items.find((i) => i.source_asset_id === req.root_asset_id);
  return (
    <div className="px-10 py-8">
      <Link to="/requests" className="text-xs font-semibold text-ink-soft hover:text-accent">← All requests</Link>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-ink">{req.title}</h1>
            <RequestStatusChip status={req.status} />
          </div>
          <p className="mt-1 text-sm text-ink-soft">
            #{req.id} · {req.requested_by_name} · {new Date(req.created_at).toLocaleString()}
            {root && <> · <Link className="font-semibold text-accent hover:underline" to={EDIT_PATH[root.kind](root.source_asset_id)}>open submitted {KIND_LABEL[root.kind].toLowerCase()}</Link></>}
          </p>
          {req.description && <p className="mt-3 max-w-3xl whitespace-pre-wrap text-sm text-ink">{req.description}</p>}
        </div>
      </div>

      {req.status !== 'pending' && req.reviewed_by_name && (
        <div className={`mt-5 rounded-xl border px-4 py-3 text-sm ${req.status === 'approved' ? 'border-positive/30 bg-positive/5' : 'border-negative/30 bg-negative/5'}`}>
          <span className="font-semibold">{req.status === 'approved' ? 'Approved' : 'Rejected'} by {req.reviewed_by_name}</span>
          {req.decided_at && <span className="text-ink-soft"> · {new Date(req.decided_at).toLocaleString()}</span>}
          {req.review_comment && <p className="mt-1 text-ink">{req.review_comment}</p>}
        </div>
      )}

      {req.status === 'pending' && req.has_conflicts && (
        <div className="mt-5 rounded-xl border border-negative/30 bg-negative/5 px-4 py-3 text-sm text-ink">
          <span className="font-semibold text-negative">Conflicts with the current global version.</span>{' '}
          {req.can_update
            ? 'Open the item below and use “Update from global” to resolve them — this request picks up the result automatically.'
            : 'The requester needs to update from global before this can be approved.'}
        </div>
      )}

      <div className="mt-6 space-y-5">
        {req.items.map((item) => <ItemPanel key={item.id} requestId={req.id} item={item} isRoot={item.source_asset_id === req.root_asset_id} />)}
      </div>

      {(req.can_approve || req.can_reject || req.can_withdraw || req.can_update) && (
        <div className="sticky bottom-0 mt-6 rounded-2xl border border-line bg-white p-4 shadow-lg">
          {(req.can_approve || req.can_reject) && (
            <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)}
              placeholder="Review comment (required to reject)"
              className="mb-3 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20" />
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {error && <span className="mr-auto text-sm text-negative">{error}</span>}
            {req.can_update && (
              <button onClick={() => act('update')} disabled={busy} title="Include your latest saved versions in this request"
                className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition hover:border-accent/50 hover:text-ink">
                Update to my latest versions
              </button>
            )}
            {req.can_withdraw && (
              <button onClick={() => act('withdraw')} disabled={busy}
                className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition hover:border-negative/50 hover:text-negative">
                Withdraw
              </button>
            )}
            {req.can_reject && (
              <button onClick={() => act('reject')} disabled={busy || !comment.trim()}
                className="rounded-lg border border-negative px-4 py-2 text-sm font-semibold text-negative transition enabled:hover:bg-negative/10 disabled:opacity-40">
                Reject
              </button>
            )}
            {req.status === 'pending' && (req.can_reject || req.can_approve) && (
              <button onClick={() => act('approve')} disabled={busy || !req.can_approve}
                title={req.has_conflicts ? 'Resolve conflicts first' : 'Publish to the global library'}
                className="rounded-lg bg-positive px-5 py-2 text-sm font-semibold text-white transition enabled:hover:opacity-90 disabled:opacity-40">
                Approve & publish
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const PREVIEW_PERIOD = { from: DEFAULT_PERIOD.from, to: DEFAULT_PERIOD.to };

function ItemPanel({ requestId, item, isRoot }: { requestId: number; item: ChangeRequestItem; isRoot: boolean }) {
  const { data: preview } = useRequestItemPreview(requestId, item.id, item.source_version_no, PREVIEW_PERIOD, item.kind === 'card');

  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-accent-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">{KIND_LABEL[item.kind]}</span>
        <h2 className="font-display text-base font-bold text-ink">{item.name}</h2>
        <span className="font-mono text-xs text-ink-faint">proposed v{item.source_version_no}</span>
        {!isRoot && <span className="rounded-md bg-canvas px-2 py-0.5 text-[10px] font-semibold text-ink-soft">included dependency</span>}
        <span className="ml-auto text-xs text-ink-soft">
          {item.type === 'publish_new'
            ? 'New to the global library'
            : <>Updates global “{item.target_name}” · based on v{item.base_version_no}{item.stale && <span className="font-semibold text-amber-700"> · global is now v{item.global_version_no}</span>}</>}
        </span>
      </div>

      {item.conflicts.length > 0 && (
        <ul className="mb-4 space-y-1.5 rounded-xl bg-negative/5 p-3 text-xs">
          {item.conflicts.map((c) => (
            <li key={c.path}><span className="font-semibold text-negative">Conflict:</span> <span className="font-mono">{c.path}</span> changed both in this proposal and in global</li>
          ))}
        </ul>
      )}

      <div className={`grid gap-5 ${preview ? 'lg:grid-cols-[1fr_380px]' : ''}`}>
        <div className="min-w-0">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">
            {item.type === 'publish_new' ? 'Contents' : `Changes vs global v${item.base_version_no}`}
          </h3>
          {item.unchanged
            ? <p className="rounded-xl bg-canvas px-4 py-4 text-sm text-ink-faint">No changes — the existing global version is reused.</p>
            : <DiffList diff={{ from: item.base_version_no ?? 0, to: item.source_version_no, changes: item.changes, labels: {} }} />}
        </div>
        {preview && (
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">Preview · {DEFAULT_PERIOD.label}</h3>
            <div className="h-64 rounded-xl border border-line p-3">
              <ChartRenderer chartType={preview.chart_type} data={preview} compact xKey={preview.config.xKey} yKeys={preview.config.yKeys}
                rank={preview.config.rank} scheme={preview.config.scheme} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
