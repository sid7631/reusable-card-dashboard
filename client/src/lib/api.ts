import type { Card, CardData, Dashboard, DashboardDetail, Dataset, GlobalFilters, Row } from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  return body as T;
}

function filterParams(filters?: Partial<GlobalFilters>): string {
  if (!filters) return '';
  const params = new URLSearchParams();
  if (filters.segment && filters.segment !== 'ALL') params.set('segment', filters.segment);
  if (filters.subSegments?.length) params.set('sub_segments', filters.subSegments.join(','));
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export const api = {
  datasets: () => request<Dataset[]>('/api/datasets'),
  query: (sql: string) => request<{ rows: Row[]; ms: number }>('/api/query', { method: 'POST', body: JSON.stringify({ sql }) }),

  cards: () => request<Card[]>('/api/cards'),
  card: (id: number | string) => request<Card>(`/api/cards/${id}`),
  cardData: (id: number, filters?: Partial<GlobalFilters>) => request<CardData>(`/api/cards/${id}/data${filterParams(filters)}`),
  createCard: (payload: Partial<Card>) => request<Card>('/api/cards', { method: 'POST', body: JSON.stringify(payload) }),
  updateCard: (id: number | string, payload: Partial<Card>) => request<Card>(`/api/cards/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteCard: (id: number) => request<void>(`/api/cards/${id}`, { method: 'DELETE' }),

  dashboards: () => request<Dashboard[]>('/api/dashboards'),
  dashboard: (id: number | string) => request<DashboardDetail>(`/api/dashboards/${id}`),
  createDashboard: (payload: { name: string; description?: string }) =>
    request<Dashboard>('/api/dashboards', { method: 'POST', body: JSON.stringify(payload) }),
  saveDashboardItems: (id: number | string, items: { card_id: number; x: number; y: number; w: number; h: number }[]) =>
    request<{ ok: boolean }>(`/api/dashboards/${id}/items`, { method: 'PUT', body: JSON.stringify({ items }) }),
  deleteDashboard: (id: number) => request<void>(`/api/dashboards/${id}`, { method: 'DELETE' }),
};
