import type { Card, CardData, Dashboard, DashboardDetail, Dataset, GlobalFilters, Row, Scope, VersionInfo } from './types';
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
  cardVersions: (id: number) => request<VersionInfo[]>(`/api/cards/${id}/versions`),
  /** Pass the dashboard + pinned version when rendering a dashboard item. */
  cardData: (id: number, filters?: Partial<GlobalFilters>, opts?: { versionId?: number; dashboardId?: number }) =>
    request<CardData>(`/api/cards/${id}/data${filterParams(filters, { version_id: opts?.versionId, dashboard_id: opts?.dashboardId })}`),
  createCard: (payload: CardPayload) => request<Card>('/api/cards', { method: 'POST', body: JSON.stringify(payload) }),
  updateCard: (id: number | string, payload: CardPayload) => request<Card>(`/api/cards/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteCard: (id: number) => request<void>(`/api/cards/${id}`, { method: 'DELETE' }),

  dashboards: () => request<Dashboard[]>('/api/dashboards'),
  dashboard: (id: number | string) => request<DashboardDetail>(`/api/dashboards/${id}`),
  createDashboard: (payload: { name: string; description?: string }) =>
    request<Dashboard>('/api/dashboards', { method: 'POST', body: JSON.stringify(payload) }),
  saveDashboardItems: (id: number | string, items: { item_id?: string; card_id: number; x: number; y: number; w: number; h: number }[]) =>
    request<DashboardDetail>(`/api/dashboards/${id}/items`, { method: 'PUT', body: JSON.stringify({ items }) }),
  deleteDashboard: (id: number) => request<void>(`/api/dashboards/${id}`, { method: 'DELETE' }),
};
