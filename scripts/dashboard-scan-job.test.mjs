#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { createScanJobManager } from './dashboard-scan-job.mjs';
import { createDashboardServer } from './serve-dashboard.mjs';

const EVENT_PREFIX = '__DOUYIN_MONITOR_EVENT__ ';

function monitorEvent(type, payload = {}) {
  return `${EVENT_PREFIX}${JSON.stringify({ type, ...payload })}\n`;
}

function createFakeSpawn() {
  const children = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.command = command;
    child.args = args;
    child.killSignal = null;
    child.kill = (signal) => {
      child.killSignal = signal;
      setTimeout(() => child.emit('exit', 143, signal), 5);
      return true;
    };
    children.push(child);
    setTimeout(() => {
      const startedAt = '2026-05-29T00:00:00.000Z';
      const deadlineAt = '2026-05-29T00:05:00.000Z';
      child.stdout.write('Runtime: Chrome DevTools Protocol (cdp)\n');
      child.stdout.write(monitorEvent('auth_wait_started', {
        kind: 'captcha',
        status: 'waiting',
        startedAt,
        deadlineAt,
        message: '浏览器触发了抖音验证码。请在打开的浏览器窗口中手动完成验证，并确认进入自己的抖音主页。'
      }));
    }, 10);
    setTimeout(() => {
      child.stdout.write(monitorEvent('auth_wait_transient_navigation', {
        kind: 'captcha',
        status: 'waiting',
        startedAt: '2026-05-29T00:00:00.000Z',
        deadlineAt: '2026-05-29T00:05:00.000Z',
        message: '页面正在跳转或验证中，继续等待。'
      }));
    }, 20);
    setTimeout(() => {
      child.stdout.write(monitorEvent('auth_wait_resolved', {
        kind: 'captcha',
        status: 'resolved',
        startedAt: '2026-05-29T00:00:00.000Z',
        deadlineAt: '2026-05-29T00:05:00.000Z',
        message: '人工登录/验证已完成，继续采集。'
      }));
      child.stdout.write('人工登录/验证已完成，继续采集。\n');
    }, 30);
    setTimeout(() => {
      child.stdout.write('扫描模式: full (profile-followers-decreased)\n');
      child.stdout.write('API 第 1 页: 本页 20，累计 20，hasMore=true\n');
      child.stdout.write('已保存进度: 20 -> /tmp/latest.partial.json\n');
    }, 45);
    return child;
  };
  return { spawnImpl, children };
}

function listen(server, port, host) {
  return new Promise((resolve) => server.listen(port, host, resolve));
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

function requestJson(port, method, pathname, headers = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        ...headers,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body: body ? JSON.parse(body) : null
        });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function waitForSse(port, predicate) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/api/scan/events',
      headers: { accept: 'text/event-stream' }
    }, (res) => {
      let buffer = '';
      const timeout = setTimeout(() => {
        req.destroy();
        reject(new Error('Timed out waiting for SSE status'));
      }, 5000);

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const event of events) {
          const dataLine = event.split('\n').find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          const payload = dataLine.slice('data: '.length);
          if (!payload.startsWith('{')) continue;
          const parsed = JSON.parse(payload);
          if (predicate(parsed)) {
            clearTimeout(timeout);
            res.destroy();
            req.destroy();
            resolve(parsed);
          }
        }
      });
    });
    req.on('error', reject);
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-scan-job-test-'));
await mkdir(path.join(dir, 'in-progress'), { recursive: true });
await mkdir(path.join(dir, 'auth'), { recursive: true });
const cookieFile = path.join(dir, 'auth', 'douyin-cookies.json');
const cookieContent = JSON.stringify({
  format: 'local-cookie-manager-v1',
  exportedAt: '2026-05-29T00:00:00.000Z',
  sourceUrl: 'https://www.douyin.com/user/self',
  scope: { type: 'current-tab-url', origin: 'https://www.douyin.com', url: 'https://www.douyin.com/user/self' },
  redacted: false,
  cookieCount: 1,
  cookies: [{
    name: 'sessionid',
    value: 'secret',
    domain: '.douyin.com',
    hostOnly: false,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'no_restriction',
    session: true,
    storeId: '0'
  }]
});
await writeFile(cookieFile, cookieContent);
await writeFile(path.join(dir, 'in-progress', 'latest.partial.json'), JSON.stringify({
  collectedAt: '2001-01-01T00:00:00.000Z',
  status: 'completed',
  mode: 'full',
  reason: 'stale-partial',
  pagesFetched: 41,
  count: 803,
  profileStats: { followers: 803 }
}));
const { spawnImpl, children } = createFakeSpawn();
const manager = createScanJobManager({
  rootDir: process.cwd(),
  db: path.join(dir, 'followers.db'),
  outDir: dir,
  runtime: 'cdp',
  cdpUrl: 'http://127.0.0.1:9222',
  spawnImpl
});

const port = await getFreePort();
const server = createDashboardServer({
  db: path.join(dir, 'followers.db'),
  outDir: dir,
  port,
  host: '127.0.0.1',
  staticDir: path.resolve('web/dist'),
  scanManager: manager
});

await listen(server, port, '127.0.0.1');

