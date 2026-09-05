import mockData from '../demo/mock-data.json';
import type { CookieAuthStatus, EventType, FollowerStatus, OverviewData, Page, Follower, FollowerEvent, RuntimeHealthStatus, RunCompareResult, ScanConfig, ScanJobStatus, ScanRun, ScanRunDetail } from './types';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const IS_DEMO = import.meta.env.MODE === 'demo';

type Params = Record<string, string | number | undefined>;
const DEFAULT_PAGE_LIMIT = 50;

function withParams(path: string, params: Params = {}) {
  const url = new URL(path, API_BASE || window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  if (!API_BASE) return `${url.pathname}${url.search}`;
  return url.toString();
}

async function fetchJson<T>(path: string, params?: Params): Promise<T> {
  const response = await fetch(withParams(path, params), { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`请求失败: ${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

async function mutateJson<T>(path: string, method: 'POST' | 'DELETE', action: 'scan' | 'auth', payload?: unknown): Promise<T> {
  const response = await fetch(withParams(path), {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-douyin-dashboard-action': action
    },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const responseBody = await response.json().catch(() => ({} as { error?: string }));
  if (!response.ok) {
    const error = responseBody?.error || `${response.status} ${response.statusText}`;
    throw new Error(String(error));
  }
  return responseBody as T;
}

function filterFollowers(params: Params = {}): Page<Follower> {
  const page = mockData.followers as Page<Follower>;
  const status = params.status as FollowerStatus | undefined;
  const query = String(params.q || '').trim().toLowerCase();
  const limit = Number(params.limit || page.limit || DEFAULT_PAGE_LIMIT);
  const offset = Number(params.offset || 0);
  const rows = page.rows.filter((row) => {
    if (status && row.status !== status) return false;
    if (!query) return true;
    return [row.nickname, row.id, row.uid].some((value) => String(value || '').toLowerCase().includes(query));
  });
  return {
    total: rows.length,
    limit,
    offset,
    rows: rows.slice(offset, offset + limit)
  };
}

function filterEvents(params: Params = {}): Page<FollowerEvent> {
  const page = mockData.events as Page<FollowerEvent>;
  const type = params.type as EventType | undefined;
  const runId = String(params.runId || '');
  const query = String(params.q || '').trim().toLowerCase();
  const limit = Number(params.limit || page.limit || DEFAULT_PAGE_LIMIT);
  const offset = Number(params.offset || 0);
  const rows = page.rows.filter((row) => {
    if (type && row.type !== type) return false;
    if (runId && row.runId !== runId) return false;
    if (!query) return true;
    return [row.nickname, row.followerId, row.type].some((value) => String(value || '').toLowerCase().includes(query));
  });
  return {
    total: rows.length,
    limit,
    offset,
    rows: rows.slice(offset, offset + limit)
  };
}

export async function loadOverview(): Promise<OverviewData> {
  if (IS_DEMO) return mockData as OverviewData;

  const [summary, timeline, eventDaily, runs, followers, events] = await Promise.all([
    fetchJson('/api/summary'),
    fetchJson('/api/timeline', { days: 30 }),
    fetchJson('/api/event-daily', { days: 30 }),
    fetchJson('/api/runs', { limit: 20 }),
    fetchJson('/api/followers', { limit: DEFAULT_PAGE_LIMIT }),
    fetchJson('/api/events', { limit: DEFAULT_PAGE_LIMIT })
  ]);

  return { summary, timeline, eventDaily, runs, followers, events } as OverviewData;
}

export async function loadFollowers(params: Params = {}): Promise<Page<Follower>> {
  if (IS_DEMO) return filterFollowers(params);
  return fetchJson('/api/followers', { limit: DEFAULT_PAGE_LIMIT, ...params });
}

export async function loadEvents(params: Params = {}): Promise<Page<FollowerEvent>> {
  if (IS_DEMO) return filterEvents(params);
  return fetchJson('/api/events', { limit: DEFAULT_PAGE_LIMIT, ...params });
}

export async function loadRunDetail(runId: string): Promise<ScanRunDetail> {
  if (IS_DEMO) {
    const run = ((mockData.runs || []) as ScanRun[]).find((item) => item.runId === runId);
    if (!run) throw new Error('run-not-found');
    const rows = ((mockData.events as Page<FollowerEvent>).rows || []).filter((event) => event.runId === runId);
    return {
      ...run,
      eventCounts: {
        new: rows.filter((event) => event.type === 'new').length,
        renamed: rows.filter((event) => event.type === 'renamed').length,
        suspected_removed: rows.filter((event) => event.type === 'suspected_removed').length,
        removed: rows.filter((event) => event.type === 'removed').length,
        mutual_unfollowed_you: rows.filter((event) => event.type === 'mutual_unfollowed_you').length,
        reappeared: rows.filter((event) => event.type === 'reappeared').length
      }
    };
  }
  return fetchJson(`/api/runs/${encodeURIComponent(runId)}`);
}

export async function loadRunEvents(runId: string, params: Params = {}): Promise<Page<FollowerEvent>> {
  if (IS_DEMO) return filterEvents({ ...params, runId });
  return fetchJson(`/api/runs/${encodeURIComponent(runId)}/events`, { limit: DEFAULT_PAGE_LIMIT, ...params });
}

export async function loadRunCompare(from: string, to: string): Promise<RunCompareResult> {
  if (IS_DEMO) {
    const runs = (mockData.runs || []) as ScanRun[];
    const fromRun = runs.find((run) => run.runId === from);
    const toRun = runs.find((run) => run.runId === to);
    if (!fromRun || !toRun) throw new Error('compare-runs-not-found');
    const rows = ((mockData.events as Page<FollowerEvent>).rows || []).filter((event) => event.runId === to);
    const result = {
      fromRun,
      toRun,
      warning: fromRun.mode !== 'full' || toRun.mode !== 'full'
        ? '包含 recent 扫描时，对比结果只作为事件窗口参考；只有 full 扫描缺失才能作为取关判断。'
        : '',
      added: rows.filter((event) => event.type === 'new'),
      missing: rows.filter((event) => event.type === 'suspected_removed' || event.type === 'removed'),
      renamed: rows.filter((event) => event.type === 'renamed'),
      reappeared: rows.filter((event) => event.type === 'reappeared')
    };
    return {
      ...result,
      counts: {
        added: result.added.length,
        missing: result.missing.length,
        renamed: result.renamed.length,
        reappeared: result.reappeared.length
      }
    };
  }
  return fetchJson('/api/compare', { from, to });
}

export async function loadScanStatus(): Promise<ScanJobStatus> {
  if (IS_DEMO) {
    return {
      id: null,
      status: 'idle',
      mode: 'monitor',
      requestedMode: 'monitor',
      reason: '',
      startedAt: null,
      finishedAt: null,
      pagesFetched: 0,
      count: 0,
      profileFollowerCount: null,
      hiddenOrUnavailableCount: null,
      runtime: 'demo',
      runtimeLabel: 'Demo data',
      cookieAuth: {
        configured: false,
        exportedAt: null,
        sourceUrl: '',
        cookieCount: 0,
        acceptedCount: 0,
        skippedCount: 0,
        skippedReasons: [],
        updatedAt: null,
        runtimeSupported: false
      },
      phase: 'idle',
      authChallenge: null,
      exitCode: null,
      signal: null,
      error: '',
      logLines: [],
      changeSummary: null,
      partial: null
    };
  }
  return fetchJson('/api/scan/status');
}

export async function loadScanConfig(): Promise<ScanConfig> {
  if (IS_DEMO) {
    return {
      runtime: 'demo',
      runtimeLabel: 'Demo data',
      mode: 'monitor',
      cdpUrl: 'http://127.0.0.1:9222',
      browserApp: '',
      cookieRuntimeSupported: false,
      canEdit: false,
      options: {
        runtimes: [
          { value: 'apple-events', label: '豆包浏览器', detail: 'macOS Apple Events 复用当前浏览器' },
          { value: 'cdp', label: 'CDP', detail: '连接已登录 Chrome/Edge/Chromium' },
          { value: 'playwright', label: 'Playwright', detail: '持久 profile，可配合 Cookie 导入' }
        ],
        modes: [
          { value: 'monitor', label: '自动', detail: '自动决策 recent/full' },
          { value: 'recent', label: '轻量', detail: '只扫最近窗口' },
          { value: 'full', label: '全量', detail: '完整分页并判断取关' }
        ]
      }
    };
  }
  return fetchJson('/api/scan/config');
}

export async function updateScanConfig(patch: Partial<Pick<ScanConfig, 'runtime' | 'mode' | 'cdpUrl'>>): Promise<{ config: ScanConfig; status: ScanJobStatus }> {
  return mutateJson('/api/scan/config', 'POST', 'scan', patch);
}

export async function startScanJob(): Promise<{ status: ScanJobStatus }> {
  return mutateJson('/api/scan/start', 'POST', 'scan');
}

export async function stopScanJob(): Promise<{ status: ScanJobStatus }> {
  return mutateJson('/api/scan/stop', 'POST', 'scan');
}

export async function loadCookieAuthStatus(): Promise<CookieAuthStatus> {
  if (IS_DEMO) {
    return {
      configured: false,
      exportedAt: null,
      sourceUrl: '',
      cookieCount: 0,
      acceptedCount: 0,
      skippedCount: 0,
      skippedReasons: [],
      updatedAt: null,
      runtimeSupported: false
    };
  }
  return fetchJson('/api/auth/cookies/status');
}

export async function loadRuntimeHealth(): Promise<RuntimeHealthStatus> {
  if (IS_DEMO) {
    return {
      runtime: 'demo',
      runtimeLabel: 'Demo data',
      level: 'warning',
      headline: '公开演示不连接本地浏览器',
      recommendation: 'Demo 站只展示 mock 数据；本地运行时会显示 Playwright、CDP 或 Apple Events 的真实健康状态。',
      recommendedRuntime: 'cdp',
      checks: [
        { id: 'runtime', label: '浏览器 Runtime', state: 'info', detail: 'Demo mode 不启动采集 runtime。' },
        { id: 'cookie-auth', label: 'Cookie 登录态', state: 'info', detail: 'Demo mode 不读取本地 cookie。' },
        { id: 'verification', label: '验证状态', state: 'info', detail: 'Demo mode 不连接抖音页面。' },
        { id: 'privacy-boundary', label: '安全边界', state: 'pass', detail: '公开演示只包含 synthetic mock 数据。' }
      ],
      commandHint: 'DOUYIN_CDP_URL=http://127.0.0.1:9222 npm run dashboard'
    };
  }
  return fetchJson('/api/runtime/health');
}

export async function importCookieAuth(filename: string, content: string): Promise<CookieAuthStatus> {
  return mutateJson('/api/auth/cookies/import', 'POST', 'auth', { filename, content });
}

export async function clearCookieAuth(): Promise<CookieAuthStatus> {
  return mutateJson('/api/auth/cookies', 'DELETE', 'auth');
}

export function connectScanEvents(onStatus: (status: ScanJobStatus) => void, onError: (error: Event) => void) {
  if (IS_DEMO) return () => {};
  const source = new EventSource(withParams('/api/scan/events'));
  source.addEventListener('status', (event) => {
    onStatus(JSON.parse((event as MessageEvent).data) as ScanJobStatus);
  });
  source.onerror = onError;
  return () => source.close();
}

export function exportUrl(name: 'latest.json' | 'latest.csv') {
  if (IS_DEMO) return '#';
  return withParams(`/api/export/${name}`);
}

export const isDemoMode = IS_DEMO;
