import { useMemo, useState } from 'react';
import type { Card, Row } from '../lib/types';
import { previewSql } from '../lib/builder';
import { useCompiledSql } from '../lib/queries';
import Modal from './Modal';

/** Widget context auto-passed into every action panel (segment, period, filters). */
export interface CardContext {
  segmentLabel: string;
  periodLabel: string;
  filters: string[];
}

export const DEFAULT_CONTEXT: CardContext = { segmentLabel: 'Total AXP', periodLabel: '2026 YTD', filters: [] };

const chip = (active: boolean) =>
  `rounded-lg border px-4 py-1.5 text-xs font-semibold transition ${
    active ? 'border-accent bg-accent text-white' : 'border-line bg-white text-ink-soft hover:border-accent/50'
  }`;
const label = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-soft';

function escapeCsv(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function contextLines(context: CardContext): string[][] {
  return [
    ['filters', context.segmentLabel],
    ['period', context.periodLabel],
    ['card filters', context.filters.length ? context.filters.join('; ') : 'none'],
  ];
}

// ---------------------------------------------------------------- Export Data
export function ExportModal({ card, rows, context, onClose }: { card: Card; rows: Row[]; context: CardContext; onClose: () => void }) {
  const allColumns = useMemo(() => (rows.length ? Object.keys(rows[0]) : []), [rows]);
  const [format, setFormat] = useState<'csv' | 'excel' | 'pdf'>('csv');
  const [columns, setColumns] = useState<string[]>(allColumns);
  const [includeFilters, setIncludeFilters] = useState(true);

  const toggleColumn = (c: string) =>
    setColumns((cols) => (cols.includes(c) ? cols.filter((x) => x !== c) : [...allColumns.filter((a) => cols.includes(a) || a === c)]));

  const selectedRows = rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c]])));

  const download = () => {
    const meta = includeFilters ? contextLines(context) : [];
    if (format === 'csv') {
      const lines = [
        ...meta.map(([k, v]) => `# ${k}: ${v}`),
        columns.join(','),
        ...selectedRows.map((r) => columns.map((c) => escapeCsv(r[c])).join(',')),
      ];
      const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${card.name}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } else {
      const table = `
        <table border="1">
          ${meta.length ? `<tr><td colspan="${columns.length}">${meta.map(([k, v]) => `${k}: ${v}`).join(' · ')}</td></tr>` : ''}
          <tr>${columns.map((c) => `<th>${c}</th>`).join('')}</tr>
          ${selectedRows.map((r) => `<tr>${columns.map((c) => `<td>${r[c] ?? ''}</td>`).join('')}</tr>`).join('')}
        </table>`;
      if (format === 'excel') {
        const blob = new Blob([`<html><head><meta charset="utf-8"></head><body>${table}</body></html>`], { type: 'application/vnd.ms-excel' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${card.name}.xls`;
        a.click();
        URL.revokeObjectURL(a.href);
      } else {
        // PDF: open a print-ready snapshot — save as PDF from the print dialog
        const w = window.open('', '_blank');
        if (!w) return;
        w.document.write(`<html><head><title>${card.name}</title>
          <style>body{font-family:sans-serif;padding:24px}h1{font-size:18px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 10px;font-size:12px;text-align:left}</style>
          </head><body><h1>${card.name}</h1>${table}<script>print()</script></body></html>`);
        w.document.close();
      }
    }
  };

  return (
    <Modal title="Export Data" subtitle="Triggered from widget card — current filters are auto-passed in." onClose={onClose}>
      <div className="space-y-5">
        <div>
          <span className={label}>File format</span>
          <div className="flex gap-2">
            {(['csv', 'excel', 'pdf'] as const).map((f) => (
              <button key={f} onClick={() => setFormat(f)} className={chip(format === f)}>{f.toUpperCase()}</button>
            ))}
          </div>
        </div>

        <div>
          <span className={label}>Columns to include</span>
          <div className="space-y-1">
            {allColumns.map((c) => (
              <label key={c} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-1 py-1 text-sm text-ink transition hover:bg-canvas">
                <input type="checkbox" checked={columns.includes(c)} onChange={() => toggleColumn(c)} className="size-3.5 accent-[#016fd0]" />
                <span className="font-mono text-xs">{c}</span>
              </label>
            ))}
            {!allColumns.length && <p className="text-xs text-ink-faint">No rows to export for the current filters.</p>}
          </div>
        </div>

        <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line px-3 py-2.5 text-sm text-ink">
          <input type="checkbox" checked={includeFilters} onChange={() => setIncludeFilters((v) => !v)} className="size-3.5 accent-[#016fd0]" />
          <span>
            Filters applied
            <span className="ml-2 text-xs text-ink-faint">{context.segmentLabel} · {context.periodLabel}</span>
          </span>
        </label>

        <button onClick={download} disabled={!columns.length || !rows.length}
          className="w-full rounded-lg bg-accent py-2.5 font-display text-sm font-semibold text-white transition enabled:hover:bg-accent-deep disabled:opacity-40">
          ↓ Download {format.toUpperCase()}
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------- View SQL Script
export function SqlModal({ card, context, onClose }: { card: Card; context: CardContext; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  // Semantic cards have no stored SQL — compile the editable form for display
  const semantic = card.query?.mode === 'semantic' ? card.query : undefined;
  const compiled = useCompiledSql(card.data_source_id, semantic, Boolean(semantic));
  const sql = !semantic ? card.sql_text : compiled.error ? `-- ${compiled.error.message}` : compiled.data?.sql ?? 'Compiling…';
  return (
    <Modal title="View SQL Script" subtitle="Triggered from widget card — {{filters}} resolves to the parameters below." onClose={onClose} wide>
      <div className="space-y-4">
        <div>
          <span className={label}>Generated query</span>
          <pre className="max-h-72 overflow-auto rounded-xl bg-accent-deep p-4 font-mono text-xs leading-relaxed text-sky-100">{sql}</pre>
        </div>
        <div>
          <span className={label}>Parameters applied</span>
          <ul className="space-y-1 rounded-xl bg-canvas px-4 py-3">
            {contextLines(context).map(([k, v]) => (
              <li key={k} className="text-sm text-ink-soft">
                <span className="mr-1.5 text-accent">•</span>
                <span className="font-mono text-xs">{k} = {v}</span>
              </li>
            ))}
          </ul>
        </div>
        <button
          onClick={() => { navigator.clipboard.writeText(previewSql(sql)); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="w-full rounded-lg border border-accent py-2.5 font-display text-sm font-semibold text-accent transition hover:bg-accent-soft"
        >
          {copied ? '✓ Copied' : '⧉ Copy SQL'}
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------ Share
export function ShareModal({ card, context, onClose }: { card: Card; context: CardContext; onClose: () => void }) {
  const [recipients, setRecipients] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [permission, setPermission] = useState<'View only' | 'Can edit'>('View only');
  const [format, setFormat] = useState<'pdf' | 'csv'>('pdf');
  const [message, setMessage] = useState('');
  const [linkOn, setLinkOn] = useState(false);
  const [sent, setSent] = useState(false);
  const link = useMemo(() => `https://spendboard.local/share/${card.id}-${Math.random().toString(36).slice(2, 8)}`, [card.id]);

  const addRecipient = () => {
    const email = input.trim().replace(/,$/, '');
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !recipients.includes(email)) {
      setRecipients((r) => [...r, email]);
      setInput('');
    }
  };

  if (sent) {
    return (
      <Modal title="Share" subtitle={`“${card.name}” — snapshot sent (mock).`} onClose={onClose}>
        <div className="flex flex-col items-center py-6 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-positive/10 text-positive">
            <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 8.5l3.5 3.5L13 4.5" /></svg>
          </div>
          <p className="mt-3 font-display font-semibold text-ink">Sent to {recipients.length || 'no'} recipient{recipients.length === 1 ? '' : 's'}</p>
          <p className="mt-1 text-sm text-ink-soft">{permission} · {format.toUpperCase()} · {context.segmentLabel} · {context.periodLabel}</p>
          {linkOn && <p className="mt-3 rounded-lg bg-canvas px-3 py-1.5 font-mono text-xs text-ink-soft">{link}</p>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Share" subtitle="Triggered from widget card — the current segment, period and filters are preserved." onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); addRecipient(); setSent(true); }} className="space-y-4">
        <div>
          <span className={label}>Recipients</span>
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line px-2 py-1.5 transition focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
            {recipients.map((r) => (
              <span key={r} className="flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent">
                {r}
                <button type="button" onClick={() => setRecipients((rs) => rs.filter((x) => x !== r))} className="text-accent/60 hover:text-accent" aria-label={`Remove ${r}`}>×</button>
              </span>
            ))}
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addRecipient(); } }}
              onBlur={addRecipient}
              placeholder={recipients.length ? '' : 'Add colleague…'}
              className="min-w-28 flex-1 border-0 px-1 py-1 text-sm outline-none"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className={label}>Permission</span>
            <div className="flex gap-2">
              {(['View only', 'Can edit'] as const).map((p) => (
                <button type="button" key={p} onClick={() => setPermission(p)} className={chip(permission === p)}>{p}</button>
              ))}
            </div>
          </div>
          <div>
            <span className={label}>File format</span>
            <div className="flex gap-2">
              {(['pdf', 'csv'] as const).map((f) => (
                <button type="button" key={f} onClick={() => setFormat(f)} className={chip(format === f)}>{f.toUpperCase()}</button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <span className={label}>Optional message</span>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            placeholder={`Sharing the ${context.periodLabel} ${card.name} snapshot — filters preserved.`}
            className="w-full resize-none rounded-lg border border-line px-3 py-2 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </div>

        <button type="button" onClick={() => setLinkOn((v) => !v)}
          className="flex w-full items-center justify-between rounded-lg border border-line px-3 py-2.5 text-sm text-ink transition hover:border-accent/40">
          <span className="font-medium">Generate read-only link</span>
          <span className={`relative h-5 w-9 rounded-full transition ${linkOn ? 'bg-positive' : 'bg-line'}`}>
            <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${linkOn ? 'left-[18px]' : 'left-0.5'}`} />
          </span>
        </button>
        {linkOn && (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-canvas px-3 py-2">
            <span className="truncate font-mono text-xs text-ink-soft">{link}</span>
            <button type="button" onClick={() => navigator.clipboard.writeText(link)} className="shrink-0 text-xs font-semibold text-accent hover:underline">Copy</button>
          </div>
        )}

        <button type="submit" disabled={!recipients.length && !input.trim() && !linkOn}
          className="w-full rounded-lg bg-accent py-2.5 font-display text-sm font-semibold text-white transition enabled:hover:bg-accent-deep disabled:opacity-40">
          ✉ Send
        </button>
      </form>
    </Modal>
  );
}
