import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { api } from '../lib/api';
import type { CardConfig, CardFilter, ChartType, Dataset, Row } from '../lib/types';
import { buildSql, copilotRespond } from '../lib/builder';
import ChartRenderer from '../components/ChartRenderer';
import Modal from '../components/Modal';

type Mode = 'builder' | 'sql' | 'copilot';

const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: 'kpi', label: 'KPI' },
  { id: 'bar', label: 'Bar' },
  { id: 'column', label: 'Column' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
  { id: 'donut', label: 'Donut' },
  { id: 'table', label: 'Table' },
];

const DIMENSIONS = [
  { id: 'industry', label: 'Industry' },
  { id: 'sub_industry', label: 'Sub-industry' },
  { id: 'product', label: 'Product' },
  { id: 'merchant', label: 'Merchant' },
  { id: 'country', label: 'Country' },
  { id: 'segment', label: 'Segment' },
  { id: 'sub_segment', label: 'Sub-segment' },
  { id: 'vintage', label: 'Vintage' },
  { id: 'txn_date', label: 'Date (time series)' },
];

interface ChatMsg {
  role: 'user' | 'copilot';
  text: string;
}

const field = 'w-full rounded-lg border border-line bg-white px-3 py-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20';
const label = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-soft';

export default function CardStudio() {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = Boolean(id);

  const [mode, setMode] = useState<Mode>('builder');
  const [chartType, setChartType] = useState<ChartType>('bar');
  const [config, setConfig] = useState<CardConfig>({ dimension: 'industry', metric: 'amount', agg: 'SUM', filters: [] });
  const [sqlText, setSqlText] = useState(() => buildSql('bar', { dimension: 'industry', metric: 'amount', agg: 'SUM' }));
  const [dataset, setDataset] = useState<Dataset | null>(null);

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

  useEffect(() => { api.datasets().then((d) => setDataset(d[0])).catch(console.error); }, []);

  // Load existing card when editing
  useEffect(() => {
    if (!id) return;
    api.card(id).then((c) => {
      setMode(c.created_via);
      setChartType(c.chart_type);
      setConfig({ filters: [], ...c.config });
      setSqlText(c.sql_text);
      setName(c.name);
      setDescription(c.description);
    }).catch(() => navigate('/cards'));
  }, [id, navigate]);

  const runPreview = useCallback(async (sql: string) => {
    setRunning(true);
    setQueryError(undefined);
    try {
      const res = await api.query(sql);
      setRows(res.rows);
      setQueryMs(res.ms);
    } catch (e) {
      setQueryError((e as Error).message);
      setRows([]);
    } finally {
      setRunning(false);
    }
  }, []);

  // Builder mode: regenerate SQL + auto-run (debounced) when config changes
  useEffect(() => {
    if (mode !== 'builder') return;
    const sql = buildSql(chartType, config);
    setSqlText(sql);
    const t = setTimeout(() => runPreview(sql), 350);
    return () => clearTimeout(t);
  }, [mode, chartType, config, runPreview]);

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
        const merged = { metric: 'amount', agg: 'SUM' as const, filters: [], ...result.config };
        setConfig(merged);
        const sql = buildSql(result.chartType, merged);
        setSqlText(sql);
        runPreview(sql);
        if (result.suggestedName && !name) setName(result.suggestedName);
      }
    }, 800);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveError(undefined);
    const payload = {
      name,
      description,
      chart_type: chartType,
      dataset: 'transactions',
      config,
      sql_text: sqlText,
      created_via: mode,
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

  // On-card filter controls, available from every creation mode
  const controlsBlock = (
    <div>
      <span className={label}>On-card controls</span>
      <div className="flex flex-wrap gap-2">
        {([['segment', 'Segment toggle'], ['period', 'Period dropdown']] as const).map(([key, text]) => {
          const on = Boolean(config.controls?.[key]);
          return (
            <button key={key} onClick={() => updateConfig({ controls: { ...config.controls, [key]: !on } })}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                on ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-white text-ink-soft hover:border-accent/50'
              }`}>
              {on ? '✓ ' : ''}{text}
            </button>
          );
        })}
      </div>
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
            <h1 className="font-display text-xl font-extrabold tracking-tight text-ink">{editing ? `Edit card${name ? ` — ${name}` : ''}` : 'New card'}</h1>
            <p className="text-xs text-ink-soft">Source: <span className="font-mono">transactions</span> · {dataset ? `${dataset.rowCount.toLocaleString()} rows · SQLite via API` : 'loading…'}</p>
          </div>
        </div>
        <button onClick={() => setSaveOpen(true)} disabled={!rows.length && chartType !== 'kpi'}
          className="rounded-xl bg-accent px-5 py-2.5 font-display text-sm font-semibold text-white shadow-sm transition enabled:hover:bg-accent-deep disabled:opacity-40">
          {editing ? 'Save changes' : 'Save card'}
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
                  <span className={label}>{chartType === 'bar' ? 'Y-axis — category (horizontal bars)' : 'X-axis — category'}</span>
                  <select value={config.dimension} onChange={(e) => updateConfig({ dimension: e.target.value })} className={field}>
                    {DIMENSIONS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                  </select>
                  {config.dimension === 'txn_date' && (
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
                <div className="grid grid-cols-2 gap-3">
                  <select value={config.agg} onChange={(e) => updateConfig({ agg: e.target.value as CardConfig['agg'] })} className={field} aria-label="Aggregation">
                    <option value="SUM">SUM</option>
                    <option value="AVG">AVG</option>
                    <option value="COUNT">COUNT</option>
                  </select>
                  <select value={config.metric} onChange={(e) => updateConfig({ metric: e.target.value })} className={field} disabled={config.agg === 'COUNT'} aria-label="Metric">
                    <option value="amount">amount</option>
                  </select>
                </div>
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
                        {DIMENSIONS.filter((d) => d.id !== 'txn_date').map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
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
              <ChartRenderer chartType={chartType} data={{ rows, meta: {} }} xKey={config.xKey} yKeys={config.yKeys} />
            )}
          </div>
          {rows.length > 0 && chartType !== 'table' && (
            <div className="mt-4 max-h-48 overflow-auto rounded-2xl border border-line bg-white shadow-sm">
              <ChartRenderer chartType="table" data={{ rows, meta: {} }} />
            </div>
          )}
        </div>
      </div>

      {saveOpen && (
        <Modal title={editing ? 'Save changes' : 'Save card to library'} subtitle="The card stores its SQL + data-source mapping, so any dashboard can reuse it." onClose={() => setSaveOpen(false)}>
          <form onSubmit={save} className="space-y-4">
            <div>
              <span className={label}>Card name</span>
              <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Industry Spend" className={field} />
            </div>
            <div>
              <span className={label}>Description</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this card show?" className={field} />
            </div>
            <div className="rounded-xl bg-canvas px-4 py-3 text-xs text-ink-soft">
              <span className="font-semibold text-ink">Mapping:</span> dataset <span className="font-mono">transactions</span> · chart <span className="font-mono">{chartType}</span> · created via <span className="font-mono">{mode}</span>
            </div>
            {saveError && <p className="text-sm text-negative">{saveError}</p>}
            <button type="submit" disabled={saving} className="w-full rounded-lg bg-accent py-2.5 font-display text-sm font-semibold text-white transition enabled:hover:bg-accent-deep disabled:opacity-50">
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Save card'}
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
