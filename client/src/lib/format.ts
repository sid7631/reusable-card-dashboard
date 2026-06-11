export function formatMoney(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value * 100) / 100);
}

export function formatCell(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) < 1e4 ? String(value) : formatNumber(value);
  return String(value ?? '');
}

/** Chart palette — deep enterprise blues with sharp accents. */
export const PALETTE = ['#016fd0', '#00175a', '#6bb8f0', '#f5a623', '#1e8e5a', '#8c5bd8', '#c93a3a'];

export function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const csv = [keys.join(','), ...rows.map((r) => keys.map((k) => escape(r[k])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
