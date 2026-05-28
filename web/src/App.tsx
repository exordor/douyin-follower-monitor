import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CheckCircle2,
  CircleDot,
  Clock3,
  Database,
  Download,
  ExternalLink,
  EyeOff,
  Filter,
  GitBranch,
  History,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  UserMinus,
  UserPlus,
  type LucideIcon
} from 'lucide-react';
import type { ReactNode } from 'react';

import { connectScanEvents, exportUrl, isDemoMode, loadEvents, loadFollowers, loadOverview, loadScanStatus, startScanJob, stopScanJob } from './api';
import { EventBars, StatusDonut, TrendChart } from './components/Charts';
import type { EventType, Follower, FollowerEvent, FollowerStatus, OverviewData, Page, ScanJobStatus, ScanRun } from './types';

const EVENT_LABELS: Record<EventType, string> = {
  new: '新增',
  seen: '出现',
  suspected_removed: '疑似取关',
  removed: '确认取关',
  reappeared: '重新出现',
  renamed: '昵称变化'
};

const STATUS_LABELS: Record<FollowerStatus, string> = {
  active: '活跃',
  suspected_removed: '疑似取关',
  removed: '确认取关'
};

const MODE_LABELS: Record<string, string> = {
  monitor: '自动',
  recent: '轻量',
  full: '全量'
};

const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = [20, 50, 100, 200, 500];
const ACTIVE_SCAN_STATUSES = new Set(['starting', 'running', 'stopping']);

function formatNumber(value: number | null | undefined) {
  if (!Number.isFinite(Number(value))) return '-';
  return Number(value).toLocaleString('zh-CN');
}

function formatDate(value: string | null | undefined) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function metricCards(data: OverviewData) {
  const { summary } = data;
  return [
    {
      label: '可枚举粉丝',
      value: summary.enumerableCount,
      detail: `主页显示 ${formatNumber(summary.profileFollowerCount)}`,
      icon: UserPlus,
      tone: 'teal'
    },
    {
      label: '新增',
      value: summary.lastChangeCounts.newCount,
      detail: summary.latestChange ? '最近一次变化' : '等待下一次扫描',
      icon: Sparkles,
      tone: 'green'
    },
    {
      label: '疑似取关',
      value: summary.lastChangeCounts.suspectedRemovedCount,
      detail: '仅 full 扫描判断',
      icon: UserMinus,
      tone: 'amber'
    },
    {
      label: '隐藏/不可用',
      value: summary.hiddenOrUnavailableCount,
      detail: '主页数 - 可枚举数',
      icon: EyeOff,
      tone: 'rose'
    }
  ];
}

