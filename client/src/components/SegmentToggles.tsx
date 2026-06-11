const SEGMENTS = [
  { id: 'ALL', label: 'Total AXP' },
  { id: 'USCS', label: 'USCS' },
  { id: 'GCS', label: 'GCS' },
  { id: 'ICS', label: 'ICS' },
];

interface Props {
  value: string;
  onChange: (segment: string) => void;
  compact?: boolean;
}

export default function SegmentToggles({ value, onChange, compact = false }: Props) {
  return (
    <div className={`flex items-center gap-0.5 rounded-full border border-line bg-white ${compact ? 'p-0.5' : 'gap-1 p-1 shadow-sm'}`}>
      {SEGMENTS.map((s) => (
        <button
          key={s.id}
          onClick={() => onChange(s.id)}
          className={`rounded-full font-display font-semibold transition ${compact ? 'px-2 py-0.5 text-[10px]' : 'px-4 py-1.5 text-sm'} ${
            value === s.id ? 'bg-accent-deep text-white shadow' : 'text-ink-soft hover:bg-canvas hover:text-ink'
          }`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
