import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { DataSource, DataSourceSpec, Row, SemanticModel, SourceType, TableInfo } from '../lib/types';
import AssetBadges from '../components/AssetBadges';
import GovernanceBar from '../components/GovernanceBar';
import ModelEditor from '../components/ModelEditor';
import ShareDialog from '../components/ShareDialog';
import VersionHistory from '../components/VersionHistory';
import { SOURCE_TYPE_LABEL } from './DataSourcesPage';
import { useAuth } from '../lib/auth';

const field = 'w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:bg-canvas';
const label = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-soft';

const TYPES: { id: SourceType; title: string; text: string }[] = [
  { id: 'postgres', title: 'Postgres', text: 'Query a database directly — SQL runs on the source with a read-only connection.' },
  { id: 'bigquery', title: 'BigQuery', text: 'Query a BigQuery dataset in place, with a cap on the data each query may scan.' },
  { id: 'rest', title: 'REST API', text: 'Fetch JSON records; they are copied into a fast local extract and refreshed on a schedule.' },
  { id: 'file', title: 'File upload', text: 'CSV, Excel (each sheet becomes a table) or JSON — loaded once into a local extract.' },
];

function blankSpec(type: SourceType): DataSourceSpec {
  return {
    type,
    connection: type === 'postgres' ? { host: '', port: 5432, database: '', user: '' } : null,
    rest: type === 'rest' ? {
      url: '', headers: {}, query: {}, records_path: '', table: 'records',
      auth: { type: 'none', header: 'X-API-Key', username: '' },
      pagination: { type: 'none', page_param: 'page', size_param: null, page_size: 100, max_pages: 20 },
    } : null,
    file: null,
    bigquery: type === 'bigquery'
      ? { project: '', dataset: '', location: null, auth: 'service_account', maximum_bytes_billed: 10 * 1024 ** 3 }
      : null,
    execution: { max_concurrency: 5, timeout_s: 30, cache_ttl_s: 900 },
    model: { datasets: [] },
  };
}

/** Strip stored-secret references before sending: the server keeps or replaces them. */
function outgoing(spec: DataSourceSpec): DataSourceSpec {
  return {
    ...spec,
    connection: spec.connection && { ...spec.connection, secret_ref: undefined },
    rest: spec.rest && { ...spec.rest, auth: { ...spec.rest.auth, secret_ref: undefined } },
    bigquery: spec.bigquery && { ...spec.bigquery, secret_ref: undefined },
  };
}

