import { keepPreviousData, QueryClient, useQuery } from '@tanstack/react-query';
import { api, ApiError, onApiWrite } from './api';
import type { AppliedFilters, AssetKind, RequestStatus, Scope, SemanticQuery } from './types';

/**
 * Server state lives here (TanStack Query): lists and details are cached, shared between components,
 * de-duplicated and refreshed in the background. Page-local UI state stays in the components.
 *
 * Two families of keys:
 *   ['assets' | 'requests' | …, …]  governance data — any write can change it (a fork, an approval,
 *                                   a share), so every successful write marks all of it stale and the
 *                                   queries on screen refetch.
 *   ['data', …]                     query results and filter values — keyed by immutable versions and
 *                                   filters, so writes never invalidate them; they just age out.
 */

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Retry once on outages; a 4xx (bad query, no access, not found) won't succeed on a second try
      retry: (failures, error) => failures < 1 && !(error instanceof ApiError && error.status < 500),
      refetchOnWindowFocus: true,
    },
  },
});

onApiWrite(() => queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'data' }));

type ListScope = Scope | 'shared' | 'deleted' | undefined;

export const keys = {
  cards: (scope?: ListScope) => ['assets', 'cards', 'list', scope ?? 'all'] as const,
  card: (id: number | string) => ['assets', 'cards', 'detail', String(id)] as const,
  dashboards: (scope?: ListScope) => ['assets', 'dashboards', 'list', scope ?? 'all'] as const,
  dashboard: (id: number | string) => ['assets', 'dashboards', 'detail', String(id)] as const,
  dataSources: (scope?: ListScope) => ['assets', 'data-sources', 'list', scope ?? 'all'] as const,
  dataSource: (id: number | string) => ['assets', 'data-sources', 'detail', String(id)] as const,
  datasets: () => ['assets', 'datasets'] as const,
  versions: (kind: AssetKind, id: number) => ['assets', kind, 'versions', id] as const,
  diff: (kind: AssetKind, id: number, from: number, to?: number) => ['assets', kind, 'diff', id, from, to ?? 'head'] as const,
  shares: (kind: AssetKind, id: number) => ['assets', kind, 'shares', id] as const,
  rebase: (kind: AssetKind, id: number) => ['assets', kind, 'rebase', id] as const,
  filterable: (dashboardId: number) => ['assets', 'dashboards', 'filterable', dashboardId] as const,
  requests: (status: RequestStatus | 'open' | 'all') => ['requests', 'list', status] as const,
  request: (id: number | string) => ['requests', 'detail', String(id)] as const,
  requestSummary: () => ['requests', 'summary'] as const,
  users: (q: string) => ['users', q] as const,
  assistantConfig: () => ['assistant', 'config'] as const,
};

// ---------------------------------------------------------------- governance data
export const useCards = (scope?: ListScope, enabled = true) =>
  useQuery({ queryKey: keys.cards(scope), queryFn: () => api.cards(scope), enabled });
/**
 * `editor`: the detail feeds a form. It still refreshes after this session's own writes, but not on
 * window focus, so someone else's save can't swap the content under unsaved edits.
 */
type DetailOptions = { editor?: boolean };
const detailOptions = (o?: DetailOptions) => (o?.editor ? { refetchOnWindowFocus: false } : {});

export const useCard = (id?: number | string, o?: DetailOptions) =>
  useQuery({ queryKey: keys.card(id ?? ''), queryFn: () => api.card(id!), enabled: id !== undefined, ...detailOptions(o) });
export const useDashboards = (scope?: ListScope) =>
  useQuery({ queryKey: keys.dashboards(scope), queryFn: () => api.dashboards(scope) });
export const useDashboard = (id?: number | string) =>
  useQuery({ queryKey: keys.dashboard(id ?? ''), queryFn: () => api.dashboard(id!), enabled: id !== undefined });
export const useDataSources = (scope?: ListScope) =>
  useQuery({ queryKey: keys.dataSources(scope), queryFn: () => api.dataSources(scope) });
