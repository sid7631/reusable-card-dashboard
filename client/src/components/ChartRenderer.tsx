import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { CardData, ChartType, Row } from '../lib/types';
import { PALETTE, formatCell, formatMoney, formatNumber } from '../lib/format';

interface Props {
  chartType: ChartType;
  data: CardData;
  compact?: boolean;
  /** Explicit axis mapping — overrides inference when the keys exist in the result. */
  xKey?: string;
  yKeys?: string[];
}

function inferKeys(rows: Row[], xKey?: string, yKeys?: string[]): { labelKey: string; seriesKeys: string[] } {
  if (!rows.length) return { labelKey: 'label', seriesKeys: [] };
  const keys = Object.keys(rows[0]);
  if (xKey && keys.includes(xKey)) {
    const explicit = (yKeys ?? []).filter((k) => keys.includes(k) && typeof rows[0][k] === 'number');
    const series = explicit.length ? explicit : keys.filter((k) => k !== xKey && typeof rows[0][k] === 'number');
    if (series.length) return { labelKey: xKey, seriesKeys: series };
  }
  const labelKey = keys.find((k) => typeof rows[0][k] === 'string') ?? keys[0];
  const seriesKeys = keys.filter((k) => k !== labelKey && typeof rows[0][k] === 'number');
  return { labelKey, seriesKeys };
}

const axisStyle = { fontSize: 11, fill: '#51607c', fontFamily: 'IBM Plex Sans' };

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-white px-3 py-2 shadow-lg">
      <p className="font-display text-xs font-semibold text-ink">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-soft">
          <span className="inline-block size-2 rounded-full" style={{ background: p.color }} />
          {p.name}: <span className="font-mono font-medium text-ink">{formatMoney(p.value)}</span>
        </p>
      ))}
    </div>
  );
}

function Kpi({ data }: { data: CardData }) {
  const rows = data.rows;
  const value = Number(Object.values(rows[0] ?? {})[0] ?? 0);
  const { deltaPct, deltaAbs } = data.meta ?? {};
  const positive = (deltaPct ?? 0) >= 0;
  return (
    <div className="flex h-full flex-col justify-center px-1">
      <p className="font-display text-4xl font-bold tracking-tight text-ink">{formatMoney(value)}</p>
      {deltaPct !== undefined && deltaAbs !== undefined ? (
        <p className={`mt-2 text-sm font-medium ${positive ? 'text-positive' : 'text-negative'}`}>
          {positive ? '▲' : '▼'} {formatMoney(Math.abs(deltaAbs))} ({positive ? '+' : ''}{deltaPct.toFixed(0)}% YoY)
        </p>
      ) : (
        <p className="mt-2 text-sm text-ink-faint">vs prior year — select a period</p>
      )}
    </div>
  );
}

function DataTable({ rows }: { rows: Row[] }) {
  if (!rows.length) return null;
  const keys = Object.keys(rows[0]);
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-white">
          <tr>
            {keys.map((k) => (
              <th key={k} className="border-b border-line px-2 py-1.5 font-display font-semibold uppercase tracking-wide text-ink-soft">{k}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 100).map((r, i) => (
            <tr key={i} className="even:bg-canvas/60">
              {keys.map((k) => (
                <td key={k} className={`px-2 py-1.5 ${typeof r[k] === 'number' ? 'font-mono' : ''}`}>{formatCell(r[k])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ChartRenderer({ chartType, data, compact = false, xKey, yKeys }: Props) {
  const rows = data.rows;
  if (chartType === 'kpi') return <Kpi data={data} />;
  if (!rows.length) {
    return <div className="flex h-full items-center justify-center text-sm text-ink-faint">No data for the selected filters</div>;
  }
  if (chartType === 'table') return <DataTable rows={rows} />;

  const { labelKey, seriesKeys } = inferKeys(rows, xKey, yKeys);
  if (!seriesKeys.length) return <DataTable rows={rows} />;
  const multi = seriesKeys.length > 1;

  if (chartType === 'bar') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 48, bottom: 4, left: 8 }} barCategoryGap="28%">
          <XAxis type="number" hide />
          <YAxis type="category" dataKey={labelKey} width={compact ? 70 : 100} tickLine={false} axisLine={false} tick={axisStyle} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: '#016fd00f' }} />
          <Bar dataKey={seriesKeys[0]} radius={[0, 6, 6, 0]} label={{ position: 'right', fontSize: 11, fontFamily: 'IBM Plex Mono', fill: '#0a1c3f', formatter: (v: number) => formatNumber(v) }}>
            {rows.map((_, i) => (
              <Cell key={i} fill={i === 0 ? PALETTE[0] : PALETTE[0] + (i % 2 ? 'aa' : 'cc')} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === 'column') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -8 }} barCategoryGap="32%">
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#dde4ee" />
          <XAxis dataKey={labelKey} tickLine={false} axisLine={false} tick={axisStyle} />
          <YAxis tickLine={false} axisLine={false} tick={axisStyle} tickFormatter={formatNumber} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: '#016fd00f' }} />
          {seriesKeys.map((k, i) => (
            <Bar key={k} dataKey={k} fill={PALETTE[i % PALETTE.length]} radius={[6, 6, 0, 0]} />
          ))}
          {multi && <Legend wrapperStyle={{ fontSize: 11 }} />}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === 'line' || chartType === 'area') {
    const Wrapper = chartType === 'line' ? LineChart : AreaChart;
    return (
      <ResponsiveContainer width="100%" height="100%">
        <Wrapper data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#dde4ee" />
          <XAxis dataKey={labelKey} tickLine={false} axisLine={false} tick={axisStyle} minTickGap={32} />
          <YAxis tickLine={false} axisLine={false} tick={axisStyle} tickFormatter={formatNumber} />
          <Tooltip content={<ChartTooltip />} />
          {seriesKeys.map((k, i) =>
            chartType === 'line' ? (
              <Line key={k} type="monotone" dataKey={k} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} dot={false} />
            ) : (
              <Area key={k} type="monotone" dataKey={k} stroke={PALETTE[i % PALETTE.length]} fill={PALETTE[i % PALETTE.length]} fillOpacity={0.12} strokeWidth={2} />
            ),
          )}
          {multi && <Legend wrapperStyle={{ fontSize: 11 }} />}
        </Wrapper>
      </ResponsiveContainer>
    );
  }

  if (chartType === 'donut') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip content={<ChartTooltip />} />
          <Pie data={rows} dataKey={seriesKeys[0]} nameKey={labelKey} innerRadius="58%" outerRadius="85%" paddingAngle={2} strokeWidth={0}>
            {rows.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
          <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={8} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  return <DataTable rows={rows} />;
}
