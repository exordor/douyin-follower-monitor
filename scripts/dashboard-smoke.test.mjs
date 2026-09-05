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
const missingRunResponse = await fetch(`http://127.0.0.1:${port}/api/runs/missing-run`);
assert.equal(missingRunResponse.status, 404);
const attackerRunEvents = await fetch(`http://127.0.0.1:${port}/api/runs/smoke-a/events`, {
  headers: { origin: 'https://attacker.example' }
});
assert.equal(attackerRunEvents.status, 403);
assert.equal(attackerRunEvents.headers.get('access-control-allow-origin'), null);
const attackerCompare = await fetch(`http://127.0.0.1:${port}/api/compare?from=smoke-a&to=smoke-b`, {
  headers: { origin: 'https://attacker.example' }
});
assert.equal(attackerCompare.status, 403);
const loopbackRunEvents = await fetch(`http://127.0.0.1:${port}/api/runs/smoke-a/events`, {
  headers: { origin: 'http://127.0.0.1:5173' }
});
assert.equal(loopbackRunEvents.status, 200);
assert.equal(loopbackRunEvents.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const consoleErrors = trackConsoleErrors(page);
  await page.route('**/api/summary', async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.fulfill({ response });
  });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
  assert.deepEqual(consoleErrors, []);
  await page.getByRole('heading', { name: '概览', exact: true }).waitFor();
  assert.equal(await page.locator('#events').count(), 0);
  assert.equal(await page.locator('#setup').count(), 0);
  await expectText(page, '可枚举粉丝');
  await expectText(page, '粉丝趋势');
  assert.equal(await page.locator('svg.chart').count() >= 2, true);
  await page.getByRole('link', { name: '关系事件', exact: true }).click();
  await page.locator('#events').waitFor();
  assert.equal(await page.locator('#overview').count(), 0);
  assert.equal(await page.locator('#followers').count(), 0);
  assert.equal(await page.locator('#events select').first().inputValue(), 'mutual_unfollowed_you');
  assert.equal(await page.locator('#events tbody tr').count(), 0, 'Late overview must not replace the selected mutual-event results');
  await page.locator('#events select').first().selectOption('');
  await expectText(page, '粉丝事件');
  await expectText(page, '晨间剪辑师');
  await page.getByRole('link', { name: '粉丝列表', exact: true }).click();
  await page.locator('#followers').waitFor();
  await page.goBack();
  await page.locator('#events').waitFor();
  assert.equal(await page.locator('#events select').first().inputValue(), '');
  await page.getByRole('link', { name: '采集设置', exact: true }).click();
  await expectText(page, 'Runtime 健康');
  await page.getByRole('button', { name: 'CDP', exact: true }).click();
  await page.route('**/api/scan/browser', route => route.fulfill({ json: { launched: false, message: '采集浏览器已连接，可继续采集。' } }));
  await page.getByRole('button', { name: '打开采集浏览器', exact: true }).click({ timeout: 3000 });
  await expectText(page, '采集浏览器已连接，可继续采集。');
  await page.getByText('连接帮助与首次设置', { exact: true }).click();
  await expectText(page, 'Setup / 快速开始');
  await expectText(page, 'Run detail');
  await page.getByRole('button', { name: /对比/ }).click();
  await expectText(page, 'Added');

  for (const width of [1920, 2560]) {
    await page.setViewportSize({ width, height: 1080 });
    for (const name of ['概览', '关系事件', '粉丝列表', '采集设置']) {
      await page.getByRole('link', { name, exact: true }).click();
      const layout = await page.locator('.main').evaluate(main => ({
        right: main.getBoundingClientRect().right,
        viewport: document.documentElement.clientWidth,
        overflow: document.body.scrollWidth > window.innerWidth + 2
      }));
      assert.ok(Math.abs(layout.viewport - layout.right) <= 2, `${name} must fill remaining browser width at ${width}px`);
      assert.equal(layout.overflow, false);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '采集设置', exact: true }).waitFor();
  assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 2), true);
  for (const name of ['概览', '关系事件', '粉丝列表']) {
    await page.getByRole('link', { name, exact: true }).click();
    await page.getByRole('heading', { name, exact: true, level: 1 }).waitFor();
    assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 2), true, `${name} must fit mobile viewport`);
  }
  await page.goto(`http://127.0.0.1:${port}/#runs`);
  await page.getByRole('heading', { name: '采集设置', exact: true }).waitFor();
  await page.goto(`http://127.0.0.1:${port}/#unknown`);
  await page.getByRole('heading', { name: '概览', exact: true }).waitFor();

  const waitingPort = await getFreePort();
  const waitingServer = createDashboardServer({
    db: dbPath,
    outDir,
    port: waitingPort,
    host: '127.0.0.1',
    staticDir: path.resolve('web/dist'),
    scanManager: createWaitingScanManager()
  });
  await listen(waitingServer, waitingPort, '127.0.0.1');
  try {
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(`http://127.0.0.1:${waitingPort}`, { waitUntil: 'domcontentloaded' });
    await expectText(page, '等待验证');
    await page.getByRole('link', { name: '采集设置', exact: true }).click();
    await expectText(page, '等待验证码');
    await expectText(page, '剩余');
    await expectText(page, '不会自动识别或绕过验证码');
    assert.equal(await page.getByRole('button', { name: '中止采集' }).count() >= 1, true);
  } finally {
    await page.goto('about:blank').catch(() => {});
    await close(waitingServer);
  }
} finally {
  await browser.close();
  if (server.listening) await close(server);
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

function createWaitingScanManager() {
  const status = {
    id: 'scan-waiting',
    status: 'running',
    mode: 'monitor',
    requestedMode: 'monitor',
    reason: '',
    startedAt: '2026-05-29T00:00:00.000Z',
    finishedAt: null,
    pagesFetched: 0,
    count: 0,
    profileFollowerCount: null,
    hiddenOrUnavailableCount: null,
    runtime: 'playwright',
    runtimeLabel: 'Playwright profile',
    cookieAuth: {
      configured: true,
      exportedAt: '2026-05-29T00:00:00.000Z',
      sourceUrl: 'https://www.douyin.com/user/self',
      cookieCount: 89,
      acceptedCount: 61,
      skippedCount: 28,
      skippedReasons: [],
      updatedAt: '2026-05-29T00:00:00.000Z',
      runtimeSupported: true
    },
    phase: 'waiting_for_verification',
    authChallenge: {
      kind: 'captcha',
      status: 'waiting',
      startedAt: '2026-05-29T00:00:00.000Z',
      deadlineAt: new Date(Date.now() + 300000).toISOString(),
      message: '浏览器触发了抖音验证码。请在打开的浏览器窗口中手动完成验证，并确认进入自己的抖音主页。'
    },
    exitCode: null,
    signal: null,
    error: '',
    logLines: ['浏览器触发了抖音验证码。正在等待人工处理。'],
    changeSummary: null,
    partial: null
  };

  return {
    async status() {
      return status;
    },
    async start() {
      return { statusCode: 409, body: { error: 'scan-already-running', status } };
    },
    async stop() {
      return { statusCode: 202, body: { status: { ...status, status: 'stopping', phase: 'stopping' } } };
    },
    async subscribe(_req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive'
      });
      res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
    }
  };
}

console.log('dashboard smoke tests passed');
