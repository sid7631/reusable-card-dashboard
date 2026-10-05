import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { api } from '../lib/api';
import { useCard, useDatasets } from '../lib/queries';
import { TEMPORAL_TYPES, type CardConfig, type CardFilter, type ChartType, type Dataset, type Row } from '../lib/types';
import { SCHEMES } from '../lib/format';
import { copilotRespond, toSemanticQuery } from '../lib/builder';
import ChartRenderer from '../components/ChartRenderer';
import Modal from '../components/Modal';
import VersionHistory from '../components/VersionHistory';
import GovernanceBar from '../components/GovernanceBar';

type Mode = 'builder' | 'sql' | 'copilot';

const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: 'kpi', label: 'KPI' },
  { id: 'barlist', label: 'Bar list' },
  { id: 'bar', label: 'Bar' },
  { id: 'column', label: 'Column' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
  { id: 'donut', label: 'Donut' },
  { id: 'table', label: 'Table' },
];


interface ChatMsg {
  role: 'user' | 'copilot';
  text: string;
}

const field = 'w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20';
const label = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-soft';

const EMPTY_DATASETS: Dataset[] = [];

export default function CardStudio() {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = Boolean(id);

  const [mode, setMode] = useState<Mode>('builder');
  const [chartType, setChartType] = useState<ChartType>('bar');
  const [config, setConfig] = useState<CardConfig>({ dimension: 'industry', metric: 'amount', agg: 'SUM', filters: [] });
  // Raw SQL in SQL mode; the compiled semantic query (read-only) in builder / copilot modes
  const [sqlText, setSqlText] = useState('');
  const datasets = useDatasets().data ?? EMPTY_DATASETS;
  const [sourceId, setSourceId] = useState<number>();
  const dataset = datasets.find((d) => d.id === sourceId) ?? null;

  // Builder vocabulary comes from the source's semantic model: dimensions and measures by name
  const primary = dataset?.model.datasets.find((d) => d.name === dataset.name) ?? dataset?.model.datasets[0];
  const timeColumn = primary
    ? primary.dimensions.find((d) => d.name === primary.time_dimension || d.column === primary.time_dimension)?.name ?? null
    : null;
  const dimensions = (primary?.dimensions ?? []).map((d) => ({
    id: d.name, label: d.name === timeColumn ? `${d.label || d.name} (time series)` : d.label || d.name,
  }));
  const measures = (primary?.measures ?? []).map((m) => ({ id: m.name, label: m.label || m.name }));
  const numericColumns_ = (dataset?.columns ?? []).filter((c) => /int|numeric|decimal|double|real|float/i.test(c.type)).map((c) => c.name);
  const semanticKey = primary && dataset ? JSON.stringify({ source: dataset.id, query: toSemanticQuery(chartType, config, primary.name, timeColumn) }) : '';

  const [rows, setRows] = useState<Row[]>([]);
  const [queryMs, setQueryMs] = useState<number | null>(null);
  const [queryError, setQueryError] = useState<string>();
  const [running, setRunning] = useState(false);

  const [messages, setMessages] = useState<ChatMsg[]>([
    { role: 'copilot', text: 'Hi! Describe the widget you want and I\'ll configure it for you.\n\nTry: "Top 5 merchants by charge volume" or "monthly spend trend for Platinum".' },
  ]);
  const [chatInput, setChatInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [changeNote, setChangeNote] = useState('');
  // Global cards are read-only for non-admins (fork + propose arrives with the approval flow)
  const cardQuery = useCard(id, { editor: true });
  const card = cardQuery.data;
  const canEdit = card?.can_edit ?? true;
  const versionNo = card?.version_no;
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    setSourceId((cur) => cur ?? datasets.find((x) => !x.error)?.id);
  }, [datasets]);

  const chooseSource = (id: number) => setSourceId(id);

  // Keep builder choices valid for the selected source: anything the source doesn't have falls back
  // to its first dimension / numeric column (new cards, or switching source)
  const dimensionIds = dimensions.map((d) => d.id).join('|');
  const numericKey = numericColumns_.join('|');
  const measureIds = measures.map((m) => m.id).join('|');
  useEffect(() => {
    if (!dataset || mode === 'sql') return;
    const dims = dimensionIds ? dimensionIds.split('|') : [];
    const nums = numericKey ? numericKey.split('|') : [];
    const ms = measureIds ? measureIds.split('|') : [];
    setConfig((c) => {
      const dimOk = !c.dimension || dims.includes(c.dimension);
      const measureOk = c.measure ? ms.includes(c.measure) : c.agg === 'COUNT' || (c.metric !== undefined && nums.includes(c.metric));
      if (dimOk && measureOk) return c;
      return {
        ...c,
        ...(dimOk ? {} : { dimension: dims.find((d) => d !== timeColumn) ?? dims[0], dimension2: undefined, filters: [] }),
        ...(measureOk ? {} : ms.length ? { measure: ms[0] } : nums.length ? { measure: undefined, metric: nums[0] } : { measure: undefined, agg: 'COUNT' as const }),
      };
    });
  }, [dataset, mode, dimensionIds, numericKey, measureIds, timeColumn]);

  // Fill the form from the card — once per version, so a refetch never overwrites edits in progress
  // (a restore or an update from global creates a new version and refills it)
  const seeded = useRef<string>();
  useEffect(() => { if (cardQuery.isError) navigate('/cards'); }, [cardQuery.isError, navigate]);
  useEffect(() => {
    const c = cardQuery.data;
    if (!c || seeded.current === `${c.id}:${c.version_no}`) return;
    seeded.current = `${c.id}:${c.version_no}`;
    {
      // Older builder cards stored SQL; they open in the builder and save back as semantic queries
      setMode(c.query.mode === 'sql' && c.created_via !== 'builder' ? 'sql' : c.created_via === 'sql' ? 'sql' : c.created_via);
      setChartType(c.chart_type);
      const controls = c.config.controls;
      setConfig({
        filters: [], ...c.config,
        // Legacy segment toggle → generic per-dimension controls
        ...(controls?.segment && !controls.filters ? { controls: { ...controls, segment: undefined, filters: ['segment', 'sub_segment'] } } : {}),
      });
      setSqlText(c.sql_text);
      setName(c.name);
      setDescription(c.description);
      setSourceId(c.data_source_id);
    }
  }, [cardQuery.data]);

  const dataSourceId = dataset?.id;
  const runPreview = useCallback(async (sql: string) => {
    if (dataSourceId === undefined) return;
    setRunning(true);
    setQueryError(undefined);
    try {
      const res = await api.query(sql, dataSourceId);
      setRows(res.rows);
      setQueryMs(res.ms);
    } catch (e) {
      setQueryError((e as Error).message);
      setRows([]);
    } finally {
      setRunning(false);
    }
  }, [dataSourceId]);

  // Builder / copilot: compile the semantic query and run it (debounced) whenever it changes
  useEffect(() => {
    if (mode === 'sql' || !semanticKey) return;
    const { source, query } = JSON.parse(semanticKey);
    let alive = true;
    const t = setTimeout(async () => {
      setRunning(true);
      setQueryError(undefined);
      try {
        const [compiled, res] = await Promise.all([api.semanticCompile(source, query), api.semanticQuery(source, query)]);
        if (!alive) return;
        setSqlText(compiled.sql);
        setRows(res.rows);
        setQueryMs(res.ms);
      } catch (e) {
        if (!alive) return;
        setQueryError((e as Error).message);
        setRows([]);
      } finally {
        if (alive) setRunning(false);
      }
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [mode, semanticKey]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, thinking]);

  const updateConfig = (patch: Partial<CardConfig>) => setConfig((c) => ({ ...c, ...patch }));

  const updateFilter = (idx: number, patch: Partial<CardFilter>) => {
    const filters = [...(config.filters ?? [])];
    filters[idx] = { ...filters[idx], ...patch, ...(patch.field ? { value: '' } : {}) };
    updateConfig({ filters });
  };

  const sendChat = () => {
    const prompt = chatInput.trim();
    if (!prompt || thinking) return;
    setChatInput('');
    setMessages((m) => [...m, { role: 'user', text: prompt }]);
    setThinking(true);
    setTimeout(() => {
      const result = copilotRespond(prompt);
      setMessages((m) => [...m, { role: 'copilot', text: result.message }]);
      setThinking(false);
      if (result.config && result.chartType) {
        setChartType(result.chartType);
        // The mock copilot speaks the demo vocabulary; the validity check maps it onto the source's model
        setConfig({ metric: 'amount', agg: 'SUM' as const, filters: [], ...result.config, measure: undefined });
        if (result.suggestedName && !name) setName(result.suggestedName);
      }
    }, 800);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveError(undefined);
    if (!dataset) return;
    const payload = {
      name,
      description,
      chart_type: chartType,
      data_source_id: dataset.id,
      // The editor keeps an empty filter list for convenience; don't store it as a change
      config: config.filters?.length ? config : (({ filters: _unused, ...rest }) => rest)(config),
      ...(mode === 'sql' ? { sql_text: sqlText } : { query: toSemanticQuery(chartType, config, primary?.name ?? dataset.name, timeColumn) }),
      created_via: mode,
      change_note: changeNote,
    };
    try {
      if (editing) await api.updateCard(id!, payload);
      else await api.createCard(payload);
      navigate('/cards');
    } catch (err) {
      setSaveError((err as Error).message);
      setSaving(false);
    }
  };

  const dimValues = (f: CardFilter): string[] => dataset?.dimensionValues[f.field] ?? [];

  const resultColumns = rows.length ? Object.keys(rows[0]) : [];
  const numericColumns = resultColumns.filter((k) => typeof rows[0]?.[k] === 'number');

  const toggleYKey = (k: string) => {
    const current = config.yKeys?.length ? config.yKeys : numericColumns;
    const next = current.includes(k) ? current.filter((y) => y !== k) : [...current, k];
    updateConfig({ yKeys: next });
  };

  // Color scheme picker, available from every creation mode.
  // "Auto" (no stored scheme) follows the app-level theme; explicit schemes pin the card.
  const schemeChip = (active: boolean) =>
    `flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition ${
      active ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-white text-ink-soft hover:border-accent/50'
    }`;
  const schemeBlock = (
    <div>
      <span className={label}>Color scheme</span>
      <div className="flex flex-wrap gap-1.5">
        <button onClick={() => updateConfig({ scheme: undefined })} title="Follow the app-level theme"
          className={schemeChip(!config.scheme)}>
          <span className="flex">
            {['var(--color-accent)', 'var(--color-accent-deep)', 'var(--color-accent-soft)'].map((c) => (
              <span key={c} className="-ml-1 size-3.5 rounded-full border border-white first:ml-0" style={{ background: c }} />
            ))}
          </span>
          Auto (app theme)
        </button>
        {SCHEMES.map((s) => (
          <button key={s.id} onClick={() => updateConfig({ scheme: s.id })} title={`Always ${s.label}, regardless of app theme`}
            className={schemeChip(config.scheme === s.id)}>
            <span className="flex">
              {s.colors.slice(0, 3).map((c) => (
                <span key={c} className="-ml-1 size-3.5 rounded-full border border-white first:ml-0" style={{ background: c }} />
              ))}
            </span>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );

  // On-card filter controls, available from every creation mode
  const PERIOD_CHOICES = [['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Full year'], ['ytd', 'YTD']] as const;

  const filterableDims = (primary?.dimensions ?? []).filter((d) => !(TEMPORAL_TYPES as readonly string[]).includes(d.type));
  const controlFilters = config.controls?.filters ?? [];
  const toggleControlDim = (name: string) => {
    const next = controlFilters.includes(name) ? controlFilters.filter((d) => d !== name) : [...controlFilters, name];
    // Keep the model's order so a parent (e.g. segment) renders before its child (sub-segment)
    const ordered = filterableDims.map((d) => d.name).filter((d) => next.includes(d));
    updateConfig({ controls: { ...config.controls, segment: undefined, filters: ordered.length ? ordered : undefined } });
  };

  type Granularity = NonNullable<NonNullable<CardConfig['controls']>['periodOptions']>[number];
  const toggleOption = (_key: 'periodOptions', all: readonly Granularity[], v: Granularity) => {
    const current = config.controls?.periodOptions?.length ? config.controls.periodOptions : [...all];
    const next = current.includes(v) ? current.filter((x) => x !== v) : [...current, v];
    if (!next.length) return; // keep at least one option
    updateConfig({ controls: { ...config.controls, periodOptions: next.length === all.length ? undefined : next } });
  };

  const optionChip = (active: boolean) =>
    `rounded-md border px-2 py-1 text-[11px] font-semibold transition ${
      active ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-faint hover:border-accent/50'
    }`;

  const controlsBlock = (
    <div>
      <span className={label}>On-card controls</span>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => updateConfig({ controls: { ...config.controls, period: !config.controls?.period } })}
          className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
            config.controls?.period ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-white text-ink-soft hover:border-accent/50'
          }`}>
          {config.controls?.period ? '✓ ' : ''}Period dropdown
        </button>
      </div>

      {filterableDims.length > 0 && (
        <div className="mt-2.5">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Filter dropdowns on the card</p>
          <div className="flex flex-wrap gap-1.5">
            {filterableDims.map((d) => (
              <button key={d.name} onClick={() => toggleControlDim(d.name)} className={optionChip(controlFilters.includes(d.name))}>
                {d.label || d.name}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-ink-faint">Each picks values from this card's source; later ones narrow to earlier selections. Locked dashboard filters can't be overridden.</p>
        </div>
      )}

      {config.controls?.period && (
        <div className="mt-2.5">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Period granularities to offer</p>
          <div className="flex flex-wrap gap-1.5">
            {PERIOD_CHOICES.map(([id, text]) => {
              const opts = config.controls?.periodOptions;
              const active = !opts?.length || opts.includes(id);
              return <button key={id} onClick={() => toggleOption('periodOptions', PERIOD_CHOICES.map(([i]) => i), id)} className={optionChip(active)}>{text}</button>;
            })}
          </div>
        </div>
      )}

      <p className="mt-1.5 text-[11px] text-ink-faint">
        Render interactive toggles on the card itself — viewers can re-filter this widget without touching the rest of the dashboard.
      </p>
    </div>
  );

  return (
    <div className="flex h-screen flex-col">
      {/* Studio header */}
      <div className="flex items-center justify-between border-b border-line bg-white px-8 py-4">
        <div className="flex items-center gap-3">
          <Link to="/cards" className="rounded-lg p-1.5 text-ink-faint transition hover:bg-canvas hover:text-ink" aria-label="Back to cards">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 3L5 8l5 5" /></svg>
          </Link>
          <div>
            <h1 className="font-display text-xl font-extrabold tracking-tight text-ink">
              {editing ? `${canEdit ? 'Edit card' : 'Card'}${name ? ` — ${name}` : ''}` : 'New card'}
              {versionNo !== undefined && <span className="ml-2 align-middle font-mono text-xs font-medium text-ink-faint">v{versionNo}</span>}
            </h1>
            <p className="text-xs text-ink-soft">
              Source:{' '}
              {!editing && datasets.length > 1 ? (
                <select value={sourceId ?? ''} onChange={(e) => chooseSource(Number(e.target.value))} aria-label="Data source"
                  className="rounded-md border border-line bg-white px-1.5 py-0.5 text-xs font-semibold text-ink outline-none focus:border-accent">
                  {datasets.map((d) => <option key={d.id} value={d.id} disabled={Boolean(d.error)}>{d.label}{d.error ? ' (unavailable)' : ''}</option>)}
                </select>
              ) : <span className="font-semibold">{dataset?.label ?? '…'}</span>}
              {' '}· <span className="font-mono">{dataset?.name ?? '…'}</span>
              {dataset ? ` · ${dataset.rowCount.toLocaleString()} rows · ${{ postgres: 'Postgres', bigquery: 'BigQuery', rest: 'REST extract', file: 'File extract' }[dataset.type]}` : ''}
            </p>
            {card && <div className="mt-2"><GovernanceBar kind="cards" asset={card} /></div>}
          </div>
        </div>
        {!canEdit && card?.scope !== 'global' && (
          <span className="mr-3 ml-auto whitespace-nowrap rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">View-only access</span>
        )}
        {editing && (
          <button onClick={() => setHistoryOpen(true)}
            className="mr-2 rounded-xl border border-line px-4 py-2.5 font-display text-sm font-semibold text-ink-soft transition hover:border-accent/50 hover:text-ink">
            History
          </button>
        )}
        <button onClick={() => setSaveOpen(true)} disabled={!canEdit || !dataset || (!rows.length && chartType !== 'kpi')}
          className="rounded-xl bg-accent px-5 py-2.5 font-display text-sm font-semibold text-white shadow-sm transition enabled:hover:bg-accent-deep disabled:opacity-40">
          {editing ? 'Save new version' : 'Save card'}
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Left: creation modes */}
        <div className="flex w-[460px] shrink-0 flex-col border-r border-line bg-white">
          <div className="flex gap-1 border-b border-line px-4 pt-3">
            {([
              ['builder', 'Builder', 'No-code'],
              ['sql', 'SQL', 'Monaco editor'],
              ['copilot', 'Copilot', 'Ask in English'],
            ] as [Mode, string, string][]).map(([m, title, hint]) => (
              <button key={m} onClick={() => setMode(m)}
                className={`relative whitespace-nowrap rounded-t-lg px-3 py-2.5 text-left transition ${mode === m ? 'text-accent' : 'text-ink-soft hover:text-ink'}`}>
                <span className="font-display text-sm font-bold">{title}</span>
                <span className="ml-1.5 text-[10px] uppercase tracking-wide text-ink-faint">{hint}</span>
                {mode === m && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
              </button>
            ))}
          </div>

          {mode === 'builder' && (
            <div className="flex-1 space-y-5 overflow-auto p-5">
              <div>
                <span className={label}>Chart type</span>
                <div className="flex flex-wrap gap-1.5">
                  {CHART_TYPES.map((t) => (
                    <button key={t.id} onClick={() => setChartType(t.id)}
                      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                        chartType === t.id ? 'border-accent bg-accent text-white' : 'border-line bg-white text-ink-soft hover:border-accent/50'
                      }`}>
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {chartType !== 'kpi' && (
                <div>
                  <span className={label}>{chartType === 'bar' ? 'Y-axis — category (horizontal bars)' : chartType === 'barlist' ? 'Category (rows)' : 'X-axis — category'}</span>
                  <select value={config.dimension} onChange={(e) => updateConfig({ dimension: e.target.value })} className={field}>
                    {dimensions.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                  </select>
                  {chartType === 'barlist' && (
                    <div className="mt-2 space-y-2">
                      <select value={config.dimension2 ?? ''} onChange={(e) => updateConfig({ dimension2: e.target.value || undefined })} className={field}>
                        <option value="">No sub-category</option>
                        {dimensions.filter((d) => d.id !== timeColumn && d.id !== config.dimension).map((d) => (
                          <option key={d.id} value={d.id}>Sub-category: {d.label}</option>
                        ))}
                      </select>
                      <button onClick={() => updateConfig({ rank: !config.rank })}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                          config.rank ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-white text-ink-soft hover:border-accent/50'
                        }`}>
                        {config.rank ? '✓ ' : ''}Show rank numbers
                      </button>
                    </div>
                  )}
                  {config.dimension === timeColumn && (
                    <div className="mt-2 flex gap-1.5">
                      {(['day', 'month'] as const).map((g) => (
                        <button key={g} onClick={() => updateConfig({ timeGrain: g })}
                          className={`rounded-lg border px-3 py-1 text-xs font-semibold capitalize transition ${
                            (config.timeGrain ?? 'day') === g ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-soft'
                          }`}>
                          {g}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div>
                <span className={label}>{chartType === 'kpi' ? 'Value' : chartType === 'bar' ? 'X-axis — value' : 'Y-axis — value'}</span>
                <select value={config.measure ?? '__custom'} aria-label="Measure" className={field}
                  onChange={(e) => updateConfig(e.target.value === '__custom'
                    ? { measure: undefined, agg: config.agg ?? 'SUM', metric: config.metric && numericColumns_.includes(config.metric) ? config.metric : numericColumns_[0] }
                    : { measure: e.target.value })}>
                  {measures.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  <option value="__custom">Custom aggregate…</option>
                </select>
                {!config.measure && (
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    <select value={config.agg} onChange={(e) => updateConfig({ agg: e.target.value as CardConfig['agg'] })} className={field} aria-label="Aggregation">
                      <option value="SUM">SUM</option>
                      <option value="AVG">AVG</option>
                      <option value="COUNT">COUNT</option>
                    </select>
                    <select value={config.metric} onChange={(e) => updateConfig({ metric: e.target.value })} className={field} disabled={config.agg === 'COUNT'} aria-label="Column">
                      {numericColumns_.map((c) => <option key={c} value={c}>{c}</option>)}
                      {!numericColumns_.length && <option value="">(no numeric columns)</option>}
                    </select>
                  </div>
                )}
              </div>

              {chartType !== 'kpi' && (
                <div>
                  <span className={label}>Limit (top N)</span>
                  <input type="number" min={1} max={100} value={config.limit ?? ''} placeholder="No limit"
                    onChange={(e) => updateConfig({ limit: e.target.value ? Number(e.target.value) : undefined })} className={field} />
                </div>
              )}

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className={label.replace('mb-1 ', '')}>Filters</span>
                  <button onClick={() => updateConfig({ filters: [...(config.filters ?? []), { field: 'segment', value: '' }] })}
                    className="text-xs font-semibold text-accent hover:underline">+ Add filter</button>
                </div>
                <div className="space-y-2">
                  {(config.filters ?? []).map((f, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <select value={f.field} onChange={(e) => updateFilter(i, { field: e.target.value })} className={`${field} !w-36`}>
                        {dimensions.filter((d) => d.id !== timeColumn).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                      </select>
                      <select value={f.value} onChange={(e) => updateFilter(i, { value: e.target.value })} className={field}>
                        <option value="">Choose…</option>
                        {dimValues(f).map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                      <button onClick={() => updateConfig({ filters: (config.filters ?? []).filter((_, j) => j !== i) })}
                        className="rounded-lg p-1.5 text-ink-faint transition hover:bg-negative/10 hover:text-negative" aria-label="Remove filter">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 3l10 10M13 3L3 13" /></svg>
                      </button>
                    </div>
                  ))}
                  {!(config.filters ?? []).length && <p className="text-xs text-ink-faint">No card-level filters — dashboard filters still apply.</p>}
                </div>
              </div>

              {schemeBlock}

              {controlsBlock}

              <div>
                <span className={label}>Generated SQL</span>
                <pre className="overflow-auto rounded-xl bg-accent-deep p-3.5 font-mono text-[11px] leading-relaxed text-sky-100">{sqlText}</pre>
                <button onClick={() => setMode('sql')} className="mt-1.5 text-xs font-semibold text-accent hover:underline">
                  Open in SQL editor →
                </button>
              </div>
            </div>
          )}

          {mode === 'sql' && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between px-5 py-3">
                <p className="text-xs text-ink-soft">
                  One <span className="font-mono">SELECT</span> against <span className="font-mono">transactions</span>. Keep
                  <span className="font-mono"> {'{{filters}}'}</span> to honor dashboard segment/period.
                </p>
                <button onClick={() => runPreview(sqlText)} disabled={running}
                  className="rounded-lg bg-accent px-4 py-1.5 text-xs font-bold text-white transition enabled:hover:bg-accent-deep disabled:opacity-50">
                  {running ? 'Running…' : '▶ Run'}
                </button>
              </div>
              <div className="min-h-0 flex-1 border-t border-line">
                <Editor
                  language="sql"
                  value={sqlText}
                  onChange={(v) => setSqlText(v ?? '')}
                  options={{ minimap: { enabled: false }, fontSize: 13, fontFamily: 'IBM Plex Mono', lineNumbers: 'on', scrollBeyondLastLine: false, padding: { top: 12 } }}
                />
              </div>
              <div className="max-h-72 space-y-4 overflow-auto border-t border-line px-5 py-3">
                <div>
                  <span className={label}>Render result as</span>
                  <div className="flex flex-wrap gap-1.5">
                    {CHART_TYPES.map((t) => (
                      <button key={t.id} onClick={() => setChartType(t.id)}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                          chartType === t.id ? 'border-accent bg-accent text-white' : 'border-line bg-white text-ink-soft hover:border-accent/50'
                        }`}>
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                {rows.length > 0 && !['kpi', 'table'].includes(chartType) && (
                  <div>
                    <span className={label}>Axis mapping</span>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <label className="flex items-center gap-2 text-xs font-semibold text-ink-soft">
                        X axis
                        <select value={config.xKey ?? ''} onChange={(e) => updateConfig({ xKey: e.target.value || undefined })}
                          className={`${field} !w-36 !py-1.5`}>
                          <option value="">Auto</option>
                          {resultColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </label>
                      <div className="flex items-center gap-2 text-xs font-semibold text-ink-soft">
                        Y axis
                        <div className="flex flex-wrap gap-1.5">
                          {numericColumns.map((c) => {
                            const active = (config.yKeys?.length ? config.yKeys : numericColumns).includes(c);
                            return (
                              <button key={c} onClick={() => toggleYKey(c)}
                                className={`rounded-md border px-2 py-1 font-mono text-[11px] transition ${
                                  active ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-faint hover:border-accent/50'
                                }`}>
                                {c}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {schemeBlock}

                {controlsBlock}
              </div>
            </div>
          )}

          {mode === 'copilot' && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex-1 space-y-3 overflow-auto p-5">
                {messages.map((m, i) => (
                  <div key={i} className={`rise-in max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    m.role === 'user' ? 'ml-auto rounded-br-md bg-accent text-white' : 'rounded-bl-md bg-canvas text-ink'
                  }`}>
                    {m.text}
                  </div>
                ))}
                {thinking && (
                  <div className="flex w-16 items-center justify-center gap-1 rounded-2xl rounded-bl-md bg-canvas px-4 py-3">
                    {[0, 1, 2].map((d) => <span key={d} className="copilot-dot size-1.5 rounded-full bg-ink-soft" />)}
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>
              <div className="border-t border-line p-4">
                <div className="flex gap-2">
                  <input value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendChat()}
                    placeholder="e.g. Top 5 merchants as a bar chart" className={field} />
                  <button onClick={sendChat} disabled={thinking || !chatInput.trim()}
                    className="shrink-0 rounded-lg bg-accent px-4 text-sm font-bold text-white transition enabled:hover:bg-accent-deep disabled:opacity-40">
                    Send
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-ink-faint">Mock copilot — pattern-matches your prompt to a builder config, no LLM calls.</p>
              </div>
            </div>
          )}
        </div>

        {/* Right: live preview */}
        <div className="flex min-w-0 flex-1 flex-col p-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-sm font-bold uppercase tracking-wide text-ink-soft">Live preview</h2>
            {queryMs !== null && !queryError && (
              <span className="font-mono text-[11px] text-ink-faint">{rows.length} row{rows.length === 1 ? '' : 's'} · {queryMs}ms</span>
            )}
          </div>
          <div className="relative min-h-0 flex-1 rounded-2xl border border-line bg-white p-5 shadow-sm">
            {queryError ? (
              <div className="flex h-full items-center justify-center px-8 text-center">
                <div>
                  <p className="font-display font-bold text-negative">Query failed</p>
                  <p className="mt-1 font-mono text-xs text-ink-soft">{queryError}</p>
                </div>
              </div>
            ) : running ? (
              <div className="flex h-full items-center justify-center">
                <div className="size-6 animate-spin rounded-full border-2 border-line border-t-accent" />
              </div>
            ) : (
              <ChartRenderer chartType={chartType} data={{ rows, meta: {} }} xKey={config.xKey} yKeys={config.yKeys} rank={config.rank} scheme={config.scheme} />
            )}
          </div>
          {rows.length > 0 && chartType !== 'table' && (
            <div className="mt-4 max-h-48 overflow-auto rounded-2xl border border-line bg-white shadow-sm">
              <ChartRenderer chartType="table" data={{ rows, meta: {} }} />
            </div>
          )}
        </div>
      </div>

      {historyOpen && id && (
        <VersionHistory kind="cards" assetId={Number(id)} assetName={name} canEdit={canEdit}
          onClose={() => setHistoryOpen(false)} />
      )}

      {saveOpen && (
        <Modal title={editing ? `Save as v${(versionNo ?? 0) + 1}` : 'Save card to your library'}
          subtitle={editing ? 'Earlier versions are kept — dashboards stay on the version they pinned.' : 'New cards are private to you. The card stores its SQL + data-source mapping, so any dashboard can reuse it.'}
          onClose={() => setSaveOpen(false)}>
          <form onSubmit={save} className="space-y-4">
            <div>
              <span className={label}>Card name</span>
              <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Industry Spend" className={field} />
            </div>
            <div>
              <span className={label}>Description</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this card show?" className={field} />
            </div>
            {editing && (
              <div>
                <span className={label}>What changed?</span>
                <input value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="e.g. Limit to top 10" className={field} />
              </div>
            )}
            <div className="rounded-xl bg-canvas px-4 py-3 text-xs text-ink-soft">
              <span className="font-semibold text-ink">Mapping:</span> source <span className="font-mono">{dataset?.label}</span> · chart <span className="font-mono">{chartType}</span> · created via <span className="font-mono">{mode}</span>
            </div>
            {saveError && <p className="text-sm text-negative">{saveError}</p>}
            <button type="submit" disabled={saving} className="w-full rounded-lg bg-accent py-2.5 font-display text-sm font-semibold text-white transition enabled:hover:bg-accent-deep disabled:opacity-50">
              {saving ? 'Saving…' : editing ? 'Save new version' : 'Save card'}
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