function App() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [followers, setFollowers] = useState<Page<Follower> | null>(null);
  const [events, setEvents] = useState<Page<FollowerEvent> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [followerStatus, setFollowerStatus] = useState('');
  const [followerQuery, setFollowerQuery] = useState('');
  const [followerLimit, setFollowerLimit] = useState(DEFAULT_PAGE_SIZE);
  const [followerOffset, setFollowerOffset] = useState(0);
  const [eventType, setEventType] = useState('');
  const [eventQuery, setEventQuery] = useState('');
  const [eventLimit, setEventLimit] = useState(DEFAULT_PAGE_SIZE);
  const [eventOffset, setEventOffset] = useState(0);
  const [scanStatus, setScanStatus] = useState<ScanJobStatus | null>(null);
  const [scanActionError, setScanActionError] = useState('');
  const [scanBusy, setScanBusy] = useState(false);
  const previousScanStateRef = useRef('');
  const refreshAfterScanRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadOverview()
      .then((overview) => {
        if (!alive) return;
        setData(overview);
        setFollowers(overview.followers);
        setEvents(overview.events);
        setError('');
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    loadFollowers({ status: followerStatus, q: followerQuery, limit: followerLimit, offset: followerOffset })
      .then((page) => {
        if (alive) setFollowers(page);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [followerStatus, followerQuery, followerLimit, followerOffset]);

  useEffect(() => {
    let alive = true;
    loadEvents({ type: eventType, q: eventQuery, limit: eventLimit, offset: eventOffset })
      .then((page) => {
        if (alive) setEvents(page);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [eventType, eventQuery, eventLimit, eventOffset]);

  const refreshAfterScan = useCallback(async () => {
    const [overview, followerPage, eventPage] = await Promise.all([
      loadOverview(),
      loadFollowers({ status: followerStatus, q: followerQuery, limit: followerLimit, offset: followerOffset }),
      loadEvents({ type: eventType, q: eventQuery, limit: eventLimit, offset: eventOffset })
    ]);
    setData(overview);
    setFollowers(followerPage);
    setEvents(eventPage);
  }, [eventLimit, eventOffset, eventQuery, eventType, followerLimit, followerOffset, followerQuery, followerStatus]);

  useEffect(() => {
    refreshAfterScanRef.current = refreshAfterScan;
  }, [refreshAfterScan]);

  useEffect(() => {
    if (isDemoMode) {
      loadScanStatus().then(setScanStatus).catch(() => {});
      return undefined;
    }

    let alive = true;
    loadScanStatus()
      .then((status) => {
        if (!alive) return;
        previousScanStateRef.current = status.status;
        setScanStatus(status);
      })
      .catch((err) => {
        if (alive) setScanActionError(err instanceof Error ? err.message : String(err));
      });

    const disconnect = connectScanEvents((status) => {
      if (!alive) return;
      const previous = previousScanStateRef.current;
      const wasActive = ACTIVE_SCAN_STATUSES.has(previous);
      const isFinished = ['completed', 'failed', 'interrupted'].includes(status.status);
      previousScanStateRef.current = status.status;
      setScanStatus(status);
      setScanActionError('');
      if (wasActive && isFinished) {
        refreshAfterScanRef.current().catch((err) => setScanActionError(err instanceof Error ? err.message : String(err)));
      }
    }, () => {
      if (alive) setScanActionError('实时采集连接已断开，页面会继续显示最后一次状态。');
    });

    return () => {
      alive = false;
      disconnect();
    };
  }, []);

  const handleScanAction = async () => {
    if (isDemoMode) return;
    setScanBusy(true);
    setScanActionError('');
    try {
      const running = scanStatus && ACTIVE_SCAN_STATUSES.has(scanStatus.status);
      const result = running ? await stopScanJob() : await startScanJob();
      previousScanStateRef.current = result.status.status;
      setScanStatus(result.status);
    } catch (err) {
      setScanActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanBusy(false);
    }
  };

  const cards = useMemo(() => (data ? metricCards(data) : []), [data]);
  const scanRunning = Boolean(scanStatus && ACTIVE_SCAN_STATUSES.has(scanStatus.status));

  if (loading) {
    return (
      <div className="loading-screen">
        <RefreshCw className="spin" size={28} />
        <span>正在读取本机粉丝变化数据...</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="loading-screen error-screen">
        <AlertTriangle size={30} />
        <strong>Dashboard 启动失败</strong>
        <span>{error}</span>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">DF</div>
          <div>
            <strong>Douyin Monitor</strong>
            <span>Local-first ledger</span>
          </div>
        </div>
        <nav className="nav">
          <a className="nav-item active" href="#overview"><BarChart3 size={18} />总览</a>
          <a className="nav-item" href="#events"><History size={18} />事件</a>
          <a className="nav-item" href="#followers"><CircleDot size={18} />粉丝</a>
          <a className="nav-item" href="#runs"><GitBranch size={18} />扫描</a>
        </nav>
        <div className="local-card">
          <ShieldCheck size={20} />
          <strong>本地控制</strong>
          <span>{isDemoMode ? '当前是公开演示数据。' : '采集与数据都留在本机。'}</span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>粉丝变化仪表盘</h1>
            <p>发现谁取关了你，本地留存可枚举粉丝变化账本。</p>
          </div>
          <div className="top-actions">
            <a className={`button ghost ${isDemoMode ? 'disabled' : ''}`} href={exportUrl('latest.json')}>
              <Download size={16} /> JSON
            </a>
            <a className={`button ghost ${isDemoMode ? 'disabled' : ''}`} href={exportUrl('latest.csv')}>
              <Download size={16} /> CSV
            </a>
            <button className={`button primary ${scanRunning ? 'danger' : ''}`} type="button" onClick={handleScanAction} disabled={isDemoMode || scanBusy}>
              {scanRunning ? <Square size={16} /> : <Play size={16} />}
              {scanRunning ? '中止采集' : '启动采集'}
            </button>
          </div>
        </header>

        {!data.summary.hasDatabase && (
          <section className="notice warning">
            <AlertTriangle size={18} />
            <span>尚未找到 SQLite 基线。先运行 <code>npm run monitor:doubao</code> 生成本地数据。</span>
          </section>
        )}

        <section className="notice">
          <Database size={18} />
          <span>只统计当前账号可枚举的粉丝列表；隐藏或不可用账号只作为数量差值展示，不尝试补全。</span>
        </section>

        <ScanControlPanel
          status={scanStatus}
          error={scanActionError}
          isDemo={isDemoMode}
          running={scanRunning}
          busy={scanBusy}
          onAction={handleScanAction}
        />

        <section className="metrics" id="overview">
          {cards.map((card) => {
            const Icon = card.icon;
            return (
              <article className={`metric metric-${card.tone}`} key={card.label}>
                <div className="metric-icon"><Icon size={20} /></div>
                <span>{card.label}</span>
                <strong>{formatNumber(card.value)}</strong>
                <small>{card.detail}</small>
              </article>
            );
          })}
        </section>

        <section className="dashboard-grid">
          <article className="panel wide">
            <PanelHeader icon={Activity} title="粉丝趋势" subtitle="主页粉丝数与可枚举列表同步展示" />
            <TrendChart data={data.timeline} />
            <div className="legend-inline">
              <span><i className="line teal" />可枚举粉丝</span>
              <span><i className="line rose" />主页粉丝数</span>
            </div>
          </article>

          <article className="panel">
            <PanelHeader icon={CircleDot} title="状态分布" subtitle="两次 full 缺失后确认取关" />
            <StatusDonut counts={data.summary.statusCounts} />
          </article>

          <article className="panel wide">
            <PanelHeader icon={History} title="事件节奏" subtitle="新增、改名、取关状态按日期聚合" />
            <EventBars data={data.eventDaily} />
            <EventLegend />
          </article>

          <article className="panel">
            <PanelHeader icon={Clock3} title="最近扫描" subtitle="monitor 自动决策结果" />
            <RunSummary run={data.summary.latestRun} />
          </article>
        </section>

        <section className="tables">
          <article className="panel table-panel" id="events">
            <TableHeader
              icon={History}
              title="粉丝事件"
              count={events?.total || 0}
              controls={(
                <>
                  <select
                    value={eventType}
                    onChange={(event) => {
                      setEventType(event.target.value);
                      setEventOffset(0);
                    }}
                  >
                    <option value="">全部事件</option>
                    {Object.entries(EVENT_LABELS).map(([value, label]) => (
                      <option value={value} key={value}>{label}</option>
                    ))}
                  </select>
                  <SearchBox
                    value={eventQuery}
                    onChange={(value) => {
                      setEventQuery(value);
                      setEventOffset(0);
                    }}
                    placeholder="搜索昵称或 ID"
                  />
                </>
              )}
            />
            <EventsTable events={events?.rows || []} />
            <PaginationBar
              page={events}
              pageSize={eventLimit}
              onOffsetChange={setEventOffset}
              onPageSizeChange={(value) => {
                setEventLimit(value);
                setEventOffset(0);
              }}
            />
          </article>

          <article className="panel table-panel" id="followers">
            <TableHeader
              icon={CircleDot}
              title="粉丝列表"
              count={followers?.total || 0}
              controls={(
                <>
                  <select
                    value={followerStatus}
                    onChange={(event) => {
                      setFollowerStatus(event.target.value);
                      setFollowerOffset(0);
                    }}
                  >
                    <option value="">全部状态</option>
                    {Object.entries(STATUS_LABELS).map(([value, label]) => (
                      <option value={value} key={value}>{label}</option>
                    ))}
                  </select>
                  <SearchBox
                    value={followerQuery}
                    onChange={(value) => {
                      setFollowerQuery(value);
                      setFollowerOffset(0);
                    }}
                    placeholder="搜索昵称 / uid"
                  />
                </>
              )}
            />
            <FollowersTable followers={followers?.rows || []} />
            <PaginationBar
              page={followers}
              pageSize={followerLimit}
              onOffsetChange={setFollowerOffset}
              onPageSizeChange={(value) => {
                setFollowerLimit(value);
                setFollowerOffset(0);
              }}
            />
          </article>
        </section>

        <section className="panel runs-panel" id="runs">
          <PanelHeader icon={GitBranch} title="扫描运行记录" subtitle="recent/full/monitor 的最近执行状态" />
          <RunsTable runs={data.runs} />
        </section>
      </main>
    </div>
  );
}

function PanelHeader({ icon: Icon, title, subtitle }: { icon: LucideIcon; title: string; subtitle: string }) {
  return (
    <div className="panel-header">
      <div className="panel-icon"><Icon size={18} /></div>
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}

function ScanControlPanel({
  status,
  error,
  isDemo,
  running,
  busy,
  onAction
}: {
  status: ScanJobStatus | null;
  error: string;
  isDemo: boolean;
  running: boolean;
  busy: boolean;
  onAction: () => void;
}) {
  const hasStatus = Boolean(status);
  const logs = status?.logLines.slice(-8) || [];
  const change = status?.changeSummary;
  const partialText = status?.partial
    ? `${formatDate(status.partial.collectedAt)} 保存 ${formatNumber(status.partial.count)} 条`
    : '等待采集进度';

  return (
    <section className={`panel scan-panel ${running ? 'active' : ''}`}>
      <div className="scan-panel-header">
        <PanelHeader
          icon={RefreshCw}
          title="采集控制"
          subtitle={isDemo ? '公开演示不连接本地浏览器' : '默认使用 monitor 自动决策 recent/full'}
        />
        <button className={`button primary ${running ? 'danger' : ''}`} type="button" onClick={onAction} disabled={isDemo || busy}>
          {running ? <Square size={16} /> : <Play size={16} />}
          {running ? '中止采集' : '启动采集'}
        </button>
      </div>

      {error && (
        <div className="scan-error">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}

      <div className="scan-grid">
        <div><span>状态</span><strong>{hasStatus ? <StatusPill value={status!.status} /> : '-'}</strong></div>
        <div><span>模式</span><strong>{MODE_LABELS[status?.mode || 'monitor'] || status?.mode || '自动'}</strong></div>
        <div><span>原因</span><strong>{status?.reason || '-'}</strong></div>
        <div><span>页面</span><strong>{formatNumber(status?.pagesFetched || 0)}</strong></div>
        <div><span>累计</span><strong>{formatNumber(status?.count || 0)}</strong></div>
        <div><span>主页粉丝</span><strong>{formatNumber(status?.profileFollowerCount)}</strong></div>
        <div><span>Partial</span><strong>{partialText}</strong></div>
        <div><span>结束</span><strong>{formatDate(status?.finishedAt)}</strong></div>
      </div>

      {change && (
        <div className="scan-summary">
          <span>完成摘要</span>
          <strong>新增 {formatNumber(change.newCount)} · 疑似 {formatNumber(change.suspectedRemovedCount)} · 确认 {formatNumber(change.removedCount)} · 改名 {formatNumber(change.renamedCount)} · 隐藏差值 {formatNumber(change.hiddenOrUnavailableCount)}</strong>
        </div>
      )}

      <div className="log-tail" aria-label="采集日志">
        {logs.length ? logs.map((line, index) => <code key={`${line}-${index}`}>{line}</code>) : <code>{isDemo ? 'Demo 模式不运行本地采集。' : '点击“启动采集”后这里会显示实时进度。'}</code>}
      </div>
    </section>
  );
}

function PaginationBar<T>({
  page,
  pageSize,
  onOffsetChange,
  onPageSizeChange
}: {
  page: Page<T> | null;
  pageSize: number;
  onOffsetChange: (offset: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  if (!page) return null;

  const total = page.total;
  const shown = page.rows.length;
  const start = total === 0 ? 0 : page.offset + 1;
  const end = total === 0 ? 0 : Math.min(page.offset + shown, total);
  const lastOffset = total === 0 ? 0 : Math.floor((total - 1) / page.limit) * page.limit;
  const canPrev = page.offset > 0;
  const canNext = end < total;
  const allLimit = Math.min(total || DEFAULT_PAGE_SIZE, 5000);

  return (
    <div className="pagination-bar">
      <span className="page-range">
        当前显示 {formatNumber(start)}-{formatNumber(end)} / 共 {formatNumber(total)} 条
      </span>
      <div className="pagination-controls">
        <label className="page-size">
          每页
          <select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}>
            {PAGE_SIZE_OPTIONS.map((value) => (
              <option value={value} key={value}>{value}</option>
            ))}
            {!PAGE_SIZE_OPTIONS.includes(pageSize) && (
              <option value={pageSize}>{pageSize}</option>
            )}
          </select>
        </label>
        <button className="button compact" type="button" disabled={shown >= total} onClick={() => onPageSizeChange(allLimit)}>
          显示全部
        </button>
        <button className="icon-button" type="button" disabled={!canPrev} onClick={() => onOffsetChange(0)} aria-label="第一页" title="第一页">
          <ChevronsLeft size={16} />
        </button>
        <button className="icon-button" type="button" disabled={!canPrev} onClick={() => onOffsetChange(Math.max(0, page.offset - page.limit))} aria-label="上一页" title="上一页">
          <ChevronLeft size={16} />
        </button>
        <button className="icon-button" type="button" disabled={!canNext} onClick={() => onOffsetChange(Math.min(lastOffset, page.offset + page.limit))} aria-label="下一页" title="下一页">
          <ChevronRight size={16} />
        </button>
        <button className="icon-button" type="button" disabled={!canNext} onClick={() => onOffsetChange(lastOffset)} aria-label="最后一页" title="最后一页">
          <ChevronsRight size={16} />
        </button>
      </div>
    </div>
  );
}

function TableHeader({
  icon,
  title,
  count,
  controls
}: {
  icon: typeof Activity;
  title: string;
  count: number;
  controls: ReactNode;
}) {
  return (
    <div className="table-header">
      <PanelHeader icon={icon} title={title} subtitle={`${formatNumber(count)} 条记录`} />
      <div className="table-controls">
        <Filter size={16} />
        {controls}
      </div>
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="search-box">
      <Search size={16} />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  );
}

function EventLegend() {
  const items = [
    ['新增', 'teal'],
    ['重新出现', 'green'],
    ['昵称变化', 'muted'],
    ['疑似取关', 'amber'],
    ['确认取关', 'rose']
  ];
  return (
    <div className="legend-inline">
      {items.map(([label, tone]) => <span key={label}><i className={`dot ${tone}`} />{label}</span>)}
    </div>
  );
}

function RunSummary({ run }: { run: ScanRun | null }) {
  if (!run) return <div className="empty-state">暂无扫描记录</div>;
  return (
    <div className="run-summary">
      <div className="run-mode">
        <strong>{MODE_LABELS[run.mode] || run.mode}</strong>
        <span>{run.reason || 'no-reason'}</span>
      </div>
      <dl>
        <div><dt>状态</dt><dd><StatusPill value={run.status} /></dd></div>
        <div><dt>页面</dt><dd>{formatNumber(run.pagesFetched)}</dd></div>
        <div><dt>开始</dt><dd>{formatDate(run.startedAt)}</dd></div>
        <div><dt>结束</dt><dd>{formatDate(run.finishedAt)}</dd></div>
      </dl>
    </div>
  );
}

function StatusPill({ value }: { value: string }) {
  const tone = value === 'completed' ? 'green' : value === 'failed' ? 'rose' : value === 'interrupted' ? 'amber' : 'muted';
  return <span className={`pill ${tone}`}>{value}</span>;
}

function FollowerStatusPill({ value }: { value: FollowerStatus }) {
  const tone = value === 'active' ? 'green' : value === 'suspected_removed' ? 'amber' : 'rose';
  return <span className={`pill ${tone}`}>{STATUS_LABELS[value]}</span>;
}

function EventTypePill({ value }: { value: EventType }) {
  const tone = value === 'new' ? 'teal' : value === 'removed' ? 'rose' : value === 'suspected_removed' ? 'amber' : value === 'reappeared' ? 'green' : 'muted';
  return <span className={`pill ${tone}`}>{EVENT_LABELS[value] || value}</span>;
}

function EventsTable({ events }: { events: FollowerEvent[] }) {
  if (!events.length) return <div className="empty-state">没有匹配的事件</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>事件</th>
            <th>账号</th>
            <th>时间</th>
            <th>Run</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.eventId}>
              <td><EventTypePill value={event.type} /></td>
              <td>
                <a className="table-link" href={event.profileUrl || '#'} target="_blank" rel="noreferrer">
                  {event.nickname || event.followerId}
                  <ExternalLink size={13} />
                </a>
              </td>
              <td>{formatDate(event.createdAt)}</td>
              <td><code>{event.runId}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FollowersTable({ followers }: { followers: Follower[] }) {
  if (!followers.length) return <div className="empty-state">没有匹配的粉丝</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>昵称</th>
            <th>状态</th>
            <th>首次出现</th>
            <th>最近出现</th>
            <th>Full 缺失</th>
          </tr>
        </thead>
        <tbody>
          {followers.map((follower) => (
            <tr key={follower.id}>
              <td>
                <a className="table-link" href={follower.profileUrl} target="_blank" rel="noreferrer">
                  {follower.nickname}
                  <ExternalLink size={13} />
                </a>
                <span className="sub-id">{follower.uid || follower.id}</span>
              </td>
              <td><FollowerStatusPill value={follower.status} /></td>
              <td>{formatDate(follower.firstSeenAt)}</td>
              <td>{formatDate(follower.lastSeenAt)}</td>
              <td>{formatNumber(follower.missingFullScans || 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunsTable({ runs }: { runs: ScanRun[] }) {
  if (!runs.length) return <div className="empty-state">暂无扫描运行记录</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>模式</th>
            <th>状态</th>
            <th>主页 / 可枚举</th>
            <th>页面</th>
            <th>原因</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.runId}>
              <td><code>{run.runId}</code><span className="sub-id">{formatDate(run.startedAt)}</span></td>
              <td>{MODE_LABELS[run.mode] || run.mode}</td>
              <td><StatusPill value={run.status} /></td>
              <td>{formatNumber(run.profileFollowerCount)} / {formatNumber(run.enumerableCount)}</td>
              <td>{formatNumber(run.pagesFetched)}</td>
              <td>{run.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default App;
