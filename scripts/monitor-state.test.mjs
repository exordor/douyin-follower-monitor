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

function follower(id, nickname, relationshipStatus = 'unknown') {
  return {
    id,
    uid: id.replace(/\D/g, '') || id,
    nickname,
    douyinId: '',
    relationshipStatus,
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

async function verifyVersionOneMigration() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-monitor-v1-test-'));
  const dbPath = path.join(dir, 'followers.db');
  const { DatabaseSync } = await import('node:sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta (key, value) VALUES ('schema_version', '1');
    CREATE TABLE followers (
      id TEXT PRIMARY KEY,
      uid TEXT,
      nickname TEXT NOT NULL DEFAULT '',
      profileUrl TEXT NOT NULL DEFAULT '',
      firstSeenAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL,
      lastFullSeenAt TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      suspectedRemovedAt TEXT,
      removedAt TEXT,
      missingFullScans INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO followers (
      id, uid, nickname, profileUrl, firstSeenAt, lastSeenAt, status
    ) VALUES ('legacy-row', '', 'legacy', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'active');
  `);
  legacyDb.close();

  const migratedDb = await openMonitorDatabase(dbPath);
  try {
    assert.equal(migratedDb.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '2');
    const row = migratedDb.prepare("SELECT relationshipStatus, relationshipObservedAt FROM followers WHERE id = 'legacy-row'").get();
    assert.equal(row.relationshipStatus, 'unknown');
    assert.equal(row.relationshipObservedAt, null);
  } finally {
    closeMonitorDatabase(migratedDb);
    await rm(dir, { recursive: true, force: true });
  }
}

await verifyVersionOneMigration();

await withDb(async (db) => {
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '2');
  const columns = db.prepare('PRAGMA table_info(followers)').all().map((row) => row.name);
  assert.equal(columns.includes('relationshipStatus'), true);
  assert.equal(columns.includes('relationshipObservedAt'), true);

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
  applyScanToDatabase(db, baseOptions({ runId: 'relation-a' }), [
    follower('sec-mutual', '用户 M', 'mutual'),
    follower('sec-unknown', '用户 U')
  ]);

  const mutual = db.prepare("SELECT relationshipStatus, relationshipObservedAt FROM followers WHERE id = 'sec-mutual'").get();
  assert.equal(mutual.relationshipStatus, 'mutual');
  assert.ok(mutual.relationshipObservedAt);
  assert.equal(db.prepare("SELECT relationshipStatus FROM followers WHERE id = 'sec-unknown'").get().relationshipStatus, 'unknown');

  applyScanToDatabase(db, baseOptions({ runId: 'relation-b' }), [
    follower('sec-mutual', '用户 M', 'unknown'),
    follower('sec-unknown', '用户 U', 'follower_only')
  ]);

  assert.equal(db.prepare("SELECT relationshipStatus FROM followers WHERE id = 'sec-mutual'").get().relationshipStatus, 'mutual');
  assert.equal(db.prepare("SELECT relationshipStatus FROM followers WHERE id = 'sec-unknown'").get().relationshipStatus, 'follower_only');
});

await withDb(async (db) => {
  const mutual = follower('sec-mutual-remove', '用户 MR', 'mutual');
  const followerOnly = follower('sec-follower-only-remove', '用户 FR', 'follower_only');
  const stays = follower('sec-stays', '用户 S', 'unknown');

  applyScanToDatabase(db, baseOptions({ runId: 'mutual-baseline', profileStats: { followers: 3 } }), [mutual, followerOnly, stays]);

  let result = applyScanToDatabase(db, baseOptions({
    runId: 'mutual-incomplete',
    profileStats: { followers: 1 },
    scanComplete: false
  }), [stays]);
  assert.equal(result.change.suspectedRemovedCount, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM follower_events WHERE type = 'mutual_unfollowed_you'").get().count, 0);

  result = applyScanToDatabase(db, baseOptions({ runId: 'mutual-first-miss', profileStats: { followers: 1 } }), [stays]);
  assert.equal(result.change.suspectedRemovedCount, 2);
  assert.equal(result.change.mutualUnfollowedYouCount, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM follower_events WHERE type = 'mutual_unfollowed_you'").get().count, 0);

  result = applyScanToDatabase(db, baseOptions({ runId: 'mutual-confirmed', profileStats: { followers: 1 } }), [stays]);
  assert.equal(result.change.removedCount, 2);
  assert.equal(result.change.mutualUnfollowedYouCount, 1);
  const mutualEvents = db.prepare("SELECT followerId, type FROM follower_events WHERE type = 'mutual_unfollowed_you'").all()
    .map((row) => ({ followerId: row.followerId, type: row.type }));
  assert.deepEqual(mutualEvents, [{ followerId: 'sec-mutual-remove', type: 'mutual_unfollowed_you' }]);
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
