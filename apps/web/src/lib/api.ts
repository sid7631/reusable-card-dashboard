import type {
  AssetKind, Card, CardData, ChangeRequestDetail, ChangeRequestSummary, Dashboard, DashboardDetail, Dataset,
  DirectoryEntry, GlobalFilters, RebasePreview, RequestStatus, Row, Scope, Share, VersionDetail, VersionDiff, VersionInfo,
} from './types';
import { getToken, signOut } from './auth';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    // Expired or missing session — back to sign-in
    signOut();
    window.location.assign('/login');
    throw new Error('Signed out.');
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorMessage(body) || `Request failed (${res.status})`);
  return body as T;
}

function errorMessage(body: unknown): string | undefined {
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object' && 'message' in detail) return String((detail as { message: unknown }).message);
  if (Array.isArray(detail)) return detail.map((d) => d.msg ?? JSON.stringify(d)).join('; ');
  return undefined;
}

function filterParams(filters?: Partial<GlobalFilters>, extra?: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  if (filters?.segment && filters.segment !== 'ALL') params.set('segment', filters.segment);
  if (filters?.subSegments?.length) params.set('sub_segments', filters.subSegments.join(','));
  if (filters?.from) params.set('from', filters.from);
  if (filters?.to) params.set('to', filters.to);
  for (const [k, v] of Object.entries(extra ?? {})) if (v !== undefined) params.set(k, String(v));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** Lets the sidebar's review badge refresh as soon as a request changes state. */
export const REQUESTS_CHANGED = 'sb:requests-changed';
function notifyRequestsChanged<T>(value: T): T {
  window.dispatchEvent(new Event(REQUESTS_CHANGED));
  return value;
}

export type CardPayload = Pick<Card, 'name' | 'description' | 'chart_type' | 'config' | 'sql_text' | 'created_via' | 'data_source_id'> & {
  change_note?: string;
};

export const api = {
  me: () => request<{ id: number; name: string; role: string }>('/api/me'),
  datasets: () => request<Dataset[]>('/api/datasets'),
  query: (sql: string, dataSourceId: number) =>
    request<{ rows: Row[]; ms: number }>('/api/query', { method: 'POST', body: JSON.stringify({ sql, data_source_id: dataSourceId }) }),

  cards: (scope?: Scope | 'shared') => request<Card[]>(`/api/cards${scope ? `?scope=${scope}` : ''}`),
  card: (id: number | string) => request<Card>(`/api/cards/${id}`),
  /** Pass the dashboard + pinned version when rendering a dashboard item. */
  cardData: (id: number, filters?: Partial<GlobalFilters>, opts?: { versionId?: number; dashboardId?: number }) =>
    request<CardData>(`/api/cards/${id}/data${filterParams(filters, { version_id: opts?.versionId, dashboard_id: opts?.dashboardId })}`),
  createCard: (payload: CardPayload) => request<Card>('/api/cards', { method: 'POST', body: JSON.stringify(payload) }),
  updateCard: (id: number | string, payload: CardPayload) => request<Card>(`/api/cards/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteCard: (id: number) => request<void>(`/api/cards/${id}`, { method: 'DELETE' }),

  dashboards: (scope?: Scope | 'shared') => request<Dashboard[]>(`/api/dashboards${scope ? `?scope=${scope}` : ''}`),
  dashboard: (id: number | string) => request<DashboardDetail>(`/api/dashboards/${id}`),
  createDashboard: (payload: { name: string; description?: string }) =>
    request<Dashboard>('/api/dashboards', { method: 'POST', body: JSON.stringify(payload) }),
  saveDashboardItems: (id: number | string, items: { item_id?: string; card_id: number; x: number; y: number; w: number; h: number }[]) =>
    request<DashboardDetail>(`/api/dashboards/${id}/items`, { method: 'PUT', body: JSON.stringify({ items }) }),
  deleteDashboard: (id: number) => request<void>(`/api/dashboards/${id}`, { method: 'DELETE' }),

  // Governance — same endpoints for every asset kind
  versions: (kind: AssetKind, id: number) => request<VersionInfo[]>(`/api/${kind}/${id}/versions`),
  version: (kind: AssetKind, id: number, no: number) => request<VersionDetail>(`/api/${kind}/${id}/versions/${no}`),
  diff: (kind: AssetKind, id: number, fromNo: number, toNo?: number) =>
    request<VersionDiff>(`/api/${kind}/${id}/diff?from_no=${fromNo}${toNo ? `&to_no=${toNo}` : ''}`),
  restore: (kind: AssetKind, id: number, no: number) =>
    request<VersionInfo>(`/api/${kind}/${id}/restore/${no}`, { method: 'POST' }),
  shares: (kind: AssetKind, id: number) => request<Share[]>(`/api/${kind}/${id}/shares`),
  share: (kind: AssetKind, id: number, userId: number, permission: Share['permission']) =>
    request<{ user_id: number; permission: string }>(`/api/${kind}/${id}/shares/${userId}`, { method: 'PUT', body: JSON.stringify({ permission }) }),
  unshare: (kind: AssetKind, id: number, userId: number) =>
    request<void>(`/api/${kind}/${id}/shares/${userId}`, { method: 'DELETE' }),
  users: (q = '') => request<DirectoryEntry[]>(`/api/users${q ? `?q=${encodeURIComponent(q)}` : ''}`),

  // Fork-on-edit and PR-style change requests
  fork: (kind: AssetKind, id: number) => request<{ id: number; created: boolean }>(`/api/${kind}/${id}/fork`, { method: 'POST' }),
  rebasePreview: (kind: AssetKind, id: number) => request<RebasePreview>(`/api/${kind}/${id}/rebase`),
  rebase: (kind: AssetKind, id: number, resolutions: Record<string, 'ours' | 'theirs'>) =>
    request<{ version_no: number | null }>(`/api/${kind}/${id}/rebase`, { method: 'POST', body: JSON.stringify({ resolutions }) }),
  applyUpdates: (dashboardId: number, itemIds?: string[]) =>
    request<DashboardDetail>(`/api/dashboards/${dashboardId}/apply-updates`, { method: 'POST', body: JSON.stringify({ item_ids: itemIds ?? null }) }),

  changeRequests: (status: RequestStatus | 'all' = 'all') => request<ChangeRequestSummary[]>(`/api/change-requests?status=${status}`),
  changeRequestSummary: () => request<{ pending: number }>('/api/change-requests/summary'),
  changeRequest: (id: number | string) => request<ChangeRequestDetail>(`/api/change-requests/${id}`),
  submitChangeRequest: (payload: { kind: AssetKind; asset_id: number; title: string; description?: string }) =>
    request<ChangeRequestDetail>('/api/change-requests', { method: 'POST', body: JSON.stringify(payload) }).then(notifyRequestsChanged),
  decideChangeRequest: (id: number, action: 'approve' | 'reject' | 'withdraw' | 'update', comment = '') =>
    request<ChangeRequestDetail>(`/api/change-requests/${id}/${action}`, { method: 'POST', body: JSON.stringify({ comment }) })
      .then(notifyRequestsChanged),
  previewRequestItem: (id: number, itemId: number, filters?: Partial<GlobalFilters>) =>
    request<CardData & { chart_type: Card['chart_type']; config: Card['config'] }>(`/api/change-requests/${id}/items/${itemId}/data${filterParams(filters)}`),
};
