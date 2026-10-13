import type { RequestStatus } from '../lib/types';

const TONE: Record<RequestStatus, string> = {
  pending: 'bg-amber-100 text-amber-800',
  changes_requested: 'bg-sky-100 text-sky-800',
  approved: 'bg-positive/10 text-positive',
  rejected: 'bg-negative/10 text-negative',
  withdrawn: 'bg-canvas text-ink-faint',
};

export const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export default function RequestStatusChip({ status }: { status: RequestStatus }) {
  return <span className={`whitespace-nowrap rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}
