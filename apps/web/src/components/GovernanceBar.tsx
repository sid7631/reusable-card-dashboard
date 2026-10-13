import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { AssetKind, AssetMeta } from '../lib/types';
import Modal from './Modal';
import RebaseDialog from './RebaseDialog';

const EDIT_PATH: Record<AssetKind, (id: number) => string> = {
  cards: (id) => `/cards/${id}/edit`,
  dashboards: (id) => `/dashboards/${id}`,
  'data-sources': (id) => `/data-sources/${id}`,
};

const chip = 'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold';
const action = 'whitespace-nowrap rounded-full border px-3.5 py-1.5 text-xs font-semibold shadow-sm transition';

/**
 * Lineage and publishing actions for an asset:
 * global → "Edit a copy"; private copy → lineage, "Update from global", "Propose changes";
 * new private asset → "Request publish"; anything in review → link to the request.
 */
export default function GovernanceBar({ kind, asset, onChanged }: { kind: AssetKind; asset: AssetMeta; onChanged?: () => void }) {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<'submit' | 'rebase' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const editCopy = async () => {
    setBusy(true);
    try {
      const { id } = await api.fork(kind, asset.id);
      navigate(EDIT_PATH[kind](id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const owner = asset.access === 'owner';
  const fork = asset.fork;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {asset.scope === 'global' && !asset.can_edit && (
        <button onClick={editCopy} disabled={busy} title="Make a private copy you can edit, then propose your changes back"
          className={`${action} border-accent bg-white text-accent hover:bg-accent-soft disabled:opacity-50`}>
          {busy ? 'Opening copy…' : 'Edit a copy'}
        </button>
      )}

      {fork && !fork.deleted && (
        <Link to={EDIT_PATH[kind](fork.asset_id)} title="This is your private copy of a global asset"
          className={`${chip} bg-canvas text-ink-soft hover:text-accent`}>
          Copy of global “{fork.name}” · v{fork.base_version}
        </Link>
      )}
      {fork?.deleted && (
        <span className={`${chip} bg-canvas text-ink-soft`}
          title="An admin deleted the global original. Your copy is kept; proposing it would publish it as a new global asset.">
          Copy of “{fork.name}” · the global original was deleted
        </span>
      )}
      {fork?.stale && asset.can_edit && (
        <button onClick={() => setDialog('rebase')}
          className={`${action} border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100`}>
          Global is now v{fork.global_version} — update from global
        </button>
      )}

      {asset.scope === 'global' && asset.open_requests.length > 0 && (
        <span className={`${chip} bg-amber-50 text-amber-800`}
          title="Open change requests that would change this. Editing or approving one may create conflicts for the others.">
          {asset.open_requests.length === 1 ? '1 open request is' : `${asset.open_requests.length} open requests are`} changing this:
          {asset.open_requests.map((r) => (
            asset.can_edit
              ? <Link key={r.id} to={`/requests/${r.id}`} className="underline hover:text-amber-950">#{r.id} ({r.requested_by_name})</Link>
              : <span key={r.id}>#{r.id} ({r.requested_by_name})</span>
          ))}
        </span>
      )}

      {asset.pending_request_id ? (
        <Link to={`/requests/${asset.pending_request_id}`} className={`${chip} bg-amber-100 text-amber-800 hover:underline`}>
          In review · request #{asset.pending_request_id}
        </Link>
      ) : asset.scope === 'private' && owner && (
        <button onClick={() => setDialog('submit')} className={`${action} border-accent bg-accent text-white hover:bg-accent-deep`}>
          {fork && !fork.deleted ? 'Propose changes' : 'Request publish'}
        </button>
      )}

      {error && <span className="text-xs text-negative">{error}</span>}

      {dialog === 'submit' && <SubmitDialog kind={kind} asset={asset} onClose={() => setDialog(null)} />}
      {dialog === 'rebase' && (
        <RebaseDialog kind={kind} assetId={asset.id} onClose={() => setDialog(null)} onApplied={() => { setDialog(null); onChanged?.(); }} />
      )}
    </div>
  );
}

function SubmitDialog({ kind, asset, onClose }: { kind: AssetKind; asset: AssetMeta; onClose: () => void }) {
  const navigate = useNavigate();
  const updating = asset.fork && !asset.fork.deleted;
  const [title, setTitle] = useState(updating ? `Update “${asset.fork!.name}”` : `Publish “${asset.name}”`);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const req = await api.submitChangeRequest({ kind, asset_id: asset.id, title, description });
      navigate(`/requests/${req.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  const field = 'w-full rounded-lg border border-line px-3 py-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20';
  return (
    <Modal title={updating ? 'Propose changes to global' : 'Request publish to global'}
      subtitle={updating && asset.fork
        ? `An admin reviews your v${asset.version} against global “${asset.fork.name}”.`
        : 'An admin reviews it before it appears in the global library. Private cards it uses are included automatically.'}
      onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-soft">Title</span>
          <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
        </div>
        <div>
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-soft">What and why</span>
          <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} className={field}
            placeholder="Context for the reviewer" />
        </div>
        {error && <p className="text-sm text-negative">{error}</p>}
        <button type="submit" disabled={saving}
          className="w-full rounded-lg bg-accent py-2.5 font-display text-sm font-semibold text-white transition enabled:hover:bg-accent-deep disabled:opacity-50">
          {saving ? 'Submitting…' : 'Submit for review'}
        </button>
      </form>
    </Modal>
  );
}
