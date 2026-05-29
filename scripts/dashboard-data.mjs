import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT_DIR = path.resolve(new URL('..', import.meta.url).pathname);

const DEFAULT_DB = path.join(ROOT_DIR, 'data', 'followers.db');
const DEFAULT_OUT_DIR = path.join(ROOT_DIR, 'data');

const EVENT_TYPES = new Set(['new', 'seen', 'suspected_removed', 'removed', 'reappeared', 'renamed']);
const FOLLOWER_STATUSES = new Set(['active', 'suspected_removed', 'removed']);

function clampLimit(value, fallback = 100, max = 5000) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(number, max);
}

function clampOffset(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number < 0) return 0;
  return number;
}

function parseDays(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number <= 0) return 30;
  return Math.min(number, 365);
}

function normalizeLike(value) {
  return `%${String(value || '').trim().toLowerCase()}%`;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function openExistingDashboardDb(dbPath = DEFAULT_DB) {
  if (!existsSync(dbPath)) return null;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA query_only = ON;');
  return db;
}

function closeDashboardDb(db) {
  try {
    db?.close();
  } catch {
    // Best-effort cleanup.
  }
}

function getStatusCounts(db) {
  const counts = {
    active: 0,
    suspected_removed: 0,
    removed: 0,
    total: 0
  };
  if (!db) return counts;

  for (const row of db.prepare('SELECT status, COUNT(*) AS count FROM followers GROUP BY status').all()) {
    counts[row.status] = Number(row.count || 0);
    counts.total += Number(row.count || 0);
  }
  return counts;
}

function getLatestRun(db) {
  if (!db) return null;
  return db.prepare(`
    SELECT runId, mode, requestedMode, startedAt, finishedAt, status,
           profileFollowerCount, enumerableCount, pagesFetched, reason
    FROM scan_runs
    ORDER BY COALESCE(finishedAt, startedAt) DESC
    LIMIT 1
  `).get() || null;
}

function getLatestCompletedRun(db) {
  if (!db) return null;
  return db.prepare(`
    SELECT runId, mode, requestedMode, startedAt, finishedAt, status,
           profileFollowerCount, enumerableCount, pagesFetched, reason
    FROM scan_runs
    WHERE status = 'completed'
    ORDER BY COALESCE(finishedAt, startedAt) DESC
    LIMIT 1
  `).get() || null;
}

function emptyPage(limit, offset) {
  return { total: 0, limit, offset, rows: [] };
}

async function getDashboardSummary({ dbPath = DEFAULT_DB, outDir = DEFAULT_OUT_DIR } = {}) {
  const db = await openExistingDashboardDb(dbPath);
  try {
    const latestChange = await readJsonIfExists(path.join(outDir, 'latest-change.json'));
    const latestSnapshot = await readJsonIfExists(path.join(outDir, 'latest.json'));
    const statusCounts = getStatusCounts(db);
    const latestRun = getLatestRun(db);
    const latestCompletedRun = getLatestCompletedRun(db);
    const profileFollowerCount =
      latestRun?.profileFollowerCount ??
      latestCompletedRun?.profileFollowerCount ??
      latestSnapshot?.profileStats?.followers ??
      null;
    const enumerableCount =
      latestRun?.enumerableCount ??
      latestCompletedRun?.enumerableCount ??
      latestSnapshot?.count ??
      statusCounts.active;
    const hiddenOrUnavailableCount = Math.max(
      0,
      Number(profileFollowerCount || 0) - Number(enumerableCount || 0)
    );

    return {
      generatedAt: new Date().toISOString(),
      hasDatabase: Boolean(db),
      dbPath,
      outDir,
      statusCounts,
      profileFollowerCount,
      enumerableCount,
      hiddenOrUnavailableCount,
      latestRun,
      latestCompletedRun,
      latestChange: latestChange || null,
      lastChangeCounts: {
        newCount: latestChange?.newCount ?? latestChange?.addedCount ?? 0,
        suspectedRemovedCount: latestChange?.suspectedRemovedCount ?? 0,
        removedCount: latestChange?.removedCount ?? 0,
        renamedCount: latestChange?.renamedCount ?? 0,
        reappearedCount: latestChange?.reappearedCount ?? 0
      }
    };
  } finally {
    closeDashboardDb(db);
  }
}

async function getDashboardTimeline({ dbPath = DEFAULT_DB, days = 30 } = {}) {
  const db = await openExistingDashboardDb(dbPath);
  const parsedDays = parseDays(days);
  if (!db) return [];

  try {
    const since = new Date(Date.now() - parsedDays * 24 * 60 * 60 * 1000).toISOString();
    return db.prepare(`
      SELECT runId, mode, requestedMode, startedAt, finishedAt, status,
             profileFollowerCount, enumerableCount, pagesFetched, reason
      FROM scan_runs
      WHERE startedAt >= ? AND status IN ('completed', 'interrupted', 'failed')
      ORDER BY startedAt ASC
    `).all(since).map((row) => ({
      ...row,
      hiddenOrUnavailableCount: Math.max(
        0,
        Number(row.profileFollowerCount || 0) - Number(row.enumerableCount || 0)
      )
    }));
  } finally {
    closeDashboardDb(db);
  }
}

async function getDashboardFollowers({
  dbPath = DEFAULT_DB,
  status = '',
  q = '',
  limit = 100,
  offset = 0
} = {}) {
  const db = await openExistingDashboardDb(dbPath);
  const parsedLimit = clampLimit(limit);
  const parsedOffset = clampOffset(offset);
  if (!db) return emptyPage(parsedLimit, parsedOffset);

  try {
    const where = [];
    const params = [];
    if (FOLLOWER_STATUSES.has(status)) {
      where.push('status = ?');
      params.push(status);
    }
    if (String(q || '').trim()) {
      where.push('(LOWER(nickname) LIKE ? OR LOWER(id) LIKE ? OR LOWER(uid) LIKE ?)');
      const like = normalizeLike(q);
      params.push(like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS count FROM followers ${whereSql}`).get(...params).count;
    const rows = db.prepare(`
      SELECT id, uid, nickname, profileUrl, firstSeenAt, lastSeenAt, lastFullSeenAt,
             status, suspectedRemovedAt, removedAt, missingFullScans
      FROM followers
      ${whereSql}
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'suspected_removed' THEN 1 ELSE 2 END,
        COALESCE(lastSeenAt, firstSeenAt) DESC,
        nickname COLLATE NOCASE ASC
      LIMIT ? OFFSET ?
    `).all(...params, parsedLimit, parsedOffset);
    return { total: Number(total || 0), limit: parsedLimit, offset: parsedOffset, rows };
  } finally {
    closeDashboardDb(db);
  }
}

async function getDashboardEvents({
  dbPath = DEFAULT_DB,
  type = '',
  q = '',
  runId = '',
  limit = 100,
  offset = 0
} = {}) {
  const db = await openExistingDashboardDb(dbPath);
  const parsedLimit = clampLimit(limit);
  const parsedOffset = clampOffset(offset);
  if (!db) return emptyPage(parsedLimit, parsedOffset);

  try {
    const where = [];
    const params = [];
    if (EVENT_TYPES.has(type)) {
      where.push('e.type = ?');
      params.push(type);
    }
    if (runId) {
      where.push('e.runId = ?');
      params.push(String(runId));
    }
    if (String(q || '').trim()) {
      where.push('(LOWER(f.nickname) LIKE ? OR LOWER(e.followerId) LIKE ? OR LOWER(e.payloadJson) LIKE ?)');
      const like = normalizeLike(q);
      params.push(like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`
      SELECT COUNT(*) AS count
      FROM follower_events e
      LEFT JOIN followers f ON f.id = e.followerId
      ${whereSql}
    `).get(...params).count;
    const rows = db.prepare(`
      SELECT e.eventId, e.followerId, e.type, e.runId, e.createdAt, e.payloadJson,
             f.nickname, f.profileUrl, f.status
      FROM follower_events e
      LEFT JOIN followers f ON f.id = e.followerId
      ${whereSql}
      ORDER BY e.createdAt DESC, e.eventId DESC
      LIMIT ? OFFSET ?
    `).all(...params, parsedLimit, parsedOffset).map((row) => ({
      ...row,
      payload: safeJson(row.payloadJson)
    }));
    return { total: Number(total || 0), limit: parsedLimit, offset: parsedOffset, rows };
  } finally {
    closeDashboardDb(db);
  }
}

async function getDashboardRuns({ dbPath = DEFAULT_DB, limit = 100 } = {}) {
  const db = await openExistingDashboardDb(dbPath);
  const parsedLimit = clampLimit(limit, 100, 300);
  if (!db) return [];

  try {
    return db.prepare(`
      SELECT runId, mode, requestedMode, startedAt, finishedAt, status,
             profileFollowerCount, enumerableCount, pagesFetched, reason
      FROM scan_runs
      ORDER BY COALESCE(finishedAt, startedAt) DESC
      LIMIT ?
    `).all(parsedLimit).map((row) => ({
      ...row,
      hiddenOrUnavailableCount: Math.max(
        0,
        Number(row.profileFollowerCount || 0) - Number(row.enumerableCount || 0)
      )
    }));
  } finally {
    closeDashboardDb(db);
  }
}

async function getDashboardRun({ dbPath = DEFAULT_DB, runId = '' } = {}) {
  const db = await openExistingDashboardDb(dbPath);
  if (!db || !runId) return null;
  try {
    const run = db.prepare(`
      SELECT runId, mode, requestedMode, startedAt, finishedAt, status,
             profileFollowerCount, enumerableCount, pagesFetched, reason
      FROM scan_runs
      WHERE runId = ?
    `).get(runId);
    if (!run) return null;
    const counts = db.prepare(`
      SELECT type, COUNT(*) AS count
      FROM follower_events
      WHERE runId = ?
      GROUP BY type
    `).all(runId).reduce((acc, row) => {
      acc[row.type] = Number(row.count || 0);
      return acc;
    }, {});
    return {
      ...run,
      hiddenOrUnavailableCount: Math.max(
        0,
        Number(run.profileFollowerCount || 0) - Number(run.enumerableCount || 0)
      ),
      eventCounts: {
        new: counts.new || 0,
        renamed: counts.renamed || 0,
        suspected_removed: counts.suspected_removed || 0,
        removed: counts.removed || 0,
        reappeared: counts.reappeared || 0
      }
    };
  } finally {
    closeDashboardDb(db);
  }
}

async function getDashboardRunEvents({
  dbPath = DEFAULT_DB,
  runId = '',
  type = '',
  limit = 100,
  offset = 0
} = {}) {
  return getDashboardEvents({ dbPath, type, q: '', limit, offset, runId });
}

async function getDashboardCompare({ dbPath = DEFAULT_DB, from = '', to = '' } = {}) {
  const db = await openExistingDashboardDb(dbPath);
  if (!db || !from || !to) return null;
  try {
    const fromRun = await getDashboardRun({ dbPath, runId: from });
    const toRun = await getDashboardRun({ dbPath, runId: to });
    if (!fromRun || !toRun) return null;
    const fromTime = fromRun.startedAt;
    const toTime = toRun.startedAt;
    const start = fromTime <= toTime ? fromTime : toTime;
    const end = fromTime <= toTime ? toTime : fromTime;
    const rows = db.prepare(`
      SELECT e.eventId, e.followerId, e.type, e.runId, e.createdAt, e.payloadJson,
             f.nickname, f.profileUrl, f.status
      FROM follower_events e
      JOIN scan_runs r ON r.runId = e.runId
      LEFT JOIN followers f ON f.id = e.followerId
      WHERE r.startedAt >= ?
        AND r.startedAt <= ?
        AND e.runId != ?
      ORDER BY r.startedAt ASC, e.createdAt ASC, e.eventId ASC
    `).all(start, end, fromRun.runId).map((row) => ({
      ...row,
      payload: safeJson(row.payloadJson)
    }));
    const buckets = {
      added: [],
      missing: [],
      renamed: [],
      reappeared: []
    };
    for (const row of rows) {
      if (row.type === 'new') buckets.added.push(row);
      else if (row.type === 'suspected_removed' || row.type === 'removed') buckets.missing.push(row);
      else if (row.type === 'renamed') buckets.renamed.push(row);
      else if (row.type === 'reappeared') buckets.reappeared.push(row);
    }
    const warning = fromRun.mode !== 'full' || toRun.mode !== 'full'
      ? '包含 recent 扫描时，对比结果只作为事件窗口参考；只有 full 扫描缺失才能作为取关判断。'
      : '';
    return {
      fromRun,
      toRun,
      warning,
      counts: {
        added: buckets.added.length,
        missing: buckets.missing.length,
        renamed: buckets.renamed.length,
        reappeared: buckets.reappeared.length
      },
      ...buckets
    };
  } finally {
    closeDashboardDb(db);
  }
}

async function getDashboardEventDaily({ dbPath = DEFAULT_DB, days = 30 } = {}) {
  const db = await openExistingDashboardDb(dbPath);
  const parsedDays = parseDays(days);
  if (!db) return [];

  try {
    const since = new Date(Date.now() - parsedDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(`
      SELECT substr(createdAt, 1, 10) AS date, type, COUNT(*) AS count
      FROM follower_events
      WHERE createdAt >= ?
      GROUP BY date, type
      ORDER BY date ASC
    `).all(since);
    const byDate = new Map();
    for (const row of rows) {
      if (!byDate.has(row.date)) {
        byDate.set(row.date, {
          date: row.date,
          new: 0,
          renamed: 0,
          suspected_removed: 0,
          removed: 0,
          reappeared: 0
        });
      }
      byDate.get(row.date)[row.type] = Number(row.count || 0);
    }
    return [...byDate.values()];
  } finally {
    closeDashboardDb(db);
  }
}

async function getDashboardExport({ outDir = DEFAULT_OUT_DIR, name }) {
  if (name === 'latest.json') {
    const text = await readTextIfExists(path.join(outDir, 'latest.json'));
    return text ? { contentType: 'application/json; charset=utf-8', body: text } : null;
  }
  if (name === 'latest.csv') {
    const text = await readTextIfExists(path.join(outDir, 'latest.csv'));
    return text ? { contentType: 'text/csv; charset=utf-8', body: text } : null;
  }
  return null;
}

function safeJson(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

export {
  DEFAULT_DB,
  DEFAULT_OUT_DIR,
  getDashboardEventDaily,
  getDashboardEvents,
  getDashboardExport,
  getDashboardFollowers,
  getDashboardCompare,
  getDashboardRun,
  getDashboardRunEvents,
  getDashboardRuns,
  getDashboardSummary,
  getDashboardTimeline
};
