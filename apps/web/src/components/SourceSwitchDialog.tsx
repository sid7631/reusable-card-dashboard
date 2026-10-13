import { useState } from 'react';
import type { CardConfig, Dataset } from '../lib/types';
import { SOURCE_TYPE_LABEL } from '../pages/DataSourcesPage';
import Modal from './Modal';

interface Props {
  datasets: Dataset[];
  currentId: number | undefined;
  /** SQL cards keep their SQL; builder cards keep the fields the new source also has. */
  mode: 'builder' | 'sql' | 'copilot';
  config: CardConfig;
  onClose: () => void;
  onSwitch: (sourceId: number, config: CardConfig) => void;
}

function primaryOf(d: Dataset) {
  return d.model.datasets.find((x) => x.name === d.name) ?? d.model.datasets[0];
}

/** Fields the card uses that the new source lacks — they reset when switching. */
export function missingFields(config: CardConfig, target: Dataset): string[] {
  const primary = primaryOf(target);
  const dims = new Set((primary?.dimensions ?? []).map((d) => d.name));
  const measures = new Set((primary?.measures ?? []).map((m) => m.name));
  const columns = new Set(target.columns.map((c) => c.name));
  const used: [string, boolean][] = [
    ...(config.dimension ? [[`Category “${config.dimension}”`, dims.has(config.dimension)] as [string, boolean]] : []),
    ...(config.dimension2 ? [[`Sub-category “${config.dimension2}”`, dims.has(config.dimension2)] as [string, boolean]] : []),
    ...(config.measure ? [[`Measure “${config.measure}”`, measures.has(config.measure)] as [string, boolean]]
      : config.agg !== 'COUNT' && config.metric ? [[`Column “${config.metric}”`, columns.has(config.metric)] as [string, boolean]] : []),
    ...(config.filters ?? []).filter((f) => f.field).map((f) => [`Filter on “${f.field}”`, dims.has(f.field)] as [string, boolean]),
    ...(config.controls?.filters ?? []).map((f) => [`On-card dropdown “${f}”`, dims.has(f)] as [string, boolean]),
  ];
  return [...new Set(used.filter(([, ok]) => !ok).map(([label]) => label))];
}

/** Drop what the new source can't serve; the studio then fills dimension/measure with its first valid choice. */
function keepCompatible(config: CardConfig, target: Dataset): CardConfig {
  const dims = new Set((primaryOf(target)?.dimensions ?? []).map((d) => d.name));
  const filters = config.controls?.filters?.filter((f) => dims.has(f));
  return {
    ...config,
    filters: (config.filters ?? []).filter((f) => dims.has(f.field)),
    controls: config.controls ? { ...config.controls, filters: filters?.length ? filters : undefined } : undefined,
  };
}

/** Move a card to another data source, saying first what carries over and what doesn't. */
export default function SourceSwitchDialog({ datasets, currentId, mode, config, onClose, onSwitch }: Props) {
  const [chosen, setChosen] = useState<number>();
  const target = datasets.find((d) => d.id === chosen);
  const missing = target && mode !== 'sql' ? missingFields(config, target) : [];

  return (
    <Modal wide title="Change data source"
      subtitle="The card keeps its history. Dashboards keep showing the version they use until someone updates the card there."
      onClose={onClose}>
      <div className="grid max-h-64 grid-cols-1 gap-2 overflow-auto sm:grid-cols-2">
        {datasets.filter((d) => d.id !== currentId).map((d) => (
          <button key={d.id} disabled={Boolean(d.error)} onClick={() => setChosen(d.id)} title={d.error}
            className={`rounded-xl border p-3 text-left transition disabled:opacity-50 ${
              d.id === chosen ? 'border-accent bg-accent-soft ring-2 ring-accent/30' : 'border-line bg-white enabled:hover:border-accent/50'}`}>
            <span className="flex items-center justify-between gap-2">
              <span className="truncate font-display text-sm font-bold text-ink">{d.label}</span>
              <span className="shrink-0 rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent">{SOURCE_TYPE_LABEL[d.type]}</span>
            </span>
            <span className="mt-0.5 block truncate text-xs text-ink-faint">{d.error ? 'Unavailable' : `${primaryOf(d)?.label || d.name} · ${d.rowCount.toLocaleString()} rows`}</span>
          </button>
        ))}
      </div>

      {target && (
        <div className="mt-4 rounded-xl border px-4 py-3 text-sm">
          {mode === 'sql' ? (
            <p className="text-ink">
              <span className="font-semibold">Your SQL stays as it is</span> and is checked against {target.label}. Table names
              and SQL style can differ between Postgres, BigQuery and files — run the preview, fix anything it reports, then save.
            </p>
          ) : missing.length ? (
            <>
              <p className="font-semibold text-amber-800">{target.label} doesn't have everything this card uses:</p>
              <ul className="mt-1 list-inside list-disc text-xs text-ink">{missing.map((m) => <li key={m}>{m}</li>)}</ul>
              <p className="mt-1.5 text-xs text-ink-soft">These reset to the closest available choice — check them in the builder before saving.</p>
            </>
          ) : (
            <p className="text-positive"><span className="font-semibold">Everything carries over</span> — {target.label} has all the fields this card uses.</p>
          )}
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition hover:text-ink">Cancel</button>
        <button disabled={!target} onClick={() => target && onSwitch(target.id, mode === 'sql' ? config : keepCompatible(config, target))}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition enabled:hover:bg-accent-deep disabled:opacity-40">
          {target && missing.length ? 'Switch anyway' : 'Switch source'}
        </button>
      </div>
    </Modal>
  );
}
