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

/** Text placed into the Excel/PDF export page: card names and values come from users and data, never markup. */
export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Text a spreadsheet would run as a formula (=, +, -, @, tab, CR) is kept as text with a leading '.
 *  Numbers — negatives included — are written as they are. */
function asSpreadsheetText(v: unknown): string {
  return typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v ?? '');
}

export function escapeCsv(v: unknown): string {
  const s = asSpreadsheetText(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
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
        columns.map(escapeCsv).join(','),
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
          ${meta.length ? `<tr><td colspan="${columns.length}">${meta.map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`).join(' · ')}</td></tr>` : ''}
          <tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>
          ${selectedRows.map((r) => `<tr>${columns.map((c) => `<td>${escapeHtml(asSpreadsheetText(r[c]))}</td>`).join('')}</tr>`).join('')}
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
        w.opener = null;  // the print page needs nothing from the app window
        w.document.write(`<html><head><title>${escapeHtml(card.name)}</title>
          <style>body{font-family:sans-serif;padding:24px}h1{font-size:18px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 10px;font-size:12px;text-align:left}</style>
          </head><body><h1>${escapeHtml(card.name)}</h1>${table}<script>print()</script></body></html>`);
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
/** A real link to this card where it is shown (its dashboard, scrolled to it). Nothing is sent anywhere:
 *  the link opens only for people who can already see the dashboard. */
export function ShareModal({ card, context, onClose }: { card: Card & { item_id?: string }; context: CardContext; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}${window.location.pathname}${card.item_id ? `#card-${card.item_id}` : ''}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Modal title="Copy link" subtitle={`A link to “${card.name}” on this page.`} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2">
          <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Link to this card"
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink outline-none" />
          <button type="button" onClick={copy}
            className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-deep">
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <ul className="space-y-1.5 text-xs text-ink-soft">
          <li>Only people who can already open this page can open the link — share the dashboard first if needed.</li>
          <li>It opens with the page's own filters, not your current ones ({context.segmentLabel} · {context.periodLabel}).</li>
          <li>To send the numbers themselves, use <span className="font-semibold">Export data</span> and attach the file.</li>
        </ul>
      </div>
    </Modal>
  );
}
