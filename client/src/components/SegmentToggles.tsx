const SEGMENTS = [
  { id: 'ALL', label: 'Total AXP' },
  { id: 'USCS', label: 'USCS' },
  { id: 'GCS', label: 'GCS' },
  { id: 'ICS', label: 'ICS' },
];

interface Props {
  value: string;
  onChange: (segment: string) => void;
}

export default function SegmentToggles({ value, onChange }: Props) {
  return (
    <div className="flex items-center gap-1 rounded-full border border-line bg-white p-1 shadow-sm">
      {SEGMENTS.map((s) => (
        <button
          key={s.id}
          onClick={() => onChange(s.id)}
          className={`rounded-full px-4 py-1.5 font-display text-sm font-semibold transition ${
            value === s.id ? 'bg-accent-deep text-white shadow' : 'text-ink-soft hover:bg-canvas hover:text-ink'
          }`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
