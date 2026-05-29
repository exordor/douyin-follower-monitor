#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  applyScanToDatabase,
  closeMonitorDatabase,
  openMonitorDatabase
} from './collect-followers.mjs';

import {
  getDashboardEventDaily,
  getDashboardEvents,
  getDashboardFollowers,
  getDashboardCompare,
  getDashboardRun,
  getDashboardRunEvents,
  getDashboardRuns,
  getDashboardSummary,
  getDashboardTimeline
} from './dashboard-data.mjs';

function follower(id, nickname) {
  return {
    id,
    uid: id.replace(/\D/g, '') || id,
    nickname,
    profileUrl: `https://www.douyin.com/user/${id}`
  };
}

function options(runId, profileFollowerCount = 3) {
  return {
    mode: 'full',
    effectiveMode: 'full',
    modeReason: 'test',
    runId,
    confirmRemoveScans: 2,
    profileStats: { followers: profileFollowerCount }
  };
}

async function withFixture(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-dashboard-test-'));
  const dbPath = path.join(dir, 'followers.db');
  const outDir = path.join(dir, 'data');
  const db = await openMonitorDatabase(dbPath);
  try {
    const x = follower('sec-x', '用户 X');
    const y = follower('sec-y', '用户 Y');
    const z = follower('sec-z', '用户 Z');

    applyScanToDatabase(db, options('run-a', 3), [x, y]);
    db.prepare(`
      INSERT INTO scan_runs (
        runId, mode, requestedMode, startedAt, finishedAt, status,
        profileFollowerCount, enumerableCount, pagesFetched, reason
      ) VALUES ('run-a', 'full', 'full', ?, ?, 'completed', 3, 2, 1, 'test')
    `).run(new Date(Date.now() - 2 * 86400000).toISOString(), new Date(Date.now() - 2 * 86400000).toISOString());

    applyScanToDatabase(db, options('run-b', 4), [x, { ...y, nickname: '用户 Y 改名' }, z]);
    db.prepare(`
      INSERT INTO scan_runs (
        runId, mode, requestedMode, startedAt, finishedAt, status,
        profileFollowerCount, enumerableCount, pagesFetched, reason
      ) VALUES ('run-b', 'full', 'monitor', ?, ?, 'completed', 4, 3, 2, 'full-interval-elapsed')
    `).run(new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() - 86400000).toISOString());

    applyScanToDatabase(db, options('run-c', 3), [{ ...y, nickname: '用户 Y 改名' }, z]);
    db.prepare(`
      INSERT INTO scan_runs (
        runId, mode, requestedMode, startedAt, finishedAt, status,
        profileFollowerCount, enumerableCount, pagesFetched, reason
      ) VALUES ('run-c', 'full', 'monitor', ?, ?, 'completed', 3, 2, 2, 'profile-followers-decreased')
    `).run(new Date().toISOString(), new Date().toISOString());

    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'latest-change.json'), JSON.stringify({
      collectedAt: new Date().toISOString(),
      mode: 'full',
      currentCount: 2,
      previousCount: 3,
      newCount: 0,
      suspectedRemovedCount: 1,
      removedCount: 0,
      renamedCount: 0,
      reappearedCount: 0,
      hiddenOrUnavailableCount: 1
    }, null, 2));

    await fn({ dbPath, outDir });
  } finally {
    closeMonitorDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
}

await withFixture(async ({ dbPath, outDir }) => {
  const summary = await getDashboardSummary({ dbPath, outDir });
  assert.equal(summary.hasDatabase, true);
  assert.equal(summary.profileFollowerCount, 3);
  assert.equal(summary.enumerableCount, 2);
  assert.equal(summary.hiddenOrUnavailableCount, 1);
  assert.equal(summary.statusCounts.active, 2);
  assert.equal(summary.statusCounts.suspected_removed, 1);
  assert.equal(summary.lastChangeCounts.suspectedRemovedCount, 1);

  const timeline = await getDashboardTimeline({ dbPath, days: 7 });
  assert.equal(timeline.length, 3);
  assert.equal(timeline.at(-1).hiddenOrUnavailableCount, 1);

  const followers = await getDashboardFollowers({ dbPath, status: 'active', q: '用户', limit: 10, offset: 0 });
  assert.equal(followers.total, 2);
  assert.equal(followers.rows.every((row) => row.status === 'active'), true);

  const events = await getDashboardEvents({ dbPath, type: 'renamed', q: '改名', limit: 10, offset: 0 });
  assert.equal(events.total >= 1, true);
  assert.equal(events.rows.every((row) => row.type === 'renamed'), true);

  const daily = await getDashboardEventDaily({ dbPath, days: 7 });
  assert.equal(daily.length > 0, true);
  assert.equal(daily.some((row) => row.new > 0), true);

  const runs = await getDashboardRuns({ dbPath, limit: 2 });
  assert.equal(runs.length, 2);
  assert.equal(runs[0].runId, 'run-c');

  const runDetail = await getDashboardRun({ dbPath, runId: 'run-b' });
  assert.equal(runDetail.runId, 'run-b');
  assert.equal(runDetail.eventCounts.new, 1);
  assert.equal(runDetail.eventCounts.renamed >= 1, true);

  const runEvents = await getDashboardRunEvents({ dbPath, runId: 'run-b', type: 'new', limit: 10, offset: 0 });
  assert.equal(runEvents.total, 1);
  assert.equal(runEvents.rows[0].runId, 'run-b');

  const compared = await getDashboardCompare({ dbPath, from: 'run-a', to: 'run-c' });
  assert.equal(compared.fromRun.runId, 'run-a');
  assert.equal(compared.toRun.runId, 'run-c');
  assert.deepEqual(compared.added.map((row) => row.followerId), ['sec-z']);
  assert.deepEqual(compared.renamed.map((row) => row.followerId), ['sec-y']);
  assert.deepEqual(compared.missing.map((row) => row.followerId), ['sec-x']);
  assert.equal(compared.reappeared.length, 0);
  assert.equal(compared.added.some((row) => row.runId === 'run-a'), false);
  assert.deepEqual(compared.counts, {
    added: 1,
    missing: 1,
    renamed: 1,
    reappeared: 0
  });
  assert.equal(compared.warning, '');

  const missingRun = await getDashboardRun({ dbPath, runId: 'missing-run' });
  assert.equal(missingRun, null);
});

const emptySummary = await getDashboardSummary({
  dbPath: path.join(os.tmpdir(), 'missing-douyin-dashboard.db'),
  outDir: path.join(os.tmpdir(), 'missing-douyin-dashboard-data')
});
assert.equal(emptySummary.hasDatabase, false);
assert.equal(emptySummary.statusCounts.active, 0);

console.log('dashboard api tests passed');
