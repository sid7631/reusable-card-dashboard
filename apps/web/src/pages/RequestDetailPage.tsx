import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { keys, queryClient, useChangeRequest, useRequestItemPreview } from '../lib/queries';
import type { ChangeRequestDetail, ChangeRequestItem, RequestComment } from '../lib/types';
import { useAuth } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { groupConflicts } from '../lib/conflicts';
import { DEFAULT_PERIOD } from '../components/PeriodSelect';
import ChartRenderer from '../components/ChartRenderer';
import DiffList from '../components/DiffList';
import RequestStatusChip from '../components/RequestStatus';
import RebaseDialog from '../components/RebaseDialog';

/** Highest version an admin may pick (matches the server). */
const MAX_VERSION = 99_999;
const KIND_LABEL = { card: 'Card', dashboard: 'Dashboard', data_source: 'Data source' } as const;
const KIND_PATH = { card: 'cards', dashboard: 'dashboards', data_source: 'data-sources' } as const;
const EDIT_PATH = { card: (id: number) => `/cards/${id}/edit`, dashboard: (id: number) => `/dashboards/${id}`, data_source: (id: number) => `/data-sources/${id}` };

export default function RequestDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const reqQuery = useChangeRequest(id);
  const req = reqQuery.data;
  const [message, setMessage] = useState('');
  // Item id → version the admin chose to publish it as (absent = the suggested next version)
  const [versions, setVersions] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const error = actionError ?? reqQuery.error?.message;

  // Opening the request reads its conversation: refresh the unread badges
  const seen = req ? `${req.id}:${req.comments.length}` : '';
  useEffect(() => {
    if (seen) queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'requests' && q.queryKey[1] !== 'detail' });
  }, [seen]);

  const run = async (work: () => Promise<ChangeRequestDetail>) => {
    setBusy(true);
    setActionError(undefined);
    try {
      queryClient.setQueryData(keys.request(id!), await work());
      setMessage('');
      setVersions({});
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  type Action = 'approve' | 'reject' | 'withdraw' | 'update' | 'request-changes' | 'resubmit';
  const act = (action: Action) => {
    if (action === 'withdraw' && !confirm('Withdraw this request?')) return;
    return run(() => api.decideChangeRequest(req!.id, action, message, action === 'approve' ? versions : undefined));
  };
  const comment = () => run(() => api.commentOnRequest(req!.id, message));

  if (!req) {
    return <div className="px-10 py-8">{error ? <p className="text-negative">{error}</p> : <div className="size-6 animate-spin rounded-full border-2 border-line border-t-accent" />}</div>;
  }

  const root = req.items.find((i) => i.source_asset_id === req.root_asset_id);
  const isRequester = req.is_requester;
  const lastAsk = [...req.comments].reverse().find((c) => c.kind === 'changes_requested');
  const text = message.trim();
  const versionTooLow = req.items.some((i) => { const v = versions[i.id] ?? i.suggested_major; return v < i.min_major || v > MAX_VERSION; });
  const decided = !['pending', 'changes_requested'].includes(req.status);

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
            {' · '}<a href="#conversation" className="font-semibold text-accent hover:underline">
              {req.comments.filter((c) => c.kind === 'comment').length || 'No'} message{req.comments.filter((c) => c.kind === 'comment').length === 1 ? '' : 's'}
            </a>
          </p>
          {req.description && <p className="mt-3 max-w-3xl whitespace-pre-wrap text-sm text-ink">{req.description}</p>}
        </div>
      </div>

      {decided && req.reviewed_by_name && (
        <div className={`mt-5 rounded-xl border px-4 py-3 text-sm ${req.status === 'approved' ? 'border-positive/30 bg-positive/5' : 'border-negative/30 bg-negative/5'}`}>
          <span className="font-semibold">{req.status === 'approved' ? 'Approved' : 'Rejected'} by {req.reviewed_by_name}</span>
          {req.decided_at && <span className="text-ink-soft"> · {new Date(req.decided_at).toLocaleString()}</span>}
          {req.review_comment && <p className="mt-1 text-ink">{req.review_comment}</p>}
          {req.status === 'rejected' && isRequester && (
            <p className="mt-1 text-xs text-ink-soft">Your copy is unchanged. Edit it and send a new request when you're ready.</p>
          )}
        </div>
      )}

      {req.status === 'changes_requested' && (
        <div className="mt-5 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-ink">
          <span className="font-semibold text-sky-900">
            {isRequester ? `${lastAsk?.author_name ?? 'The reviewer'} asked for changes.` : `Waiting for ${req.requested_by_name} to make changes.`}
          </span>
          {lastAsk?.body && <p className="mt-1 whitespace-pre-wrap">“{lastAsk.body}”</p>}
          {isRequester && (
            <p className="mt-1 text-xs text-ink-soft">
              Edit your copy (or resolve the conflicts below), then use <span className="font-semibold">Send back for review</span> at the bottom.
            </p>
          )}
        </div>
      )}

      {!decided && req.has_conflicts && (
        <div className="mt-5 rounded-xl border border-negative/30 bg-negative/5 px-4 py-3 text-sm text-ink">
          <span className="font-semibold text-negative">Conflicts with the current global version.</span>{' '}
          {req.can_update
            ? 'Use “Resolve conflicts” on the item below and choose your version or global’s for each one. Your copy is updated and this request picks it up automatically.'
            : 'It can’t be approved until the requester resolves them — ask in the conversation, or use Request changes.'}
        </div>
      )}

      <div className="mt-6 space-y-5">
        {req.items.map((item) => (
          <ItemPanel key={item.id} requestId={req.id} item={item} isRoot={item.source_asset_id === req.root_asset_id}
            publishAs={req.can_approve && !item.unchanged ? versions[item.id] ?? item.suggested_major : undefined}
            canResolve={req.can_update} isAdmin={user.role === 'admin'}
            onPublishAs={(v) => setVersions((cur) => ({ ...cur, [item.id]: v }))} />
        ))}
      </div>

      <Conversation comments={req.comments} />

      {req.can_comment && (
        <div className="sticky bottom-0 mt-4 rounded-2xl border border-line bg-white p-4 shadow-lg">
          <textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder={user.role === 'admin'
              ? 'Write a message — or a note for Request changes / Reject (required for those)'
              : req.can_resubmit ? 'Write a message — or a note to send back with your changes' : 'Write a message to the reviewer'}
            className="mb-3 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20" />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {error && <span className="mr-auto text-sm text-negative">{error}</span>}
            <button onClick={comment} disabled={busy || !text}
              className="mr-auto rounded-lg border border-accent px-4 py-2 text-sm font-semibold text-accent transition enabled:hover:bg-accent-soft disabled:opacity-40">
              Comment
            </button>
            {req.can_update && !req.can_resubmit && (
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
            {req.can_resubmit && (
              <button onClick={() => act('resubmit')} disabled={busy}
                title={req.has_conflicts ? 'Resolve the conflicts first, or the reviewer still can’t approve' : 'Back to the review queue, with your latest versions'}
                className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-white transition enabled:hover:bg-accent-deep disabled:opacity-40">
                Send back for review
              </button>
            )}
            {req.can_reject && (
              <button onClick={() => act('reject')} disabled={busy || !text} title={text ? 'Close the request — it won’t be published' : 'Write why first'}
                className="rounded-lg border border-negative px-4 py-2 text-sm font-semibold text-negative transition enabled:hover:bg-negative/10 disabled:opacity-40">
                Reject
              </button>
            )}
            {req.can_request_changes && (
              <button onClick={() => act('request-changes')} disabled={busy || !text}
                title={text ? 'Send it back to the requester — the request stays open' : 'Write what should change first'}
                className="rounded-lg border border-sky-400 px-4 py-2 text-sm font-semibold text-sky-800 transition enabled:hover:bg-sky-50 disabled:opacity-40">
                Request changes
              </button>
            )}
            {user.role === 'admin' && req.status === 'pending' && (
              <button onClick={() => act('approve')} disabled={busy || !req.can_approve || versionTooLow}
                title={req.has_conflicts ? 'Resolve conflicts first' : 'Publish to the global library'}
                className="rounded-lg bg-positive px-5 py-2 text-sm font-semibold text-white transition enabled:hover:opacity-90 disabled:opacity-40">
                Approve & publish
              </button>
            )}
          </div>
          {user.role === 'admin' && req.status === 'pending' && !req.can_approve && req.has_conflicts && (
            <p className="mt-2 text-right text-[11px] text-ink-faint">Approve is off while there are conflicts — the requester resolves them in their copy.</p>
          )}
        </div>
      )}
    </div>
  );
}

const EVENT: Record<RequestComment['kind'], { verb: string; tone: string } | null> = {
  comment: null,
  changes_requested: { verb: 'requested changes', tone: 'border-sky-200 bg-sky-50' },
  resubmitted: { verb: 'sent it back for review', tone: 'border-amber-200 bg-amber-50' },
  approved: { verb: 'approved and published', tone: 'border-positive/30 bg-positive/5' },
  rejected: { verb: 'rejected the request', tone: 'border-negative/30 bg-negative/5' },
  withdrawn: { verb: 'withdrew the request', tone: 'border-line bg-canvas' },
};

/** Messages and review steps, oldest first. */
function Conversation({ comments }: { comments: RequestComment[] }) {
  return (
    <section id="conversation" className="mt-8">
      <h2 className="mb-3 font-display text-base font-bold text-ink">Conversation</h2>
      {!comments.length && (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-ink-faint">
          No messages yet. Ask a question or explain a choice — nothing gets approved or rejected by commenting.
        </p>
      )}
      <ol className="space-y-3">
        {comments.map((c) => {
          const event = EVENT[c.kind];
          return (
            <li key={c.id} className="flex gap-3">
              <span className={`flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                c.author_role === 'admin' ? 'bg-accent text-white' : 'bg-accent-soft text-accent'}`}>
                {c.author_name.split(' ').map((w) => w[0]).join('').slice(0, 2)}
              </span>
              <div className={`min-w-0 flex-1 rounded-xl border px-4 py-2.5 ${event ? event.tone : 'border-line bg-white'}`}>
                <p className="text-xs text-ink-soft">
                  <span className="font-semibold text-ink">{c.author_name}</span>
                  {c.author_role === 'admin' && <span className="ml-1.5 rounded bg-accent/10 px-1 py-px text-[9px] font-bold uppercase text-accent">Admin</span>}
                  {event && <span className="font-semibold text-ink"> {event.verb}</span>}
                  <span className="text-ink-faint" title={new Date(c.created_at).toLocaleString()}> · {timeAgo(c.created_at)}</span>
                </p>
                {c.body && <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{c.body}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const PREVIEW_PERIOD = { from: DEFAULT_PERIOD.from, to: DEFAULT_PERIOD.to };

function ItemPanel({ requestId, item, isRoot, publishAs, onPublishAs, canResolve, isAdmin }: {
  requestId: number; item: ChangeRequestItem; isRoot: boolean; isAdmin: boolean;
  /** The requester, on an open request: may update their copy from global here. */
  canResolve: boolean;
  /** Admin reviewing: the global version approval publishes this item as (editable). */
  publishAs?: number;
  onPublishAs: (version: number) => void;
}) {
  const { data: preview } = useRequestItemPreview(requestId, item.id, item.source_version_no, PREVIEW_PERIOD, item.kind === 'card');
  const [resolving, setResolving] = useState(false);

  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-accent-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">{KIND_LABEL[item.kind]}</span>
        <h2 className="font-display text-base font-bold text-ink">{item.name}</h2>
        <span className="font-mono text-xs text-ink-faint">proposed v{item.source_version}</span>
        {!isRoot && <span className="rounded-md bg-canvas px-2 py-0.5 text-[10px] font-semibold text-ink-soft">included dependency</span>}
        {item.result_version && (
          <span className="rounded-md bg-positive/10 px-2 py-0.5 font-mono text-[11px] font-semibold text-positive">published as v{item.result_version}</span>
        )}
        {publishAs !== undefined && (
          <label className="flex items-center gap-1.5 rounded-lg border border-line bg-canvas/60 px-2 py-1 text-xs text-ink-soft"
            title={`Suggested: v${item.suggested_major}. You can publish as a higher version, e.g. for a breaking change.`}>
            Publish as v
            <input type="number" min={item.min_major} max={MAX_VERSION} step={1} value={publishAs} aria-label="Version to publish as"
              onChange={(e) => onPublishAs(Math.floor(Number(e.target.value)))}
              className={`w-14 rounded-md border bg-white px-1.5 py-0.5 font-mono text-xs font-semibold text-ink outline-none focus:border-accent ${
                publishAs < item.min_major || publishAs > MAX_VERSION ? 'border-negative' : 'border-line'}`} />
            {publishAs !== item.suggested_major && (
              <button onClick={() => onPublishAs(item.suggested_major)} className="text-[11px] font-semibold text-accent hover:underline">
                reset to v{item.suggested_major}
              </button>
            )}
          </label>
        )}
        <span className="ml-auto text-xs text-ink-soft">
          {item.type === 'publish_new'
            ? 'New to the global library'
            : <>Updates global “{item.target_name}” · based on v{item.base_version}{item.stale && <span className="font-semibold text-amber-700"> · global is now v{item.global_version}</span>}</>}
        </span>
      </div>

      {item.target_deleted && (
        <p className="mb-4 rounded-xl border border-negative/30 bg-negative/5 px-3 py-2 text-xs text-ink">
          <span className="font-semibold text-negative">The global “{item.target_name}” was deleted</span> after this was sent, so
          there's nothing to update and it can't be approved.{' '}
          {isAdmin ? 'Reject it, or restore the original from the Deleted tab first.'
            : 'Withdraw it and send it again — it would then be proposed as a new global item.'}
        </p>
      )}

      {isAdmin && (item.also_affects?.length ?? 0) > 0 && (
        <p className="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Approving this also affects {item.also_affects!.map((r, i) => (
            <span key={r.id}>{i > 0 && ', '}<Link to={`/requests/${r.id}`} className="font-semibold underline">request #{r.id} ({r.requested_by_name})</Link></span>
          ))}, which also changes “{item.target_name}” — {item.also_affects!.length === 1 ? 'it' : 'they'} may then need to update from global.
        </p>
      )}

      {item.conflicts.length > 0 && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-xl bg-negative/5 p-3 text-xs">
          <ul className="space-y-1.5">
            {groupConflicts(item.conflicts).map((g) => (
              <li key={g.paths[0]}>
                <span className="font-semibold text-negative">Conflict:</span> <span className="font-semibold">{g.label}</span> was changed both here and in global (now v{item.global_version})
                {g.linked.length > 0 && <span className="text-ink-faint"> — with its builder settings</span>}
              </li>
            ))}
          </ul>
          {canResolve ? (
            <button onClick={() => setResolving(true)}
              className="shrink-0 rounded-lg bg-negative px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90">
              Resolve conflicts
            </button>
          ) : (
            <span className="text-ink-soft">Waiting for the requester to resolve.</span>
          )}
        </div>
      )}
      {resolving && (
        <RebaseDialog kind={KIND_PATH[item.kind]} assetId={item.source_asset_id}
          onClose={() => setResolving(false)} onApplied={() => setResolving(false)} />
      )}

      <div className={`grid gap-5 ${preview ? 'lg:grid-cols-[1fr_380px]' : ''}`}>
        <div className="min-w-0">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">
            {item.type === 'publish_new' ? 'Contents' : `Changes vs global v${item.base_version}`}
          </h3>
          {item.unchanged
            ? <p className="rounded-xl bg-canvas px-4 py-4 text-sm text-ink-faint">No changes — the existing global version is reused.</p>
            : <DiffList diff={{ from: item.base_version ?? 0, to: item.source_version, changes: item.changes, labels: item.labels ?? {} }} />}
        </div>
        {preview && (
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">Preview · {DEFAULT_PERIOD.label}</h3>
            <div className="h-64 rounded-xl border border-line p-3">
              <ChartRenderer chartType={preview.chart_type} data={preview} compact xKey={preview.config.xKey} yKeys={preview.config.yKeys}
                rank={preview.config.rank} scheme={preview.config.scheme} format={preview.config.format} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
