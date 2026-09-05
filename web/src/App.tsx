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
  Copy,
  Database,
  Download,
  ExternalLink,
  EyeOff,
  Filter,
  GitBranch,
  History,
  KeyRound,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
  UserMinus,
  UserPlus,
  type LucideIcon
} from 'lucide-react';
import type { ChangeEvent, ReactNode } from 'react';

import { clearCookieAuth, connectScanEvents, exportUrl, importCookieAuth, isDemoMode, loadCookieAuthStatus, loadEvents, loadFollowers, loadOverview, loadRunCompare, loadRunDetail, loadRunEvents, loadRuntimeHealth, loadScanConfig, loadScanStatus, openCdpBrowser, startScanJob, stopScanJob, updateScanConfig } from './api';
import { EventBars, StatusDonut, TrendChart } from './components/Charts';
import type { CookieAuthStatus, EventType, Follower, FollowerEvent, FollowerStatus, OverviewData, Page, RelationshipStatus, RuntimeHealthStatus, RunCompareResult, ScanConfig, ScanJobStatus, ScanRun, ScanRunDetail } from './types';

const EVENT_LABELS: Record<EventType, string> = {
  new: '新增',
  seen: '出现',
  suspected_removed: '疑似取关',
  removed: '确认取关',
  mutual_unfollowed_you: '互关后取关我',
  reappeared: '重新出现',
  renamed: '昵称变化'
};

const STATUS_LABELS: Record<FollowerStatus, string> = {
  active: '活跃',
  suspected_removed: '疑似取关',
  removed: '确认取关'
};

const RELATIONSHIP_LABELS: Record<RelationshipStatus, string> = {
  unknown: '未知',
  mutual: '互关',
  follower_only: '仅关注我'
};

const MODE_LABELS: Record<string, string> = {
  monitor: '自动',
  recent: '轻量',
  full: '全量'
};

const PHASE_LABELS: Record<string, string> = {
  idle: '空闲',
  starting: '启动中',
  authenticating: '准备登录态',
  waiting_for_verification: '等待验证',
  scanning: '采集中',
  finalizing: '收尾保存',
  stopping: '中止中',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断'
};