export default function DataSourceEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = Boolean(id);
  const { user } = useAuth();

  const [source, setSource] = useState<DataSource>();
  const [spec, setSpec] = useState<DataSourceSpec>();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [secret, setSecret] = useState('');
  const [changeNote, setChangeNote] = useState('');
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [suggested, setSuggested] = useState<SemanticModel>();
  const [sample, setSample] = useState<Row[]>();
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [dialog, setDialog] = useState<'history' | 'share' | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const canEdit = !editing || Boolean(source?.can_edit);

  const runTest = useCallback(async (s: DataSourceSpec, opts: { secret?: string; sourceId?: number; adoptModel?: boolean } = {}) => {
    setTesting(true);
    setTestError(undefined);
    try {
      const res = await api.testDataSource(outgoing(s), opts.secret || undefined, opts.sourceId);
      setTables(res.tables);
      setSuggested(res.suggested_model);
      setSample(res.sample);
      if (opts.adoptModel) setSpec((cur) => cur && !cur.model.datasets.length ? { ...cur, model: res.suggested_model } : cur);
    } catch (e) {
      setTestError((e as Error).message);
    } finally {
      setTesting(false);
    }
  }, []);

  useEffect(() => {
    if (!id) return;
    api.dataSource(id).then((s) => {
      setSource(s);
      setSpec(s.spec);
      setName(s.name);
      setDescription(s.description);
      setSecret('');
      runTest(s.spec, { sourceId: s.id });
    }).catch(() => navigate('/data-sources'));
  }, [id, navigate, runTest, reloadKey]);

  const patch = (fn: (s: DataSourceSpec) => DataSourceSpec) => setSpec((s) => s && fn(s));

  const upload = async (file: File) => {
    setTesting(true);
    setTestError(undefined);
    try {
      const res = await api.uploadFile(file);
      setTables(res.tables);
      setSuggested(res.suggested_model);
      setSample(undefined);
      patch((s) => ({ ...s, file: { file_id: res.id }, model: res.suggested_model }));
      if (!name) setName(file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
    } catch (e) {
      setTestError((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!spec) return;
    setSaving(true);
    setError(undefined);
    const payload = { name, description, spec: outgoing(spec), credentials: secret ? { secret } : null, change_note: changeNote };
    try {
      if (editing) {
        await api.updateDataSource(source!.id, payload);
        setChangeNote('');
        setReloadKey((k) => k + 1);
      } else {
        const created = await api.createDataSource(payload);
        navigate(`/data-sources/${created.id}`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // ---------------------------------------------------------------- type picker (new sources)
  if (!spec) {
    if (editing) return <div className="px-10 py-8"><div className="size-6 animate-spin rounded-full border-2 border-line border-t-accent" /></div>;
    return (
      <div className="px-10 py-8">
        <Link to="/data-sources" className="text-xs font-semibold text-ink-soft hover:text-accent">← Data sources</Link>
        <h1 className="mt-3 font-display text-2xl font-extrabold tracking-tight text-ink">New data source</h1>
        <p className="mt-1 text-sm text-ink-soft">What kind of data are you connecting?</p>
        <div className="mt-6 grid max-w-5xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TYPES.map((t) => (
            <button key={t.id} onClick={() => setSpec(blankSpec(t.id))}
              className="rounded-2xl border border-line bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-lg">
              <p className="font-display text-base font-bold text-ink">{t.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-soft">{t.text}</p>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const conn = spec.connection;
  const rest = spec.rest;
  const bq = spec.bigquery;
  const secretLabel = spec.type === 'postgres' ? 'Password' : spec.type === 'bigquery' ? 'Service-account key (JSON)'
    : rest?.auth.type === 'basic' ? 'Password' : rest?.auth.type === 'api_key' ? 'API key' : 'Token';
  const needsSecret = spec.type === 'postgres' || (bq && bq.auth === 'service_account') || (rest && rest.auth.type !== 'none');
  const testable = spec.type === 'postgres' ? Boolean(conn?.host && conn.database && conn.user)
    : spec.type === 'rest' ? Boolean(rest?.url)
      : spec.type === 'bigquery' ? Boolean(bq?.project && bq.dataset && (bq.auth === 'adc' || secret || source?.has_credentials)) : false;

  return (
    <div className="px-10 py-8 pb-28">
      <Link to="/data-sources" className="text-xs font-semibold text-ink-soft hover:text-accent">← Data sources</Link>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-ink">{editing ? name || 'Data source' : `New ${SOURCE_TYPE_LABEL[spec.type]} source`}</h1>
            {source && <AssetBadges asset={source} />}
          </div>
          {source && <div className="mt-2"><GovernanceBar kind="data-sources" asset={source} onChanged={() => setReloadKey((k) => k + 1)} /></div>}
        </div>
        {source && (
          <div className="flex gap-2">
            <button onClick={() => setDialog('history')} className="rounded-full border border-line bg-white px-4 py-2 text-xs font-semibold text-ink-soft shadow-sm transition hover:text-ink">History</button>
            {source.access === 'owner' && (
              <button onClick={() => setDialog('share')} className="rounded-full border border-line bg-white px-4 py-2 text-xs font-semibold text-ink-soft shadow-sm transition hover:text-ink">Share</button>
            )}
          </div>
        )}
      </div>

      <div className="mt-6 grid max-w-6xl grid-cols-1 gap-6 xl:grid-cols-[minmax(0,420px)_1fr]">
        {/* ---------------------------------------------------------------- connection */}
        <section className="space-y-4 rounded-2xl border border-line bg-white p-5 shadow-sm">
          <h2 className="font-display text-sm font-bold uppercase tracking-wide text-ink-soft">
            {spec.type === 'file' ? 'File' : 'Connection'}
          </h2>

          {conn && (
            <>
              <div className="grid grid-cols-[1fr_96px] gap-2">
                <div><span className={label}>Host</span><input disabled={!canEdit} value={String(conn.host)} onChange={(e) => patch((s) => ({ ...s, connection: { ...conn, host: e.target.value } }))} className={field} placeholder="db.example.com" /></div>
                <div><span className={label}>Port</span><input disabled={!canEdit} value={String(conn.port)} onChange={(e) => patch((s) => ({ ...s, connection: { ...conn, port: e.target.value } }))} className={field} /></div>
              </div>
              <div><span className={label}>Database</span><input disabled={!canEdit} value={conn.database} onChange={(e) => patch((s) => ({ ...s, connection: { ...conn, database: e.target.value } }))} className={field} /></div>
              <div><span className={label}>User</span><input disabled={!canEdit} value={conn.user} onChange={(e) => patch((s) => ({ ...s, connection: { ...conn, user: e.target.value } }))} className={field} placeholder="a read-only role" /></div>
            </>
          )}

          {rest && (
            <>
              <div><span className={label}>URL</span><input disabled={!canEdit} value={rest.url} onChange={(e) => patch((s) => ({ ...s, rest: { ...rest, url: e.target.value } }))} className={field} placeholder="https://api.example.com/v1/orders" /></div>
              <div className="grid grid-cols-2 gap-2">
                <div><span className={label}>Records path</span><input disabled={!canEdit} value={rest.records_path} onChange={(e) => patch((s) => ({ ...s, rest: { ...rest, records_path: e.target.value } }))} className={field} placeholder="data.items" /></div>
                <div><span className={label}>Table name</span><input disabled={!canEdit} value={rest.table} onChange={(e) => patch((s) => ({ ...s, rest: { ...rest, table: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') } }))} className={field} /></div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className={label}>Auth</span>
                  <select disabled={!canEdit} value={rest.auth.type} onChange={(e) => patch((s) => ({ ...s, rest: { ...rest, auth: { ...rest.auth, type: e.target.value as typeof rest.auth.type } } }))} className={field}>
                    <option value="none">None</option><option value="bearer">Bearer token</option><option value="api_key">API key header</option><option value="basic">Basic auth</option>
                  </select>
                </div>
                {rest.auth.type === 'api_key' && <div><span className={label}>Header</span><input disabled={!canEdit} value={rest.auth.header} onChange={(e) => patch((s) => ({ ...s, rest: { ...rest, auth: { ...rest.auth, header: e.target.value } } }))} className={field} /></div>}
                {rest.auth.type === 'basic' && <div><span className={label}>Username</span><input disabled={!canEdit} value={rest.auth.username} onChange={(e) => patch((s) => ({ ...s, rest: { ...rest, auth: { ...rest.auth, username: e.target.value } } }))} className={field} /></div>}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className={label}>Pagination</span>
                  <select disabled={!canEdit} value={rest.pagination.type} onChange={(e) => patch((s) => ({ ...s, rest: { ...rest, pagination: { ...rest.pagination, type: e.target.value as 'none' | 'page' } } }))} className={field}>
                    <option value="none">Single request</option><option value="page">Page number</option>
                  </select>
                </div>
                {rest.pagination.type === 'page' && (
                  <div><span className={label}>Page param</span><input disabled={!canEdit} value={rest.pagination.page_param} onChange={(e) => patch((s) => ({ ...s, rest: { ...rest, pagination: { ...rest.pagination, page_param: e.target.value } } }))} className={field} /></div>
                )}
              </div>
              {rest.pagination.type === 'page' && (
                <div className="grid grid-cols-3 gap-2">
                  <div><span className={label}>Size param</span><input disabled={!canEdit} value={rest.pagination.size_param ?? ''} onChange={(e) => patch((s) => ({ ...s, rest: { ...rest, pagination: { ...rest.pagination, size_param: e.target.value || null } } }))} className={field} placeholder="per_page" /></div>
                  <div><span className={label}>Page size</span><input disabled={!canEdit} type="number" value={rest.pagination.page_size} onChange={(e) => patch((s) => ({ ...s, rest: { ...rest, pagination: { ...rest.pagination, page_size: Number(e.target.value) } } }))} className={field} /></div>
                  <div><span className={label}>Max pages</span><input disabled={!canEdit} type="number" value={rest.pagination.max_pages} onChange={(e) => patch((s) => ({ ...s, rest: { ...rest, pagination: { ...rest.pagination, max_pages: Number(e.target.value) } } }))} className={field} /></div>
                </div>
              )}
            </>
          )}

          {bq && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div><span className={label}>Project ID</span><input disabled={!canEdit} value={bq.project} onChange={(e) => patch((s) => ({ ...s, bigquery: { ...bq, project: e.target.value.trim() } }))} className={field} placeholder="my-gcp-project" /></div>
                <div><span className={label}>Dataset</span><input disabled={!canEdit} value={bq.dataset} onChange={(e) => patch((s) => ({ ...s, bigquery: { ...bq, dataset: e.target.value.trim() } }))} className={field} placeholder="analytics" /></div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div><span className={label}>Location</span><input disabled={!canEdit} value={bq.location ?? ''} onChange={(e) => patch((s) => ({ ...s, bigquery: { ...bq, location: e.target.value.trim() || null } }))} className={field} placeholder="US, EU, asia-south1…" /></div>
                <div>
                  <span className={label}>Max scanned per query</span>
                  <select disabled={!canEdit} value={bq.maximum_bytes_billed} onChange={(e) => patch((s) => ({ ...s, bigquery: { ...bq, maximum_bytes_billed: Number(e.target.value) } }))} className={field}>
                    {[1, 5, 10, 50, 100, 500].map((gb) => <option key={gb} value={gb * 1024 ** 3}>{gb} GB</option>)}
                  </select>
                </div>
              </div>
              <div>
                <span className={label}>Authentication</span>
                <select disabled={!canEdit} value={bq.auth} onChange={(e) => patch((s) => ({ ...s, bigquery: { ...bq, auth: e.target.value as 'service_account' | 'adc' } }))} className={field}>
                  <option value="service_account">Service-account key</option>
                  <option value="adc" disabled={user.role !== 'admin' && bq.auth !== 'adc'}>Server's Google identity (admins)</option>
                </select>
                <p className="mt-1 text-[11px] text-ink-faint">Grant the account <span className="font-mono">BigQuery Data Viewer</span> and <span className="font-mono">BigQuery Job User</span> only. Queries over the scan limit fail before running and cost nothing.</p>
              </div>
            </>
          )}

          {needsSecret && (
            <div>
              <span className={label}>{secretLabel}</span>
              {spec.type === 'bigquery' ? (
                <textarea disabled={!canEdit} rows={4} value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false}
                  className={`${field} font-mono text-xs`} placeholder={source?.has_credentials ? 'Stored — leave blank to keep' : 'Paste the JSON key file contents'} />
              ) : (
              <input disabled={!canEdit} type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} className={field}
                placeholder={source?.has_credentials ? 'Stored — leave blank to keep' : ''} />
              )}
              <p className="mt-1 text-[11px] text-ink-faint">Encrypted at rest and never shown again. Changing the host, URL or project requires re-entering it.</p>
            </div>
          )}

          {spec.type === 'file' && (
            <div>
              {canEdit && (
                <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-line px-4 py-8 text-center transition hover:border-accent/50">
                  <span className="font-display text-sm font-semibold text-ink">{spec.file ? 'Replace file' : 'Choose a file'}</span>
                  <span className="mt-1 text-xs text-ink-faint">CSV, Excel (.xlsx) or JSON · up to 50 MB</span>
                  <input type="file" accept=".csv,.tsv,.xlsx,.xlsm,.json" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
                </label>
              )}
              {spec.file && <p className="mt-2 text-xs text-ink-soft">Uploaded file #{spec.file.file_id} · {tables.length} table{tables.length === 1 ? '' : 's'}</p>}
            </div>
          )}

          {spec.type !== 'file' && canEdit && (
            <div className="flex items-center gap-3">
              <span className={label.replace('mb-1 block ', '')}>Refresh / cache</span>
              <select value={spec.execution.cache_ttl_s} onChange={(e) => patch((s) => ({ ...s, execution: { ...s.execution, cache_ttl_s: Number(e.target.value) } }))} className={`${field} !w-auto !py-1.5`}>
                {[[300, '5 minutes'], [900, '15 minutes'], [3600, '1 hour'], [21600, '6 hours'], [86400, '1 day']].map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
            </div>
          )}

          {spec.type !== 'file' && (
            <button onClick={() => runTest(spec, { secret, sourceId: source?.id, adoptModel: true })} disabled={!testable || testing}
              className="w-full rounded-lg border border-accent py-2 font-display text-sm font-semibold text-accent transition enabled:hover:bg-accent-soft disabled:opacity-40">
              {testing ? 'Connecting…' : 'Test connection'}
            </button>
          )}
          {testError && <p className="rounded-lg bg-negative/5 px-3 py-2 text-xs text-negative">{testError}</p>}
          {!testError && tables.length > 0 && !testing && (
            <p className="rounded-lg bg-positive/5 px-3 py-2 text-xs text-positive">
              Connected · {tables.length} table{tables.length === 1 ? '' : 's'} found
            </p>
          )}
        </section>

        {/* ---------------------------------------------------------------- model */}
        <section className="min-w-0 space-y-4">
          <div className="rounded-2xl border border-line bg-white p-5 shadow-sm">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div><span className={label}>Name</span><input disabled={!canEdit} value={name} onChange={(e) => setName(e.target.value)} className={field} placeholder="e.g. Finance warehouse" /></div>
              <div><span className={label}>Description</span><input disabled={!canEdit} value={description} onChange={(e) => setDescription(e.target.value)} className={field} placeholder="What's in it, who owns it" /></div>
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="font-display text-sm font-bold uppercase tracking-wide text-ink-soft">Semantic model</h2>
                <p className="text-xs text-ink-faint">Pick the tables to expose and describe each column in business terms.</p>
              </div>
              {suggested && canEdit && (
                <button onClick={() => patch((s) => ({ ...s, model: suggested }))} className="text-xs font-semibold text-accent hover:underline">Reset to suggestion</button>
              )}
            </div>
            {tables.length ? (
              canEdit
                ? <ModelEditor tables={tables} model={spec.model} suggested={suggested} onChange={(model) => patch((s) => ({ ...s, model }))} />
                : <ul className="space-y-1 text-sm">{spec.model.datasets.map((d) => <li key={d.name}><span className="font-semibold">{d.label || d.name}</span> · {d.dimensions.length} dimensions · {d.measures.length} measures</li>)}</ul>
            ) : (
              <p className="rounded-xl bg-canvas px-4 py-8 text-center text-sm text-ink-faint">
                {testing ? 'Reading tables…' : spec.type === 'file' ? 'Upload a file to see its tables.' : 'Test the connection to see its tables.'}
              </p>
            )}
          </div>

          {sample && sample.length > 0 && (
            <div className="rounded-2xl border border-line bg-white p-5 shadow-sm">
              <h2 className="mb-2 font-display text-sm font-bold uppercase tracking-wide text-ink-soft">Sample records</h2>
              <div className="max-h-56 overflow-auto">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-white"><tr>{Object.keys(sample[0]).map((k) => <th key={k} className="border-b border-line px-2 py-1 font-semibold text-ink-soft">{k}</th>)}</tr></thead>
                  <tbody>{sample.map((r, i) => <tr key={i}>{Object.keys(sample[0]).map((k) => <td key={k} className="px-2 py-1 font-mono">{String(r[k] ?? '')}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      </div>

      {canEdit && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 px-10 py-3 backdrop-blur">
          <div className="ml-auto flex max-w-6xl items-center justify-end gap-3">
            {error && <span className="mr-auto text-sm text-negative">{error}</span>}
            {editing && <input value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="What changed?" className={`${field} !w-64`} />}
            <button onClick={save} disabled={saving || !name.trim() || !spec.model.datasets.length}
              title={!spec.model.datasets.length ? 'Expose at least one table' : undefined}
              className="rounded-xl bg-accent px-5 py-2.5 font-display text-sm font-semibold text-white shadow-sm transition enabled:hover:bg-accent-deep disabled:opacity-40">
              {saving ? 'Saving…' : editing ? `Save as v${(source?.version_no ?? 0) + 1}` : 'Create private source'}
            </button>
          </div>
        </div>
      )}

      {dialog === 'history' && source && (
        <VersionHistory kind="data-sources" assetId={source.id} assetName={source.name} canEdit={source.can_edit}
          onClose={() => setDialog(null)} onRestored={() => setReloadKey((k) => k + 1)} />
      )}
      {dialog === 'share' && source && <ShareDialog kind="data-sources" assetId={source.id} assetName={source.name} onClose={() => setDialog(null)} />}
    </div>
  );
}
