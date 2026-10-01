import type { SpecChange, VersionDiff } from '../lib/types';

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  'spec.query.sql': 'SQL',
  'spec.chart_type': 'Chart type',
  'spec.created_via': 'Created via',
  'spec.data_source.version_id': 'Data source version',
  'spec.data_source.asset_id': 'Data source',
};

const ITEM_PATH = /^spec\.items\[([^\]]+)\](?:\.(.+))?$/;

function describe(change: SpecChange, labels: Record<string, string>): string {
  const item = change.path.match(ITEM_PATH);
  if (item) {
    const card = `“${labels[item[1]] ?? 'card'}”`;
    if (!item[2]) return change.op === 'added' ? `Added ${card}` : change.op === 'removed' ? `Removed ${card}` : `Changed ${card}`;
    if (item[2] === 'card.version_id') return `${card} moved to a newer card version`;
    if (['x', 'y'].includes(item[2])) return `${card} position (${item[2]})`;
    if (['w', 'h'].includes(item[2])) return `${card} size (${item[2] === 'w' ? 'width' : 'height'})`;
    return `${card} › ${item[2].replaceAll('.', ' › ')}`;
  }
  return FIELD_LABELS[change.path]
    ?? change.path.replace(/^spec\./, '').replace(/^config\./, 'Config › ').replaceAll('.', ' › ').replaceAll('_', ' ');
}

/** Leaf fields of an added/removed object, e.g. a newly published card's spec. */
function flatten(value: unknown, prefix = ''): [string, unknown][] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
  }
  return [[prefix, value]];
}

function show(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'string') return value;
  const text = JSON.stringify(value);
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

const OP_TONE: Record<SpecChange['op'], string> = {
  added: 'bg-positive/10 text-positive',
  removed: 'bg-negative/10 text-negative',
  changed: 'bg-accent-soft text-accent',
};

export default function DiffList({ diff }: { diff: VersionDiff }) {
  if (!diff.changes.length) {
    return <p className="rounded-xl bg-canvas px-4 py-6 text-center text-sm text-ink-faint">No differences.</p>;
  }
  return (
    <ul className="space-y-2.5">
      {diff.changes.map((c) => {
        const isItem = ITEM_PATH.test(c.path);
        const hideValues = isItem && (c.op !== 'changed' || c.path.endsWith('card.version_id'));
        return (
          <li key={c.path} className="rounded-xl border border-line p-3">
            <div className="flex items-center gap-2">
              <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${OP_TONE[c.op]}`}>{c.op}</span>
              <span className="font-display text-sm font-semibold text-ink">{describe(c, diff.labels)}</span>
            </div>
            {c.lines.length > 0 ? (
              <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-canvas p-2.5 font-mono text-[11px] leading-relaxed">
                {c.lines.map((line, i) => (
                  <div key={i} className={line.startsWith('+') ? 'bg-positive/10 text-positive' : line.startsWith('-') ? 'bg-negative/10 text-negative' : line.startsWith('@@') ? 'text-ink-faint' : 'text-ink-soft'}>
                    {line || ' '}
                  </div>
                ))}
              </pre>
            ) : !hideValues && c.op !== 'changed' && (c.after ?? c.before) && typeof (c.after ?? c.before) === 'object' && !Array.isArray(c.after ?? c.before) ? (
              <dl className="mt-2 grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1 text-xs">
                {flatten(c.after ?? c.before).filter(([, v]) => v !== '' && v !== null && !(Array.isArray(v) && !v.length)).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="font-semibold text-ink-faint">{k.replaceAll('.', ' › ').replaceAll('_', ' ')}</dt>
                    <dd className="min-w-0">
                      {typeof v === 'string' && v.includes('\n')
                        ? <pre className="overflow-auto rounded-md bg-canvas p-2 font-mono text-[11px] text-ink">{v}</pre>
                        : <span className="break-all font-mono text-ink">{show(v)}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : !hideValues && (
              <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                {c.op !== 'added' && <><span className="font-semibold text-ink-faint">Before</span><span className="break-all font-mono text-negative">{show(c.before)}</span></>}
                {c.op !== 'removed' && <><span className="font-semibold text-ink-faint">After</span><span className="break-all font-mono text-positive">{show(c.after)}</span></>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