try {
  const forbidden = await requestJson(port, 'POST', '/api/scan/start', {
    origin: 'https://example.com',
    'x-douyin-dashboard-action': 'scan'
  });
  assert.equal(forbidden.statusCode, 403);

  const missingHeader = await requestJson(port, 'POST', '/api/scan/start');
  assert.equal(missingHeader.statusCode, 403);

  const authStatus = await requestJson(port, 'GET', '/api/auth/cookies/status');
  assert.equal(authStatus.statusCode, 200);
  assert.equal(authStatus.body.configured, true);
  assert.equal(authStatus.body.acceptedCount, 1);
  assert.equal(JSON.stringify(authStatus.body).includes('secret'), false);

  const scanConfig = await requestJson(port, 'GET', '/api/scan/config');
  assert.equal(scanConfig.statusCode, 200);
  assert.equal(scanConfig.body.runtime, 'cdp');
  assert.equal(scanConfig.body.mode, 'monitor');
  assert.equal(scanConfig.body.cdpUrl, 'http://127.0.0.1:9222');

  const updatedConfig = await requestJson(port, 'POST', '/api/scan/config', {
    'x-douyin-dashboard-action': 'scan'
  }, { mode: 'recent', runtime: 'cdp', cdpUrl: 'http://localhost:9222/' });
  assert.equal(updatedConfig.statusCode, 200);
  assert.equal(updatedConfig.body.config.mode, 'recent');
  assert.equal(updatedConfig.body.config.runtime, 'cdp');
  assert.equal(updatedConfig.body.config.cdpUrl, 'http://localhost:9222');

  const invalidConfig = await requestJson(port, 'POST', '/api/scan/config', {
    'x-douyin-dashboard-action': 'scan'
  }, { runtime: 'shell' });
  assert.equal(invalidConfig.statusCode, 400);

  const importForbidden = await requestJson(port, 'POST', '/api/auth/cookies/import', {
    origin: 'https://example.com',
    'x-douyin-dashboard-action': 'auth'
  }, { filename: 'cookies.json', content: cookieContent });
  assert.equal(importForbidden.statusCode, 403);

  const ssePromise = waitForSse(port, (status) => status.status === 'running' || status.count >= 20);
  const authWaitSsePromise = waitForSse(port, (status) => status.phase === 'waiting_for_verification');
  const started = await requestJson(port, 'POST', '/api/scan/start', {
    'x-douyin-dashboard-action': 'scan'
  });
  assert.equal(started.statusCode, 202);
  assert.equal(started.body.status.phase, 'authenticating');

  const duplicate = await requestJson(port, 'POST', '/api/scan/start', {
    'x-douyin-dashboard-action': 'scan'
  });
  assert.equal(duplicate.statusCode, 409);

  const lockedConfig = await requestJson(port, 'POST', '/api/scan/config', {
    'x-douyin-dashboard-action': 'scan'
  }, { mode: 'full' });
  assert.equal(lockedConfig.statusCode, 409);

  const eventStatus = await ssePromise;
  assert.equal(['running', 'starting'].includes(eventStatus.status), true);

  const authWaitStatus = await authWaitSsePromise;
  assert.equal(authWaitStatus.authChallenge.kind, 'captcha');
  assert.equal(authWaitStatus.authChallenge.status, 'waiting');
  assert.equal(authWaitStatus.authChallenge.deadlineAt, '2026-05-29T00:05:00.000Z');

  const parsed = await waitFor(async () => {
    const current = await manager.status();
    return current.count >= 20 ? current : null;
  });
  assert.equal(parsed.runtime, 'cdp');
  assert.equal(parsed.runtimeLabel, 'Chrome DevTools Protocol');
  assert.equal(parsed.mode, 'full');
  assert.equal(parsed.reason, 'profile-followers-decreased');
  assert.equal(parsed.pagesFetched, 1);
  assert.equal(parsed.count, 20);
  assert.equal(parsed.phase, 'scanning');
  assert.equal(parsed.authChallenge.status, 'resolved');
  assert.notEqual(parsed.reason, 'stale-partial');

  const stopped = await requestJson(port, 'POST', '/api/scan/stop', {
    'x-douyin-dashboard-action': 'scan'
  });
  assert.equal(stopped.statusCode, 202);

  const finalStatus = await waitFor(async () => {
    const current = await manager.status();
    return current.status === 'interrupted' ? current : null;
  });
  assert.equal(finalStatus.signal, 'SIGTERM');
  assert.equal(finalStatus.phase, 'interrupted');
  assert.equal(children[0].killSignal, 'SIGTERM');
  assert.deepEqual(children[0].args.slice(0, 7), [
    '--disable-warning=ExperimentalWarning',
    path.join(process.cwd(), 'scripts', 'collect-followers.mjs'),
    '--runtime',
    'cdp',
    '--api',
    '--mode',
    'recent'
  ]);
  assert.deepEqual(children[0].args.slice(7, 10), [
    '--auth-wait-seconds',
    '300',
    '--db'
  ]);
  assert.equal(children[0].args.includes('--cdp-url'), true);
  assert.equal(children[0].args.includes('--cookie-file'), true);
  assert.equal(children[0].args.includes(cookieFile), true);

  const cleared = await requestJson(port, 'DELETE', '/api/auth/cookies', {
    'x-douyin-dashboard-action': 'auth'
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.body.configured, false);
} finally {
  await close(server);
  await rm(dir, { recursive: true, force: true });
}

console.log('dashboard scan job tests passed');
