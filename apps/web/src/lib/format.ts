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

/**
 * Selectable card color schemes. colors[0] = primary, colors[1] = deep shade,
 * the rest are series accents. 'classic' is the default.
 */
export interface ColorScheme {
  id: string;
  label: string;
  colors: string[];
}

export const SCHEMES: ColorScheme[] = [
  { id: 'classic', label: 'Classic Blue', colors: PALETTE },
  { id: 'emerald', label: 'Emerald', colors: ['#0e9f6e', '#064e3b', '#6ee7b7', '#f5a623', '#016fd0', '#8c5bd8', '#c93a3a'] },
  { id: 'sunset', label: 'Sunset', colors: ['#ea580c', '#7c2d12', '#fdba74', '#016fd0', '#1e8e5a', '#8c5bd8', '#0e7490'] },
  { id: 'violet', label: 'Violet', colors: ['#7c3aed', '#312e81', '#c4b5fd', '#f5a623', '#1e8e5a', '#016fd0', '#c93a3a'] },
  { id: 'ocean', label: 'Ocean Teal', colors: ['#0e7490', '#164e63', '#67e8f9', '#f5a623', '#7c3aed', '#1e8e5a', '#c93a3a'] },
  { id: 'slate', label: 'Slate Mono', colors: ['#475569', '#0f172a', '#94a3b8', '#016fd0', '#f5a623', '#1e8e5a', '#c93a3a'] },
];

export function schemeColors(id?: string): string[] {
  return SCHEMES.find((s) => s.id === id)?.colors ?? PALETTE;
}

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

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