export const useDataSource = (id?: number | string, o?: DetailOptions) =>
  useQuery({ queryKey: keys.dataSource(id ?? ''), queryFn: () => api.dataSource(id!), enabled: id !== undefined, ...detailOptions(o) });
export const useDatasets = () => useQuery({
  queryKey: keys.datasets(), queryFn: api.datasets,
  // A slow source comes back as "loading" rather than holding up the list — ask again until it's in
  refetchInterval: (q) => (q.state.data?.some((d) => d.loading) ? 2000 : false),
});

export const useVersions = (kind: AssetKind, id: number) =>
  useQuery({ queryKey: keys.versions(kind, id), queryFn: () => api.versions(kind, id) });
export const useDiff = (kind: AssetKind, id: number, from: number | undefined, to?: number) =>
  useQuery({ queryKey: keys.diff(kind, id, from ?? 0, to), queryFn: () => api.diff(kind, id, from!, to), enabled: from !== undefined });
export const useShares = (kind: AssetKind, id: number) =>
  useQuery({ queryKey: keys.shares(kind, id), queryFn: () => api.shares(kind, id) });
export const useRebasePreview = (kind: AssetKind, id: number) =>
  useQuery({ queryKey: keys.rebase(kind, id), queryFn: () => api.rebasePreview(kind, id), staleTime: 0 });
export const useFilterable = (dashboardId: number) =>
  useQuery({ queryKey: keys.filterable(dashboardId), queryFn: () => api.dashboardFilterable(dashboardId) });

export const useChangeRequests = (status: RequestStatus | 'open' | 'all') =>
  useQuery({ queryKey: keys.requests(status), queryFn: () => api.changeRequests(status) });
export const useChangeRequest = (id?: number | string) =>
  useQuery({ queryKey: keys.request(id ?? ''), queryFn: () => api.changeRequest(id!), enabled: id !== undefined });
/** The sidebar badge: polls so admins see new requests without navigating. */
export const useRequestSummary = () =>
  useQuery({ queryKey: keys.requestSummary(), queryFn: api.changeRequestSummary, refetchInterval: 60_000 });

export const useUsers = (q: string) =>
  useQuery({ queryKey: keys.users(q), queryFn: () => api.users(q), placeholderData: keepPreviousData });
export const useAssistantConfig = (enabled: boolean) =>
  useQuery({ queryKey: keys.assistantConfig(), queryFn: api.assistantConfig, enabled, staleTime: Infinity });

// ---------------------------------------------------------------- data (keyed by immutable versions)
const DATA_STALE_MS = 60_000;

export const useCardPreview = (cardId: number, versionNo: number, filters: Partial<AppliedFilters>) =>
  useQuery({
    queryKey: ['data', 'card', cardId, versionNo, filters] as const,
    queryFn: () => api.cardData(cardId, filters),
    staleTime: DATA_STALE_MS,
  });

export const useRequestItemPreview = (requestId: number, itemId: number, versionNo: number, filters: Partial<AppliedFilters>, enabled: boolean) =>
  useQuery({
    queryKey: ['data', 'request-item', requestId, itemId, versionNo, filters] as const,
    queryFn: () => api.previewRequestItem(requestId, itemId, filters),
    staleTime: DATA_STALE_MS,
    enabled,
  });

export const useCompiledSql = (dataSourceId: number | undefined, query: SemanticQuery | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ['data', 'compile', dataSourceId, query] as const,
    queryFn: () => api.semanticCompile(dataSourceId!, query!),
    enabled: enabled && dataSourceId !== undefined && query !== undefined,
    staleTime: Infinity,
  });

/** Filter dropdown values: `key` identifies the filter and its parent selections. */
export const useFilterOptions = (key: readonly unknown[], load: () => Promise<string[]>, enabled: boolean) =>
  useQuery({ queryKey: ['data', 'filter-options', ...key], queryFn: load, enabled, staleTime: 5 * 60_000 });
