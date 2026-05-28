export type FollowerStatus = 'active' | 'suspected_removed' | 'removed';
export type EventType = 'new' | 'seen' | 'suspected_removed' | 'removed' | 'reappeared' | 'renamed';
export type ScanStatus = 'completed' | 'interrupted' | 'failed' | 'running';

export interface ScanRun {
  runId: string;
  mode: string;
  requestedMode: string;
  startedAt: string;
  finishedAt: string | null;
  status: ScanStatus | string;
  profileFollowerCount: number | null;
  enumerableCount: number | null;
  hiddenOrUnavailableCount?: number;
  pagesFetched: number;
  reason: string;
}

export interface Follower {
  id: string;
  uid: string;
  nickname: string;
  profileUrl: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastFullSeenAt: string | null;
  status: FollowerStatus;
  suspectedRemovedAt: string | null;
  removedAt: string | null;
  missingFullScans?: number;
}

export interface FollowerEvent {
  eventId: number;
  followerId: string;
  type: EventType;
  runId: string;
  createdAt: string;
  payloadJson?: string;
  payload?: Record<string, unknown>;
  nickname: string | null;
  profileUrl: string | null;
  status: FollowerStatus | null;
}

export interface Page<T> {
  total: number;
  limit: number;
  offset: number;
  rows: T[];
}

export interface StatusCounts {
  active: number;
  suspected_removed: number;
  removed: number;
  total: number;
}

export interface DashboardSummary {
  generatedAt: string;
  hasDatabase: boolean;
  dbPath?: string;
  outDir?: string;
  statusCounts: StatusCounts;
  profileFollowerCount: number | null;
  enumerableCount: number;
  hiddenOrUnavailableCount: number;
  latestRun: ScanRun | null;
  latestCompletedRun: ScanRun | null;
  latestChange: Record<string, unknown> | null;
  lastChangeCounts: {
    newCount: number;
    suspectedRemovedCount: number;
    removedCount: number;
    renamedCount: number;
    reappearedCount: number;
  };
}

export interface TimelinePoint extends ScanRun {
  hiddenOrUnavailableCount: number;
}

export interface EventDailyPoint {
  date: string;
  new: number;
  renamed: number;
  suspected_removed: number;
  removed: number;
  reappeared: number;
}

export interface OverviewData {
  summary: DashboardSummary;
  timeline: TimelinePoint[];
  eventDaily: EventDailyPoint[];
  runs: ScanRun[];
  followers: Page<Follower>;
  events: Page<FollowerEvent>;
}

export type ScanJobState = 'idle' | 'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'interrupted';

export interface ScanJobPartial {
  collectedAt: string | null;
  status: string;
  mode: string;
  requestedMode: string;
  reason: string;
  runtime: string;
  runtimeLabel: string;
  pagesFetched: number;
  count: number;
  scanComplete: boolean | null;
  profileFollowerCount: number | null;
}

export interface ScanJobChangeSummary {
  newCount: number;
  suspectedRemovedCount: number;
  removedCount: number;
  reappearedCount: number;
  renamedCount: number;
  hiddenOrUnavailableCount?: number | null;
}

export interface ScanJobStatus {
  id: string | null;
  status: ScanJobState;
  mode: string;
  requestedMode: string;
  reason: string;
  startedAt: string | null;
  finishedAt: string | null;
  pagesFetched: number;
  count: number;
  profileFollowerCount: number | null;
  hiddenOrUnavailableCount: number | null;
  runtime: string;
  runtimeLabel: string;
  exitCode: number | null;
  signal: string | null;
  error: string;
  logLines: string[];
  changeSummary: ScanJobChangeSummary | null;
  partial: ScanJobPartial | null;
}