const RUNTIME_LABELS: Record<string, string> = {
  cdp: 'CDP',
  playwright: 'Playwright',
  demo: 'Demo'
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

function formatRemaining(deadlineAt: string | null | undefined, now: number) {
  if (!deadlineAt) return '-';
  const remaining = Math.max(0, Date.parse(deadlineAt) - now);
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function healthWithScanStatus(health: RuntimeHealthStatus, status: ScanJobStatus): RuntimeHealthStatus {
  const isWaiting = status.phase === 'waiting_for_verification' && status.authChallenge?.status === 'waiting';
  const checks = health.checks.map((item) => {
    if (item.id !== 'verification') return item;
    return {
      ...item,
      state: isWaiting ? 'fail' : item.state,
      detail: isWaiting ? '请在采集浏览器中人工完成，完成后任务会继续。' : item.detail
    };
  });
  if (!isWaiting) return { ...health, runtime: status.runtime || health.runtime, runtimeLabel: status.runtimeLabel || health.runtimeLabel, checks };
  return {
    ...health,
    runtime: status.runtime || health.runtime,
    runtimeLabel: status.runtimeLabel || health.runtimeLabel,
    level: 'action',
    headline: status.authChallenge?.kind === 'login' ? '等待人工登录' : '等待人工验证',
    recommendation: '请在采集浏览器中完成登录或验证码。若频繁出现，建议改用 CDP 复用已登录浏览器会话。',
    recommendedRuntime: 'cdp',
    checks
  };
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
      label: '互关后取关我',
      value: summary.lastChangeCounts.mutualUnfollowedYouCount,
      detail: '两次完整缺失后确认',
      icon: UserMinus,
      tone: 'rose'
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

const VIEWS = {
  overview: { title: '概览', description: '先看关系变化，再看整体趋势。', icon: BarChart3 },
  events: { title: '关系事件', description: '专注谁离开了，以及这个结论是如何确认的。', icon: History },
  followers: { title: '粉丝列表', description: '搜索账号与查看当前记录，不与事件历史混在一起。', icon: CircleDot },
  settings: { title: '采集设置', description: '连接方式、采集记录和诊断集中管理。', icon: ShieldCheck }
};
type View = keyof typeof VIEWS;
function currentView(): View {
  const hash = window.location.hash.slice(1);
  if (hash === 'setup' || hash === 'runs') return 'settings';
  return Object.hasOwn(VIEWS, hash) ? hash as View : 'overview';
}

function App() {
  const [view, setView] = useState<View>(currentView);
  useEffect(() => {
    const navigate = () => { setView(currentView()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  const [data, setData] = useState<OverviewData | null>(null);
  const [followers, setFollowers] = useState<Page<Follower> | null>(null);
  const [events, setEvents] = useState<Page<FollowerEvent> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [followerStatus, setFollowerStatus] = useState('');
  const [followerQuery, setFollowerQuery] = useState('');
  const [followerLimit, setFollowerLimit] = useState(DEFAULT_PAGE_SIZE);
  const [followerOffset, setFollowerOffset] = useState(0);
  const [eventType, setEventType] = useState('mutual_unfollowed_you');
  const [eventQuery, setEventQuery] = useState('');
  const [eventLimit, setEventLimit] = useState(DEFAULT_PAGE_SIZE);
  const [eventOffset, setEventOffset] = useState(0);
  const [scanStatus, setScanStatus] = useState<ScanJobStatus | null>(null);
  const [scanActionError, setScanActionError] = useState('');
  const [scanBusy, setScanBusy] = useState(false);
  const [cookieAuth, setCookieAuth] = useState<CookieAuthStatus | null>(null);
  const [cookieError, setCookieError] = useState('');
  const [cookieBusy, setCookieBusy] = useState(false);
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealthStatus | null>(null);
  const [scanConfig, setScanConfig] = useState<ScanConfig | null>(null);
  const [scanConfigError, setScanConfigError] = useState('');
  const [scanConfigBusy, setScanConfigBusy] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [runDetail, setRunDetail] = useState<ScanRunDetail | null>(null);
  const [runEvents, setRunEvents] = useState<Page<FollowerEvent> | null>(null);
  const [runError, setRunError] = useState('');
  const [compareFrom, setCompareFrom] = useState('');
  const [compareTo, setCompareTo] = useState('');
  const [compareResult, setCompareResult] = useState<RunCompareResult | null>(null);
  const [compareError, setCompareError] = useState('');
  const [compareBusy, setCompareBusy] = useState(false);
  const previousScanStateRef = useRef('');
  const refreshAfterScanRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadOverview()
      .then((overview) => {
        if (!alive) return;
        setData(overview);
        setSelectedRunId((current) => current || overview.runs[0]?.runId || '');
        setCompareFrom((current) => current || overview.runs[1]?.runId || overview.runs[0]?.runId || '');
        setCompareTo((current) => current || overview.runs[0]?.runId || '');
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
    if (!selectedRunId) {
      setRunDetail(null);
      setRunEvents(null);
      return undefined;
    }
    let alive = true;
    Promise.all([
      loadRunDetail(selectedRunId),
      loadRunEvents(selectedRunId, { limit: 20, offset: 0 })
    ])
      .then(([detail, page]) => {
        if (!alive) return;
        setRunDetail(detail);
        setRunEvents(page);
        setRunError('');
      })
      .catch((err) => {
        if (alive) setRunError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [selectedRunId]);

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
      Promise.all([loadScanStatus(), loadRuntimeHealth(), loadScanConfig()]).then(([status, health, config]) => {
        setScanStatus(status);
        setCookieAuth(status.cookieAuth);
        setRuntimeHealth(health);
        setScanConfig(config);
      }).catch(() => {});
      return undefined;
    }

    let alive = true;
    Promise.all([loadScanStatus(), loadCookieAuthStatus(), loadRuntimeHealth(), loadScanConfig()])
      .then(([status, authStatus, health, config]) => {
        if (!alive) return;
        previousScanStateRef.current = status.status;
        setScanStatus(status);
        setCookieAuth(authStatus);
        setRuntimeHealth(health);
        setScanConfig(config);
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
      if (status.cookieAuth) setCookieAuth(status.cookieAuth);
      setRuntimeHealth((current) => current ? healthWithScanStatus(current, status) : current);
      setScanActionError('');
      if (wasActive && isFinished) {
        Promise.all([
          refreshAfterScanRef.current(),
          loadRuntimeHealth().then(setRuntimeHealth),
          loadScanConfig().then(setScanConfig)
        ])
          .catch((err) => setScanActionError(err instanceof Error ? err.message : String(err)));
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
      setRuntimeHealth((current) => current ? healthWithScanStatus(current, result.status) : current);
      Promise.all([
        loadRuntimeHealth().then(setRuntimeHealth),
        loadScanConfig().then(setScanConfig)
      ]).catch(() => {});
    } catch (err) {
      setScanActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanBusy(false);
    }
  };

  const handleScanConfigChange = async (patch: Partial<Pick<ScanConfig, 'runtime' | 'mode' | 'cdpUrl'>>) => {
    if (isDemoMode) return;
    setScanConfigBusy(true);
    setScanConfigError('');
    try {
      const result = await updateScanConfig(patch);
      setScanConfig(result.config);
      setScanStatus(result.status);
      const [authStatus, health] = await Promise.all([
        loadCookieAuthStatus(),
        loadRuntimeHealth()
      ]);
      setCookieAuth(authStatus);
      setRuntimeHealth(health);
    } catch (err) {
      setScanConfigError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanConfigBusy(false);
    }
  };

  const handleCookieImport = async (file: File) => {
    if (isDemoMode) return;
    setCookieBusy(true);
    setCookieError('');
    try {
      const content = await file.text();
      const status = await importCookieAuth(file.name, content);
      setCookieAuth(status);
      setScanStatus((current) => current ? { ...current, cookieAuth: status } : current);
      await loadRuntimeHealth().then(setRuntimeHealth);
    } catch (err) {
      setCookieError(err instanceof Error ? err.message : String(err));
    } finally {
      setCookieBusy(false);
    }
  };

  const handleCookieClear = async () => {
    if (isDemoMode) return;
    setCookieBusy(true);
    setCookieError('');
    try {
      const status = await clearCookieAuth();
      setCookieAuth(status);
      setScanStatus((current) => current ? { ...current, cookieAuth: status } : current);
      await loadRuntimeHealth().then(setRuntimeHealth);
    } catch (err) {
      setCookieError(err instanceof Error ? err.message : String(err));
    } finally {
      setCookieBusy(false);
    }
  };

  const handleCompareRuns = async () => {
    if (!compareFrom || !compareTo) return;
    setCompareBusy(true);
    setCompareError('');
    try {
      const result = await loadRunCompare(compareFrom, compareTo);
      setCompareResult(result);
    } catch (err) {
      setCompareError(err instanceof Error ? err.message : String(err));
    } finally {
      setCompareBusy(false);
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
            <strong>FOLLOW / 关系观察</strong>
            <span>抖音粉丝监控</span>
          </div>
        </div>
        <nav className="nav" aria-label="主导航">
          {Object.entries(VIEWS).map(([key, item]) => (
            <a key={key} className={`nav-item ${view === key ? 'active' : ''}`} href={`#${key}`} aria-current={view === key ? 'page' : undefined}><item.icon size={18} />{item.title}</a>
          ))}
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
            <h1>{VIEWS[view].title}</h1>
            <p>{VIEWS[view].description}</p>
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

        {error && <div role="alert" className="notice warning">数据更新失败：{error}。当前保留上次结果，请刷新重试。</div>}
        {scanActionError && view !== 'settings' && <div role="alert" className="notice warning">{scanActionError}</div>}
        {view !== 'settings' && scanStatus && (scanRunning || scanStatus.status === 'failed') && (
          <a className="notice scan-global-status" href="#settings" role="status">
            <Activity size={18} /><span>{PHASE_LABELS[scanStatus.phase] || scanStatus.status} · 已采集 {scanStatus.count} 位 · 查看进度与处理提示 →</span>
          </a>
        )}
        {!data.summary.hasDatabase && (
          <section className="notice warning">
            <AlertTriangle size={18} />
            <span>尚未找到 SQLite 基线。先运行 <code>npm run monitor</code> 生成本地数据。</span>
          </section>
        )}

        {view === 'overview' && <section className="notice">
          <Database size={18} />
          <span>只统计当前账号可枚举的粉丝列表；隐藏或不可用账号只作为数量差值展示，不尝试补全。</span>
        </section>}

        {view === 'settings' && <>
        <section className="mobile-only mobile-settings">
          <article className="mobile-record connection-summary"><strong>{scanStatus?.runtimeLabel || '采集连接'}</strong><p>{PHASE_LABELS[scanStatus?.phase || 'idle'] || '空闲'} · {MODE_LABELS[scanConfig?.mode || 'monitor']}</p><small>采集在电脑执行，手机侧查看状态。</small></article>
          <article className="mobile-record"><strong>登录状态 · {cookieAuth?.configured ? 'Cookie 已配置' : '未配置 Cookie'}</strong><p>复用固定浏览器配置，失效时在电脑更新。</p><small>启动浏览器、导入 Cookie 和人工验证请在电脑完成。</small></article>
          {scanStatus?.authChallenge?.status === 'waiting' && <article className="mobile-record"><strong>等待电脑端验证</strong><p>{scanStatus.authChallenge.message}</p></article>}
          <p className="page-explanation">手机访问需另行配置安全连接；本次改版不开放本机服务或 CDP 端口。</p>
        </section>
        <div className="desktop-collection">
        <details className="connection-help">
          <summary>连接帮助与首次设置</summary>
        <SetupPanel
          summary={data.summary}
          runs={data.runs}
          runtimeHealth={runtimeHealth}
          cookieAuth={cookieAuth}
          scanStatus={scanStatus}
          isDemo={isDemoMode}
        />
        </details>

        <ScanControlPanel
          status={scanStatus}
          error={scanActionError}
          config={scanConfig}
          configError={scanConfigError}
          configBusy={scanConfigBusy}
          cookieAuth={cookieAuth}
          runtimeHealth={runtimeHealth}
          cookieError={cookieError}
          cookieBusy={cookieBusy}
          isDemo={isDemoMode}
          running={scanRunning}
          busy={scanBusy}
          onAction={handleScanAction}
          onConfigChange={handleScanConfigChange}
          onCookieImport={handleCookieImport}
          onCookieClear={handleCookieClear}
        />
        </div>
        </>}

        {view === 'overview' && <>
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

        <a className="relationship-callout" href="#events" onClick={() => { setEventType('mutual_unfollowed_you'); setEventQuery(''); setEventOffset(0); }}>
          <UserMinus size={22} /><div><strong>优先查看：互关后取关我</strong><p>查看历史互关证据及确认事件。旧记录关系未知时，不回溯推断互关。</p></div><ChevronRight size={20} />
        </a>
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
        </>}

        {(view === 'events' || view === 'followers') &&
        <section className="tables">
          {view === 'events' && <>
          <div className="event-shortcuts" aria-label="常用事件筛选">
            {[['mutual_unfollowed_you', '互关后取关我'], ['', '全部事件'], ['suspected_removed', '疑似取关']].map(([value, label]) => <button key={value} type="button" className={`button ${eventType === value ? 'primary' : 'ghost'}`} aria-pressed={eventType === value} onClick={() => { setEventType(value); setEventOffset(0); }}>{label}</button>)}
          </div>
          <p className="page-explanation">连续两次完整采集缺失后确认取关。检测时间不等于实际取关时间；历史关系未知不代表没有互关。</p>
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
            {!data.summary.latestRun && <div className="notice">尚无采集记录，请先到采集设置建立完整基线。</div>}
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
          </>}

          {view === 'followers' &&
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
          </article>}
        </section>}

        {view === 'settings' &&
        <section className="panel runs-panel" id="runs">
          <PanelHeader icon={GitBranch} title="扫描运行记录" subtitle="recent/full/monitor 的最近执行状态" />
          <RunsTable runs={data.runs} selectedRunId={selectedRunId} onSelectRun={setSelectedRunId} />
          <RunDetailPanel detail={runDetail} events={runEvents?.rows || []} error={runError} />
          <ComparePanel
            runs={data.runs}
            from={compareFrom}
            to={compareTo}
            result={compareResult}
            error={compareError}
            busy={compareBusy}
            onFromChange={setCompareFrom}
            onToChange={setCompareTo}
            onCompare={handleCompareRuns}
          />
        </section>}
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

function CopyCommandButton({ command, disabled = false }: { command: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);

  const copyCommand = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button className="button compact" type="button" onClick={copyCommand} disabled={disabled || !command}>
      <Copy size={15} />{copied ? '已复制' : '复制'}
    </button>
  );
}

function SetupPanel({
  summary,
  runs,
  runtimeHealth,
  cookieAuth,
  scanStatus,
  isDemo
}: {
  summary: OverviewData['summary'];
  runs: ScanRun[];
  runtimeHealth: RuntimeHealthStatus | null;
  cookieAuth: CookieAuthStatus | null;
  scanStatus: ScanJobStatus | null;
  isDemo: boolean;
}) {
  const hasFullBaseline = runs.some((run) => run.mode === 'full' && run.status === 'completed') || summary.latestCompletedRun?.mode === 'full';
  const latestRunOk = summary.latestRun?.status === 'completed';
  const cdpChromeCommand = '/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.douyin-cdp-profile"';
  const cdpDashboardCommand = 'DOUYIN_CDP_URL=http://127.0.0.1:9222 npm run dashboard';
  const monitorCommand = cookieAuth?.configured ? 'npm run monitor' : 'npm run doctor';
  const setupChecks = [
    { label: 'SQLite 数据库', value: summary.hasDatabase ? '已创建' : '未创建', state: summary.hasDatabase ? 'pass' : 'fail' },
    { label: 'Full 基线', value: hasFullBaseline ? '已完成' : '待建立', state: hasFullBaseline ? 'pass' : 'warn' },
    { label: '最近扫描', value: summary.latestRun ? (latestRunOk ? '成功' : summary.latestRun.status) : '暂无', state: latestRunOk ? 'pass' : 'warn' },
    { label: 'Cookie 登录态', value: cookieAuth?.configured ? `${formatNumber(cookieAuth.acceptedCount)} 可用` : '未配置', state: cookieAuth?.configured ? 'pass' : 'info' }
  ];

  return (
    <section className="panel setup-panel" id="setup">
      <PanelHeader
        icon={ShieldCheck}
        title="Setup / 快速开始"
        subtitle={isDemo ? '公开演示只展示 mock 配置路径' : '先跑 doctor，再选择稳定 runtime，最后建立 full 基线'}
      />

      <div className="setup-grid">
        <article className="setup-card recommended">
          <span>推荐路径</span>
          <strong>CDP 复用已登录浏览器</strong>
          <p>稳定性通常最好。保持 Chrome/Edge/Chromium 已登录，并让 dashboard 连接本机 DevTools 端口。</p>
          <div className="setup-command">
            <code>{runtimeHealth?.commandHint || cdpDashboardCommand}</code>
            <CopyCommandButton command={runtimeHealth?.commandHint || cdpDashboardCommand} disabled={isDemo} />
          </div>
        </article>

        <article className="setup-card">
          <span>备选路径</span>
          <strong>Playwright profile + Cookie</strong>
          <p>适合跨平台首次试用。Cookie 只能复用登录态，不能保证免验证码；触发验证时需要人工处理。</p>
          <div className="setup-command">
            <code>{monitorCommand}</code>
            <CopyCommandButton command={monitorCommand} disabled={isDemo} />
          </div>
        </article>

      </div>

      <div className="setup-checks">
        {setupChecks.map((item) => (
          <div className={`setup-check ${item.state}`} key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>

      <div className="setup-helper">
        <div>
          <span>Chrome CDP 启动命令</span>
          <code>{cdpChromeCommand}</code>
        </div>
        <CopyCommandButton command={cdpChromeCommand} disabled={isDemo} />
      </div>

      <div className="setup-note">
        <span>当前 Runtime</span>
        <strong>{scanStatus?.runtimeLabel || runtimeHealth?.runtimeLabel || 'auto'}</strong>
        <small>{runtimeHealth?.headline || '等待健康检查'} · {runtimeHealth?.recommendation || '运行 npm run doctor 查看本机环境。'}</small>
      </div>
    </section>
  );
}

function ScanControlPanel({
  status,
  error,
  config,
  configError,
  configBusy,
  cookieAuth,
  runtimeHealth,
  cookieError,
  cookieBusy,
  isDemo,
  running,
  busy,
  onAction,
  onConfigChange,
  onCookieImport,
  onCookieClear
}: {
  status: ScanJobStatus | null;
  error: string;
  config: ScanConfig | null;
  configError: string;
  configBusy: boolean;
  cookieAuth: CookieAuthStatus | null;
  runtimeHealth: RuntimeHealthStatus | null;
  cookieError: string;
  cookieBusy: boolean;
  isDemo: boolean;
  running: boolean;
  busy: boolean;
  onAction: () => void;
  onConfigChange: (patch: Partial<Pick<ScanConfig, 'runtime' | 'mode' | 'cdpUrl'>>) => void;
  onCookieImport: (file: File) => void;
  onCookieClear: () => void;
}) {
  const cookieInputRef = useRef<HTMLInputElement>(null);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserMessage, setBrowserMessage] = useState('');
  const [browserError, setBrowserError] = useState('');
  const handleOpenBrowser = async () => {
    setBrowserBusy(true);
    setBrowserMessage('');
    setBrowserError('');
    try { setBrowserMessage((await openCdpBrowser()).message); }
    catch (error) { setBrowserError(error instanceof Error ? error.message : '浏览器启动失败'); }
    finally { setBrowserBusy(false); }
  };
  const [now, setNow] = useState(Date.now());
  const [cdpDraft, setCdpDraft] = useState(config?.cdpUrl || 'http://127.0.0.1:9222');
  const hasStatus = Boolean(status);
  const logs = status?.logLines.slice(-8) || [];
  const change = status?.changeSummary;
  const activeRuntime = config?.runtime || status?.runtime || 'playwright';
  const activeMode = config?.mode || status?.requestedMode || status?.mode || 'monitor';
  const configDisabled = isDemo || running || configBusy || !config?.canEdit;
  const modeOptions = config?.options?.modes || [];
  const runtimeOptions = config?.options?.runtimes || [];
  const authChallenge = status?.authChallenge || null;
  const waitingForVerification = status?.phase === 'waiting_for_verification' && authChallenge?.status === 'waiting';
  const challengeTitle = authChallenge?.kind === 'login' ? '等待登录' : '等待验证码';
  const challengeDetail = authChallenge?.message || '请在打开的浏览器窗口里完成人工验证。';
  const challengeRemaining = formatRemaining(authChallenge?.deadlineAt, now);
  const partialText = status?.partial
    ? `${formatDate(status.partial.collectedAt)} 保存 ${formatNumber(status.partial.count)} 条`
    : '等待采集进度';
  const auth = cookieAuth || status?.cookieAuth || null;
  const cookieState = isDemo
    ? '演示禁用'
    : auth?.error
      ? '配置异常'
      : auth?.configured
        ? `已配置 ${formatNumber(auth.acceptedCount)} / ${formatNumber(auth.cookieCount)}`
        : '未配置';
  const cookieDetail = auth?.configured
    ? `导出 ${formatDate(auth.exportedAt)} · 更新 ${formatDate(auth.updatedAt)} · 跳过 ${formatNumber(auth.skippedCount)}`
    : auth?.runtimeSupported === false
      ? '当前 runtime 不使用 cookie 注入'
      : '等待上传 cookie-manager 无损 JSON';

  useEffect(() => {
    if (!waitingForVerification) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waitingForVerification]);

  useEffect(() => {
    if (config?.cdpUrl) setCdpDraft(config.cdpUrl);
  }, [config?.cdpUrl]);

  const handleCookieFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) onCookieImport(file);
  };

  return (
    <section className={`panel scan-panel ${running ? 'active' : ''}`}>
      <div className="scan-panel-header">
        <PanelHeader
          icon={RefreshCw}
          title="采集控制"
          subtitle={isDemo ? '公开演示不连接本地浏览器' : '可切换 Runtime 和 monitor/recent/full 模式'}
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

      <div className="scan-config-card">
        <div className="scan-config-row">
          <div className="scan-config-label">
            <span>采集 Runtime</span>
            <strong>{config?.runtimeLabel || status?.runtimeLabel || RUNTIME_LABELS[activeRuntime] || activeRuntime}</strong>
          </div>
          <div className="segmented-buttons" role="group" aria-label="采集 Runtime">
            {runtimeOptions.map((option) => (
              <button
                key={option.value}
                className={`segmented-button ${activeRuntime === option.value ? 'selected' : ''}`}
                type="button"
                disabled={configDisabled}
                title={option.detail}
                onClick={() => onConfigChange({ runtime: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="scan-config-row">
          <div className="scan-config-label">
            <span>扫描模式</span>
            <strong>{MODE_LABELS[activeMode] || activeMode}</strong>
          </div>
          <div className="segmented-buttons" role="group" aria-label="扫描模式">
            {modeOptions.map((option) => (
              <button
                key={option.value}
                className={`segmented-button ${activeMode === option.value ? 'selected' : ''}`}
                type="button"
                disabled={configDisabled}
                title={option.detail}
                onClick={() => onConfigChange({ mode: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {activeRuntime === 'cdp' && (
          <div className="scan-config-row">
            <div className="scan-config-label">
              <span>CDP 地址</span>
              <strong>loopback only</strong>
            </div>
            <div className="scan-config-cdp">
              <input
                type="url"
                value={cdpDraft}
                disabled={configDisabled}
                onChange={(event) => setCdpDraft(event.currentTarget.value)}
                placeholder="http://127.0.0.1:9222"
              />
              <button
                className="button compact"
                type="button"
                disabled={configDisabled || cdpDraft === config?.cdpUrl}
                onClick={() => onConfigChange({ runtime: 'cdp', cdpUrl: cdpDraft })}
              >
                保存
              </button>
              <button className="button compact" type="button" onClick={handleOpenBrowser}
                disabled={configDisabled || browserBusy || cdpDraft !== config?.cdpUrl}>
                {browserBusy ? '正在连接…' : '打开采集浏览器'}
              </button>
            </div>
          </div>
        )}
      </div>

      {configError && (
        <div className="scan-error">
          <AlertTriangle size={16} />
          <span>{configError}</span>
        </div>
      )}

      {activeRuntime === 'cdp' && <p className="muted">自动启动专用 Chrome 并载入已有 Cookie；仅在 Cookie 失效或出现验证码时需要手动处理。</p>}
      {browserMessage && <p role="status">{browserMessage}</p>}
      {browserError && <div className="scan-error" role="alert">{browserError}</div>}

      <div className="scan-grid">
        <div><span>状态</span><strong>{hasStatus ? <StatusPill value={status!.status} /> : '-'}</strong></div>
        <div><span>阶段</span><strong>{PHASE_LABELS[status?.phase || 'idle'] || status?.phase || '-'}</strong></div>
        <div><span>Runtime</span><strong>{status?.runtimeLabel || status?.runtime || '-'}</strong></div>
        <div><span>模式</span><strong>{MODE_LABELS[status?.mode || 'monitor'] || status?.mode || '自动'}</strong></div>
        <div><span>原因</span><strong>{status?.reason || '-'}</strong></div>
        <div><span>页面</span><strong>{formatNumber(status?.pagesFetched || 0)}</strong></div>
        <div><span>累计</span><strong>{formatNumber(status?.count || 0)}</strong></div>
        <div><span>主页粉丝</span><strong>{formatNumber(status?.profileFollowerCount)}</strong></div>
        <div><span>Partial</span><strong>{partialText}</strong></div>
        <div><span>结束</span><strong>{formatDate(status?.finishedAt)}</strong></div>
      </div>

      {waitingForVerification && (
        <div className="verification-card">
          <div className="verification-icon"><Clock3 size={18} /></div>
          <div className="verification-main">
            <span>{challengeTitle}</span>
            <strong>{challengeDetail}</strong>
            <small>在采集浏览器中完成后会自动继续；不会自动识别或绕过验证码。</small>
          </div>
          <div className="verification-meta">
            <span>剩余</span>
            <strong>{challengeRemaining}</strong>
          </div>
        </div>
      )}

      <div className="cookie-auth-card">
        <div className="cookie-auth-main">
          <div className="cookie-auth-icon"><KeyRound size={17} /></div>
          <div>
            <span>Cookie 登录态</span>
            <strong>{cookieState}</strong>
            <small>{auth?.error || cookieDetail}</small>
          </div>
        </div>
        <div className="cookie-auth-actions">
          <input
            ref={cookieInputRef}
            type="file"
            accept="application/json,.json"
            className="visually-hidden"
            onChange={handleCookieFileChange}
          />
          <button className="button compact" type="button" onClick={() => cookieInputRef.current?.click()} disabled={isDemo || cookieBusy || running}>
            <Upload size={15} />导入
          </button>
          <button className="button compact" type="button" onClick={onCookieClear} disabled={isDemo || cookieBusy || running || !auth?.configured}>
            <Trash2 size={15} />清除
          </button>
        </div>
      </div>

      <RuntimeHealthCard health={runtimeHealth} status={status} isDemo={isDemo} />

      {cookieError && (
        <div className="scan-error">
          <AlertTriangle size={16} />
          <span>{cookieError}</span>
        </div>
      )}

      {change && (
        <div className="scan-summary">
          <span>完成摘要</span>
          <strong>新增 {formatNumber(change.newCount)} · 疑似 {formatNumber(change.suspectedRemovedCount)} · 确认 {formatNumber(change.removedCount)} · 互关后取关我 {formatNumber(change.mutualUnfollowedYouCount)} · 改名 {formatNumber(change.renamedCount)} · 隐藏差值 {formatNumber(change.hiddenOrUnavailableCount)}</strong>
        </div>
      )}

      <div className="log-tail" aria-label="采集日志">
        {logs.length ? logs.map((line, index) => <code key={`${line}-${index}`}>{line}</code>) : <code>{isDemo ? 'Demo 模式不运行本地采集。' : '点击“启动采集”后这里会显示实时进度。'}</code>}
      </div>
    </section>
  );
}

function RuntimeHealthCard({ health, status, isDemo }: { health: RuntimeHealthStatus | null; status: ScanJobStatus | null; isDemo: boolean }) {
  const [copied, setCopied] = useState(false);
  const view = health && status ? healthWithScanStatus(health, status) : health;
  if (!view) return null;
  const icon = view.level === 'ok' ? <CheckCircle2 size={17} /> : view.level === 'action' ? <AlertTriangle size={17} /> : <CircleDot size={17} />;

  const copyCommand = async () => {
    if (!view.commandHint) return;
    try {
      await navigator.clipboard.writeText(view.commandHint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={`runtime-health-card ${view.level}`}>
      <div className="runtime-health-top">
        <div className="runtime-health-title">
          <div className="runtime-health-icon">{icon}</div>
          <div>
            <span>Runtime 健康</span>
            <strong>{view.headline}</strong>
            <small>{view.recommendation}</small>
          </div>
        </div>
        <div className="runtime-health-recommendation">
          <span>当前</span>
          <strong>{view.runtimeLabel || view.runtime}</strong>
          <small>推荐 {view.recommendedRuntime.toUpperCase()}</small>
        </div>
      </div>

      <div className="runtime-checks">
        {view.checks.map((item) => (
          <div className={`runtime-check ${item.state}`} key={item.id}>
            <span>{item.label}</span>
            <strong>{item.detail}</strong>
          </div>
        ))}
      </div>

      {view.commandHint && (
        <div className="runtime-command">
          <code>{view.commandHint}</code>
          <button className="button compact" type="button" onClick={copyCommand} disabled={isDemo}>
            <Copy size={15} />{copied ? '已复制' : '复制'}
          </button>
        </div>
      )}
    </div>
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

function RelationshipPill({ value }: { value: RelationshipStatus }) {
  const tone = value === 'mutual' ? 'rose' : value === 'follower_only' ? 'teal' : 'muted';
  return <span className={`pill ${tone}`}>{RELATIONSHIP_LABELS[value]}</span>;
}

function EventTypePill({ value }: { value: EventType }) {
  const tone = value === 'new' ? 'teal' : value === 'removed' || value === 'mutual_unfollowed_you' ? 'rose' : value === 'suspected_removed' ? 'amber' : value === 'reappeared' ? 'green' : 'muted';
  return <span className={`pill ${tone}`}>{EVENT_LABELS[value] || value}</span>;
}

function EventsTable({ events }: { events: FollowerEvent[] }) {
  const [selected, setSelected] = useState<FollowerEvent | null>(null);
  if (!events.length) return <div className="empty-state">没有匹配的事件</div>;
  return (
    <>
    <div className="mobile-records">
      {events.map(event => <article className="mobile-record" key={event.eventId}>
        <div className="mobile-record-heading"><strong>{event.nickname || event.followerId}</strong><button type="button" onClick={() => setSelected(event)}>查看详情</button></div>
        <EventTypePill value={event.type} /><small>{formatDate(event.createdAt)} · 检测时间</small>
      </article>)}
    </div>
    {selected && <EventDetail event={selected} onClose={() => setSelected(null)} />}
    <div className="table-wrap desktop-records">
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
    </>
  );
}

function EventDetail({ event, onClose }: { event: FollowerEvent; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);
  return <dialog ref={dialog} className="event-dialog" aria-labelledby="event-detail-title" onCancel={onClose}>
    <button className="button ghost" type="button" onClick={onClose}>返回关系事件</button>
    <h2 id="event-detail-title">事件详情</h2>
    <article className="mobile-record"><h3>{event.nickname || event.followerId}</h3><EventTypePill value={event.type} /><p>检测时间：{formatDate(event.createdAt)}</p></article>
    <article className="mobile-record"><h3>关联采集记录</h3><code>{event.runId}</code><p>{event.type === 'mutual_unfollowed_you' ? '该记录被标记为互关后取关我。历史互关与完整采集缺失是此类事件的判定依据。' : '此处展示已保存的事件记录，不额外推断历史互关关系。'}</p></article>
    <article className="mobile-record connection-summary"><strong>检测时间不等于实际取关时间</strong><p>未提供的历史时间点不补写；失败或不完整采集不用于确认取关。</p></article>
    {event.profileUrl && <a className="button primary" href={event.profileUrl} target="_blank" rel="noreferrer">查看抖音主页</a>}
  </dialog>;
}

function FollowersTable({ followers }: { followers: Follower[] }) {
  if (!followers.length) return <div className="empty-state">没有匹配的粉丝</div>;
  return (
    <>
    <div className="mobile-records">
      {followers.map(follower => <article className="mobile-record" key={follower.id}>
        <div className="mobile-record-heading"><a className="table-link" href={follower.profileUrl} target="_blank" rel="noreferrer">{follower.nickname || follower.id}<ExternalLink size={13} /></a><RelationshipPill value={follower.relationshipStatus || 'unknown'} /></div>
        <small>最近出现 {formatDate(follower.lastSeenAt)}</small>
        <details><summary>查看记录</summary><p>首次出现 {formatDate(follower.firstSeenAt)}</p><p>完整采集缺失 {formatNumber(follower.missingFullScans || 0)} 次</p><FollowerStatusPill value={follower.status} /><p className="sub-id">{follower.uid || follower.id}</p></details>
      </article>)}
    </div>
    <div className="table-wrap desktop-records">
      <table>
        <thead>
          <tr>
            <th>昵称</th>
            <th>状态</th>
            <th>关系</th>
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
              <td><RelationshipPill value={follower.relationshipStatus || 'unknown'} /></td>
              <td>{formatDate(follower.firstSeenAt)}</td>
              <td>{formatDate(follower.lastSeenAt)}</td>
              <td>{formatNumber(follower.missingFullScans || 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}

function RunDetailPanel({ detail, events, error }: { detail: ScanRunDetail | null; events: FollowerEvent[]; error: string }) {
  if (error) {
    return (
      <div className="run-detail">
        <div className="scan-error"><AlertTriangle size={16} /><span>{error}</span></div>
      </div>
    );
  }
  if (!detail) return <div className="run-detail empty-state">选择一条扫描记录查看本次变化</div>;

  const counts = [
    ['新增', detail.eventCounts.new],
    ['疑似取关', detail.eventCounts.suspected_removed],
    ['确认取关', detail.eventCounts.removed],
    ['互关后取关我', detail.eventCounts.mutual_unfollowed_you],
    ['重新出现', detail.eventCounts.reappeared],
    ['改名', detail.eventCounts.renamed]
  ];

  return (
    <div className="run-detail">
      <div className="run-detail-header">
        <div>
          <span>Run detail</span>
          <strong>{detail.runId}</strong>
          <small>{MODE_LABELS[detail.mode] || detail.mode} · {formatDate(detail.startedAt)} · {detail.reason || 'no-reason'}</small>
        </div>
        <StatusPill value={detail.status} />
      </div>
      <div className="run-event-counts">
        {counts.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{formatNumber(Number(value))}</strong>
          </div>
        ))}
      </div>
      <div className="run-event-preview">
        <span>本次事件预览</span>
        {events.length ? <EventsTable events={events.slice(0, 6)} /> : <div className="empty-state compact-empty">本次 run 暂无事件</div>}
      </div>
    </div>
  );
}

function ComparePanel({
  runs,
  from,
  to,
  result,
  error,
  busy,
  onFromChange,
  onToChange,
  onCompare
}: {
  runs: ScanRun[];
  from: string;
  to: string;
  result: RunCompareResult | null;
  error: string;
  busy: boolean;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onCompare: () => void;
}) {
  if (!runs.length) return null;

  return (
    <div className="compare-panel">
      <div className="compare-controls">
        <div>
          <span>快照对比</span>
          <strong>选择两个 run 查看 added / missing / renamed / reappeared</strong>
        </div>
        <label>
          Baseline
          <select value={from} onChange={(event) => onFromChange(event.target.value)}>
            {runs.map((run) => <option value={run.runId} key={run.runId}>{run.runId}</option>)}
          </select>
        </label>
        <label>
          Target
          <select value={to} onChange={(event) => onToChange(event.target.value)}>
            {runs.map((run) => <option value={run.runId} key={run.runId}>{run.runId}</option>)}
          </select>
        </label>
        <button className="button compact" type="button" disabled={!from || !to || busy} onClick={onCompare}>
          <GitBranch size={15} />对比
        </button>
      </div>

      {error && <div className="scan-error"><AlertTriangle size={16} /><span>{error}</span></div>}
      {result?.warning && <div className="notice warning compare-warning"><AlertTriangle size={16} /><span>{result.warning}</span></div>}

      {result && (
        <div className="compare-result">
          <div className="compare-counts">
            <div><span>Added</span><strong>{formatNumber(result.counts.added)}</strong></div>
            <div><span>Missing</span><strong>{formatNumber(result.counts.missing)}</strong></div>
            <div><span>Renamed</span><strong>{formatNumber(result.counts.renamed)}</strong></div>
            <div><span>Reappeared</span><strong>{formatNumber(result.counts.reappeared)}</strong></div>
          </div>
          <div className="compare-lists">
            <CompareList title="新增" rows={result.added} />
            <CompareList title="缺失/取关事件" rows={result.missing} />
            <CompareList title="改名" rows={result.renamed} />
            <CompareList title="重新出现" rows={result.reappeared} />
          </div>
        </div>
      )}
    </div>
  );
}

function CompareList({ title, rows }: { title: string; rows: FollowerEvent[] }) {
  return (
    <div className="compare-list">
      <span>{title}</span>
      {rows.length ? rows.slice(0, 5).map((event) => (
        <div key={event.eventId}>
          <EventTypePill value={event.type} />
          <strong>{event.nickname || event.followerId}</strong>
        </div>
      )) : <small>无</small>}
    </div>
  );
}

function RunsTable({ runs, selectedRunId, onSelectRun }: { runs: ScanRun[]; selectedRunId: string; onSelectRun: (runId: string) => void }) {
  if (!runs.length) return <div className="empty-state">暂无扫描运行记录</div>;
  return (
    <>
    <div className="mobile-records">
      {runs.map(run => <article className="mobile-record" key={run.runId}>
        <div className="mobile-record-heading"><strong>{formatDate(run.startedAt)} · {MODE_LABELS[run.mode] || run.mode}</strong><StatusPill value={run.status} /></div>
        <small>主页 / 可枚举：{formatNumber(run.profileFollowerCount)} / {formatNumber(run.enumerableCount)}</small>
        <button className="button ghost" aria-pressed={selectedRunId === run.runId} type="button" onClick={() => { onSelectRun(run.runId); document.querySelector('.run-detail')?.scrollIntoView({ block: 'start' }); }}>查看采集记录</button>
      </article>)}
    </div>
    <div className="table-wrap desktop-records">
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
            <tr key={run.runId} className={selectedRunId === run.runId ? 'selected-row' : ''}>
              <td>
                <button className="run-link" type="button" onClick={() => onSelectRun(run.runId)}>
                  {run.runId}
                </button>
                <span className="sub-id">{formatDate(run.startedAt)}</span>
              </td>
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
    </>
  );
}

export default App;
