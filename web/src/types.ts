export type FollowerStatus = 'active' | 'suspected_removed' | 'removed';
export type RelationshipStatus = 'unknown' | 'mutual' | 'follower_only';
export type EventType = 'new' | 'seen' | 'suspected_removed' | 'removed' | 'mutual_unfollowed_you' | 'reappeared' | 'renamed';
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

export interface ScanRunDetail extends ScanRun {
  eventCounts: {
    new: number;
    renamed: number;
    suspected_removed: number;
    removed: number;
    mutual_unfollowed_you: number;
    reappeared: number;
  };
}

export interface RunCompareResult {
  fromRun: ScanRun;
  toRun: ScanRun;
  warning: string;
  counts: {
    added: number;
    missing: number;
    renamed: number;
    reappeared: number;
  };
  added: FollowerEvent[];
  missing: FollowerEvent[];
  renamed: FollowerEvent[];
  reappeared: FollowerEvent[];
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
  relationshipStatus: RelationshipStatus;
  relationshipObservedAt: string | null;
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
    mutualUnfollowedYouCount: number;
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
export type ScanJobPhase = 'idle' | 'starting' | 'authenticating' | 'waiting_for_verification' | 'scanning' | 'finalizing' | 'stopping' | 'completed' | 'failed' | 'interrupted';

export interface ScanJobAuthChallenge {
  kind: 'captcha' | 'login';
  status: 'waiting' | 'resolved' | 'timeout';
  startedAt: string;
  deadlineAt: string | null;
  message: string;
}

export interface ScanJobPartial {
  collectedAt: string | null;
  status: string;
  mode: string;
  requestedMode: string;
  reason: string;
  runtime: string;
  runtimeLabel: string;
  cookieAuth: CookieAuthStatus | null;
  pagesFetched: number;
  count: number;
  scanComplete: boolean | null;
  profileFollowerCount: number | null;
}

export interface ScanJobChangeSummary {
  newCount: number;
  suspectedRemovedCount: number;
  removedCount: number;
  mutualUnfollowedYouCount: number;
  reappearedCount: number;
  renamedCount: number;
  hiddenOrUnavailableCount?: number | null;
}

export interface CookieAuthStatus {
  configured: boolean;
  exportedAt: string | null;
  sourceUrl: string;
  cookieCount: number;
  acceptedCount: number;
  skippedCount: number;
  skippedReasons?: Array<{ reason: string; count: number }>;
  updatedAt: string | null;
  runtimeSupported: boolean;
  error?: string;
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
  cookieAuth: CookieAuthStatus | null;
  phase: ScanJobPhase;
  authChallenge: ScanJobAuthChallenge | null;
  exitCode: number | null;
  signal: string | null;
  error: string;
  logLines: string[];
  changeSummary: ScanJobChangeSummary | null;
  partial: ScanJobPartial | null;
}

export interface ScanConfigOption {
  value: string;
  label: string;
  detail: string;
}

export interface ScanConfig {
  runtime: string;
  runtimeLabel: string;
  mode: string;
  cdpUrl: string;
  cookieRuntimeSupported: boolean;
  canEdit: boolean;
  options: {
    runtimes: ScanConfigOption[];
    modes: ScanConfigOption[];
  };
}

export type RuntimeHealthLevel = 'ok' | 'warning' | 'action';
export type RuntimeHealthCheckState = 'pass' | 'warn' | 'fail' | 'info';

export interface RuntimeHealthCheck {
  id: string;
  label: string;
  state: RuntimeHealthCheckState;
  detail: string;
}

export interface RuntimeHealthStatus {
  runtime: string;
  runtimeLabel: string;
  level: RuntimeHealthLevel;
  headline: string;
  recommendation: string;
  recommendedRuntime: 'cdp' | 'playwright';
  checks: RuntimeHealthCheck[];
  commandHint?: string;
}
