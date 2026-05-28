#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  applyScanToDatabase,
  closeMonitorDatabase,
  decideEffectiveScanMode,
  getExportFollowersFromDb,
  openMonitorDatabase
} from './collect-followers.mjs';

function follower(id, nickname) {
  return {
    id,
    uid: id.replace(/\D/g, '') || id,
    nickname,
    douyinId: '',
    profileUrl: `https://www.douyin.com/user/${id}`,
    rawText: [nickname]
  };
}

function baseOptions(overrides = {}) {
  return {
    mode: 'full',
    effectiveMode: 'full',
    modeReason: 'test',
    runId: `test-${Math.random().toString(36).slice(2)}`,
    confirmRemoveScans: 2,
    profileStats: { followers: 2 },
    ...overrides
  };
}

async function withDb(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-monitor-test-'));
  const db = await openMonitorDatabase(path.join(dir, 'followers.db'));
  try {
    await fn(db);
  } finally {
    closeMonitorDatabase(db);
    await rm(dir, { recursive: true, force: true });
  }
}

await withDb(async (db) => {
  const x = follower('sec-x', '用户 X');
  const y = follower('sec-y', '用户 Y');

  let result = applyScanToDatabase(db, baseOptions({ runId: 'run-a' }), [x, y]);
  assert.equal(result.change.newCount, 2);
  assert.equal(getExportFollowersFromDb(db).length, 2);
  assert.equal(db.prepare("SELECT status FROM followers WHERE id = 'sec-x'").get().status, 'active');

  result = applyScanToDatabase(db, baseOptions({ runId: 'run-incomplete', scanComplete: false }), [y]);
  assert.equal(result.change.suspectedRemovedCount, 0);
  assert.equal(db.prepare("SELECT status FROM followers WHERE id = 'sec-x'").get().status, 'active');

  result = applyScanToDatabase(db, baseOptions({ runId: 'run-b' }), [y]);
  assert.equal(result.change.suspectedRemovedCount, 1);
  assert.equal(result.change.removedCount, 0);
  assert.equal(db.prepare("SELECT status FROM followers WHERE id = 'sec-x'").get().status, 'suspected_removed');
  assert.equal(getExportFollowersFromDb(db).some((row) => row.id === 'sec-x'), false);

  result = applyScanToDatabase(db, baseOptions({ runId: 'run-c' }), [y]);
  assert.equal(result.change.suspectedRemovedCount, 0);
  assert.equal(result.change.removedCount, 1);
  assert.equal(db.prepare("SELECT status FROM followers WHERE id = 'sec-x'").get().status, 'removed');

  result = applyScanToDatabase(db, baseOptions({ runId: 'run-d' }), [x, y]);
  assert.equal(result.change.reappearedCount, 1);
  assert.equal(db.prepare("SELECT status FROM followers WHERE id = 'sec-x'").get().status, 'active');
});

await withDb(async (db) => {
  const monitorOptions = {
    mode: 'monitor',
    forceFull: false,
    fullIntervalHours: 24
  };

  assert.deepEqual(
    decideEffectiveScanMode(db, monitorOptions, { followers: 10 }),
    { mode: 'full', reason: 'no-full-baseline' }
  );

  db.prepare(`
    INSERT INTO scan_runs (
      runId, mode, requestedMode, startedAt, finishedAt, status,
      profileFollowerCount, enumerableCount, pagesFetched, reason
    ) VALUES (?, 'full', 'monitor', ?, ?, 'completed', 10, 10, 1, 'test')
  `).run('full-now', new Date().toISOString(), new Date().toISOString());

  assert.equal(decideEffectiveScanMode(db, monitorOptions, { followers: 10 }).mode, 'recent');
  assert.equal(decideEffectiveScanMode(db, monitorOptions, { followers: 9 }).reason, 'profile-followers-decreased');

  const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE scan_runs SET startedAt = ?, finishedAt = ? WHERE runId = 'full-now'").run(oldDate, oldDate);
  assert.equal(decideEffectiveScanMode(db, monitorOptions, { followers: 10 }).reason, 'full-interval-elapsed');
});

console.log('monitor state tests passed');
