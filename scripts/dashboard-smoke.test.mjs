#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

import {
  applyScanToDatabase,
  closeMonitorDatabase,
  openMonitorDatabase
} from './collect-followers.mjs';
import { createDashboardServer } from './serve-dashboard.mjs';

function follower(id, nickname) {
  return {
    id,
    uid: id.replace(/\D/g, '') || id,
    nickname,
    profileUrl: `https://www.douyin.com/user/${id}`
  };
}

function scanOptions(runId, profileFollowerCount = 4) {
  return {
    mode: 'full',
    effectiveMode: 'full',
    modeReason: 'smoke',
    runId,
    confirmRemoveScans: 2,
    profileStats: { followers: profileFollowerCount }
  };
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

function listen(server, port, host) {
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve());
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function getFreePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function buildFixture(dbPath) {
  const db = await openMonitorDatabase(dbPath);
  try {
    applyScanToDatabase(db, scanOptions('smoke-a', 4), [
      follower('sec-a', '晨间剪辑师'),
      follower('sec-b', '山城记录员'),
      follower('sec-c', '深夜数据台')
    ]);
    db.prepare(`
      INSERT INTO scan_runs (
        runId, mode, requestedMode, startedAt, finishedAt, status,
        profileFollowerCount, enumerableCount, pagesFetched, reason
      ) VALUES ('smoke-a', 'full', 'monitor', ?, ?, 'completed', 4, 3, 1, 'no-full-baseline')
    `).run(new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() - 86400000).toISOString());

    applyScanToDatabase(db, scanOptions('smoke-b', 4), [
      follower('sec-a', '晨间剪辑师'),
      follower('sec-b', '山城记录员')
    ]);
    db.prepare(`
      INSERT INTO scan_runs (
        runId, mode, requestedMode, startedAt, finishedAt, status,
        profileFollowerCount, enumerableCount, pagesFetched, reason
      ) VALUES ('smoke-b', 'full', 'monitor', ?, ?, 'completed', 4, 2, 1, 'profile-followers-decreased')
    `).run(new Date().toISOString(), new Date().toISOString());
  } finally {
    closeMonitorDatabase(db);
  }
}

await runCommand('npm', ['run', 'dashboard:build']);

const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-dashboard-smoke-'));
const dbPath = path.join(dir, 'followers.db');
const outDir = path.join(dir, 'data');
await buildFixture(dbPath);

const port = await getFreePort();
const server = createDashboardServer({
  db: dbPath,
  outDir,
  port,
  host: '127.0.0.1',
  staticDir: path.resolve('web/dist')
});
await listen(server, port, '127.0.0.1');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const consoleErrors = trackConsoleErrors(page);
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
  assert.deepEqual(consoleErrors, []);
  await expectText(page, '粉丝变化仪表盘');
  await expectText(page, '可枚举粉丝');
  await expectText(page, '粉丝趋势');
  await expectText(page, '粉丝事件');
  await expectText(page, '晨间剪辑师');
  assert.equal(await page.locator('svg.chart').count() >= 2, true);
  assert.equal(await page.locator('table').count() >= 3, true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle' });
  await expectText(page, '粉丝变化仪表盘');
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 2), true);
} finally {
  await browser.close();
  await close(server);
  await rm(dir, { recursive: true, force: true });
}

async function expectText(page, text) {
  await page.getByText(text, { exact: false }).first().waitFor({ timeout: 5000 });
}

function trackConsoleErrors(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

console.log('dashboard smoke tests passed');
