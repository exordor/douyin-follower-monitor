import type { EventDailyPoint, StatusCounts, TimelinePoint } from '../types';

function numeric(value: number | null | undefined) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function compact(value: number) {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function axisRange(values: number[]) {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (!finiteValues.length) return { min: 0, max: 1 };

  const rawMin = Math.min(...finiteValues);
  const rawMax = Math.max(...finiteValues);
  const spread = Math.max(rawMax - rawMin, 1);
  const padding = Math.max(Math.ceil(spread * 0.2), 1);

  return {
    min: Math.max(0, Math.floor(rawMin - padding)),
    max: Math.ceil(rawMax + padding)
  };
}

function pointsFor(values: number[], width: number, height: number, min: number, max: number, padding = 26) {
  const spread = Math.max(max - min, 1);
  return values.map((value, index) => {
    const x = padding + (index * (width - padding * 2)) / Math.max(values.length - 1, 1);
    const y = height - padding - ((value - min) / spread) * (height - padding * 2);
    return [x, y] as const;
  });
}

function pathFrom(points: readonly (readonly [number, number])[]) {
  return points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
}

export function TrendChart({ data }: { data: TimelinePoint[] }) {
  if (!data.length) {
    return <div className="empty-chart">暂无扫描记录，先运行 npm run monitor:doubao</div>;
  }

  const width = 760;
  const height = 260;
  const enumerable = data.map((row) => numeric(row.enumerableCount));
  const profile = data.map((row) => numeric(row.profileFollowerCount));
  const { min, max } = axisRange([...enumerable, ...profile]);
  const enumerablePoints = pointsFor(enumerable, width, height, min, max);
  const profilePoints = pointsFor(profile, width, height, min, max);

  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="粉丝趋势">
      <defs>
        <linearGradient id="trendFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#14b8a6" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#14b8a6" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 1, 2, 3].map((line) => {
        const y = 26 + (line * (height - 52)) / 3;
        return <line key={line} x1="26" x2={width - 26} y1={y} y2={y} stroke="#e8edf2" strokeWidth="1" />;
      })}
      <text x="28" y="20" className="chart-label">{compact(max)}</text>
      <text x="28" y={height - 8} className="chart-label">{compact(min)}</text>
      <path
        d={`${pathFrom(enumerablePoints)} L ${width - 26} ${height - 26} L 26 ${height - 26} Z`}
        fill="url(#trendFill)"
      />
      <path d={pathFrom(profilePoints)} fill="none" stroke="#f43f5e" strokeWidth="3" strokeLinecap="round" />
      <path d={pathFrom(enumerablePoints)} fill="none" stroke="#14b8a6" strokeWidth="4" strokeLinecap="round" />
      {enumerablePoints.map(([x, y], index) => (
        <circle key={data[index].runId} cx={x} cy={y} r="4.5" fill="#ffffff" stroke="#14b8a6" strokeWidth="3" />
      ))}
    </svg>
  );
}

export function EventBars({ data }: { data: EventDailyPoint[] }) {
  const width = 760;
  const height = 210;
  const padding = 24;
  const totals = data.map((row) => row.new + row.renamed + row.suspected_removed + row.removed + row.reappeared);
  const max = Math.max(...totals, 1);
  const barWidth = Math.max(18, (width - padding * 2) / Math.max(data.length, 1) - 12);

  if (!data.length) {
    return <div className="empty-chart">暂无事件记录</div>;
  }

  const colors: Record<keyof Omit<EventDailyPoint, 'date'>, string> = {
    new: '#14b8a6',
    renamed: '#64748b',
    suspected_removed: '#d97706',
    removed: '#f43f5e',
    reappeared: '#16a34a'
  };

  return (
    <svg className="chart chart-bars" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="事件分布">
      {[0, 1, 2].map((line) => {
        const y = padding + (line * (height - padding * 2)) / 2;
        return <line key={line} x1={padding} x2={width - padding} y1={y} y2={y} stroke="#edf1f5" strokeWidth="1" />;
      })}
      {data.map((row, index) => {
        const x = padding + index * ((width - padding * 2) / Math.max(data.length, 1)) + 5;
        let y = height - padding;
        return (
          <g key={row.date}>
            {(['removed', 'suspected_removed', 'renamed', 'reappeared', 'new'] as const).map((key) => {
              const h = (row[key] / max) * (height - padding * 2);
              y -= h;
              return <rect key={key} x={x} y={y} width={barWidth} height={Math.max(h, row[key] ? 2 : 0)} rx="4" fill={colors[key]} />;
            })}
            <text x={x + barWidth / 2} y={height - 6} textAnchor="middle" className="chart-label">
              {row.date.slice(5)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function StatusDonut({ counts }: { counts: StatusCounts }) {
  const total = Math.max(counts.total, 1);
  const segments = [
    { label: '活跃', value: counts.active, color: '#14b8a6' },
    { label: '疑似', value: counts.suspected_removed, color: '#d97706' },
    { label: '确认', value: counts.removed, color: '#f43f5e' }
  ];
  let offset = 25;

  return (
    <div className="donut-wrap">
      <svg className="donut" viewBox="0 0 120 120" role="img" aria-label="粉丝状态分布">
        <circle cx="60" cy="60" r="42" fill="none" stroke="#edf1f5" strokeWidth="18" />
        {segments.map((segment) => {
          const dash = (segment.value / total) * 100;
          const circle = (
            <circle
              key={segment.label}
              cx="60"
              cy="60"
              r="42"
              fill="none"
              stroke={segment.color}
              strokeWidth="18"
              strokeDasharray={`${dash} ${100 - dash}`}
              strokeDashoffset={offset}
              pathLength="100"
            />
          );
          offset -= dash;
          return circle;
        })}
        <text x="60" y="57" textAnchor="middle" className="donut-number">{compact(counts.total)}</text>
        <text x="60" y="74" textAnchor="middle" className="donut-caption">已知账号</text>
      </svg>
      <div className="donut-legend">
        {segments.map((segment) => (
          <div className="legend-row" key={segment.label}>
            <span className="legend-dot" style={{ background: segment.color }} />
            <span>{segment.label}</span>
            <strong>{segment.value.toLocaleString('zh-CN')}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
