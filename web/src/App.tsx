import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
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
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  UserMinus,
  UserPlus,
  type LucideIcon
} from 'lucide-react';
import type { ReactNode } from 'react';

import { exportUrl, isDemoMode, loadEvents, loadFollowers, loadOverview } from './api';
import { EventBars, StatusDonut, TrendChart } from './components/Charts';
import type { EventType, Follower, FollowerEvent, FollowerStatus, OverviewData, Page, ScanRun } from './types';

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
  const [eventType, setEventType] = useState('');
  const [eventQuery, setEventQuery] = useState('');

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
    loadFollowers({ status: followerStatus, q: followerQuery, limit: 20 })
      .then((page) => {
        if (alive) setFollowers(page);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [followerStatus, followerQuery]);

  useEffect(() => {
    let alive = true;
    loadEvents({ type: eventType, q: eventQuery, limit: 20 })
      .then((page) => {
        if (alive) setEvents(page);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [eventType, eventQuery]);

  const cards = useMemo(() => (data ? metricCards(data) : []), [data]);

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
          <strong>本地只读</strong>
          <span>{isDemoMode ? '当前是公开演示数据。' : '数据仅来自本机 SQLite。'}</span>
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
            <code className="command"><Terminal size={16} />npm run monitor:doubao</code>
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
                  <select value={eventType} onChange={(event) => setEventType(event.target.value)}>
                    <option value="">全部事件</option>
                    {Object.entries(EVENT_LABELS).map(([value, label]) => (
                      <option value={value} key={value}>{label}</option>
                    ))}
                  </select>
                  <SearchBox value={eventQuery} onChange={setEventQuery} placeholder="搜索昵称或 ID" />
                </>
              )}
            />
            <EventsTable events={events?.rows || []} />
          </article>

          <article className="panel table-panel" id="followers">
            <TableHeader
              icon={CircleDot}
              title="粉丝列表"
              count={followers?.total || 0}
              controls={(
                <>
                  <select value={followerStatus} onChange={(event) => setFollowerStatus(event.target.value)}>
                    <option value="">全部状态</option>
                    {Object.entries(STATUS_LABELS).map(([value, label]) => (
                      <option value={value} key={value}>{label}</option>
                    ))}
                  </select>
                  <SearchBox value={followerQuery} onChange={setFollowerQuery} placeholder="搜索昵称 / uid" />
                </>
              )}
            />
            <FollowersTable followers={followers?.rows || []} />
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
