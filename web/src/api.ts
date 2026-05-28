import mockData from '../demo/mock-data.json';
import type { EventType, FollowerStatus, OverviewData, Page, Follower, FollowerEvent } from './types';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const IS_DEMO = import.meta.env.MODE === 'demo';

type Params = Record<string, string | number | undefined>;

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

function filterFollowers(params: Params = {}): Page<Follower> {
  const page = mockData.followers as Page<Follower>;
  const status = params.status as FollowerStatus | undefined;
  const query = String(params.q || '').trim().toLowerCase();
  const rows = page.rows.filter((row) => {
    if (status && row.status !== status) return false;
    if (!query) return true;
    return [row.nickname, row.id, row.uid].some((value) => String(value || '').toLowerCase().includes(query));
  });
  return {
    total: rows.length,
    limit: Number(params.limit || page.limit),
    offset: Number(params.offset || 0),
    rows
  };
}

function filterEvents(params: Params = {}): Page<FollowerEvent> {
  const page = mockData.events as Page<FollowerEvent>;
  const type = params.type as EventType | undefined;
  const query = String(params.q || '').trim().toLowerCase();
  const rows = page.rows.filter((row) => {
    if (type && row.type !== type) return false;
    if (!query) return true;
    return [row.nickname, row.followerId, row.type].some((value) => String(value || '').toLowerCase().includes(query));
  });
  return {
    total: rows.length,
    limit: Number(params.limit || page.limit),
    offset: Number(params.offset || 0),
    rows
  };
}

export async function loadOverview(): Promise<OverviewData> {
  if (IS_DEMO) return mockData as OverviewData;

  const [summary, timeline, eventDaily, runs, followers, events] = await Promise.all([
    fetchJson('/api/summary'),
    fetchJson('/api/timeline', { days: 30 }),
    fetchJson('/api/event-daily', { days: 30 }),
    fetchJson('/api/runs', { limit: 20 }),
    fetchJson('/api/followers', { limit: 20 }),
    fetchJson('/api/events', { limit: 20 })
  ]);

  return { summary, timeline, eventDaily, runs, followers, events } as OverviewData;
}

export async function loadFollowers(params: Params = {}): Promise<Page<Follower>> {
  if (IS_DEMO) return filterFollowers(params);
  return fetchJson('/api/followers', { limit: 20, ...params });
}

export async function loadEvents(params: Params = {}): Promise<Page<FollowerEvent>> {
  if (IS_DEMO) return filterEvents(params);
  return fetchJson('/api/events', { limit: 20, ...params });
}

export function exportUrl(name: 'latest.json' | 'latest.csv') {
  if (IS_DEMO) return '#';
  return withParams(`/api/export/${name}`);
}

export const isDemoMode = IS_DEMO;
