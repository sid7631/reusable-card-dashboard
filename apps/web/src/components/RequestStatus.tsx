import type { RequestStatus } from '../lib/types';

const TONE: Record<RequestStatus, string> = {
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-positive/10 text-positive',
  rejected: 'bg-negative/10 text-negative',
  withdrawn: 'bg-canvas text-ink-faint',
};

export default function RequestStatusChip({ status }: { status: RequestStatus }) {
  return <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TONE[status]}`}>{status === 'pending' ? 'In review' : status}</span>;
}
