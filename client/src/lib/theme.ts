import { SCHEMES } from './format';

/**
 * App-level themes reuse the card color schemes: accent = primary, deep shade
 * for the sidebar/active chrome, and a soft tint for highlighted backgrounds.
 * Tailwind v4 utilities resolve to var(--color-*), so overriding the variables
 * on <html> re-themes the whole app live.
 */
export interface AppTheme {
  id: string;
  label: string;
  accent: string;
  deep: string;
  soft: string;
}

export const APP_THEMES: AppTheme[] = SCHEMES.map((s) => ({
  id: s.id,
  label: s.label,
  accent: s.colors[0],
  deep: s.colors[1],
  soft: s.colors[0] + '1a',
}));

const STORAGE_KEY = 'sb-app-theme';

export function loadAppTheme(): string {
  return localStorage.getItem(STORAGE_KEY) ?? 'classic';
}

export function applyAppTheme(id: string) {
  localStorage.setItem(STORAGE_KEY, id);
  const root = document.documentElement;
  if (id === 'classic') {
    // Fall back to the values defined in @theme (index.css)
    root.style.removeProperty('--color-accent');
    root.style.removeProperty('--color-accent-deep');
    root.style.removeProperty('--color-accent-soft');
    return;
  }
  const theme = APP_THEMES.find((t) => t.id === id);
  if (!theme) return;
  root.style.setProperty('--color-accent', theme.accent);
  root.style.setProperty('--color-accent-deep', theme.deep);
  root.style.setProperty('--color-accent-soft', theme.soft);
}
