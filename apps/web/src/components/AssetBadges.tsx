import type { AssetMeta } from '../lib/types';

/** Scope + version chips shown on every versioned asset (card, dashboard). */
export default function AssetBadges({ asset, className = '' }: { asset: Pick<AssetMeta, 'scope' | 'access' | 'owner_name' | 'version_no'>; className?: string }) {
  const shared = asset.scope === 'private' && (asset.access === 'view' || asset.access === 'edit');
  const [label, tone, title] = asset.scope === 'global'
    ? ['Global', 'bg-accent text-white', 'Published to the global library']
    : shared
      ? [`Shared · ${asset.access}`, 'bg-amber-100 text-amber-800', `Shared with you by ${asset.owner_name ?? 'another user'}`]
      : ['Private', 'bg-canvas text-ink-soft', 'Only you (and people you share with) can see this'];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 ${className}`}>
      <span title={title} className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}>{label}</span>
      <span title="Current version" className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[10px] font-medium text-ink-faint">v{asset.version_no}</span>
    </span>
  );
}
