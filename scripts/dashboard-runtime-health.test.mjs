#!/usr/bin/env node

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildRuntimeHealth } from './dashboard-runtime-health.mjs';
import { createDashboardServer } from './serve-dashboard.mjs';

function cookieAuth(configured) {
  return {
    configured,
    exportedAt: configured ? '2026-05-29T00:00:00.000Z' : null,
    sourceUrl: configured ? 'https://www.douyin.com/user/self' : '',
    cookieCount: configured ? 89 : 0,
    acceptedCount: configured ? 61 : 0,
    skippedCount: configured ? 28 : 0,
    skippedReasons: [],
    updatedAt: configured ? '2026-05-29T00:00:00.000Z' : null,
    runtimeSupported: true
  };
}

function scanStatus(runtime, overrides = {}) {
  return {
    id: null,
    status: 'idle',
    mode: 'monitor',
    requestedMode: 'monitor',
    reason: '',
    startedAt: null,
    finishedAt: null,
    pagesFetched: 0,
    count: 0,
    profileFollowerCount: null,
    hiddenOrUnavailableCount: null,
    runtime,
    runtimeLabel: runtime === 'cdp' ? 'Chrome DevTools Protocol' : runtime === 'playwright' ? 'Playwright profile' : 'Apple Events browser',
    cookieAuth: null,
    phase: 'idle',
    authChallenge: null,
    exitCode: null,
    signal: null,
    error: '',
    logLines: [],
    changeSummary: null,
    partial: null,
    ...overrides
  };
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

function requestJson(port, method, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: body ? JSON.parse(body) : null });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const cdp = buildRuntimeHealth({ scanStatus: scanStatus('cdp'), cookieAuth: cookieAuth(false) });
assert.equal(cdp.level, 'ok');
assert.equal(cdp.recommendedRuntime, 'cdp');
assert.equal(cdp.headline, 'CDP 是当前推荐路径');

const playwrightNoCookie = buildRuntimeHealth({ scanStatus: scanStatus('playwright'), cookieAuth: cookieAuth(false) });
assert.equal(playwrightNoCookie.level, 'action');
assert.equal(playwrightNoCookie.checks.find((item) => item.id === 'cookie-auth')?.state, 'warn');

const playwrightCookie = buildRuntimeHealth({ scanStatus: scanStatus('playwright'), cookieAuth: cookieAuth(true) });
assert.equal(playwrightCookie.level, 'warning');
assert.equal(playwrightCookie.checks.find((item) => item.id === 'cookie-auth')?.state, 'pass');

const appleEvents = buildRuntimeHealth({ scanStatus: scanStatus('apple-events'), cookieAuth: { ...cookieAuth(false), runtimeSupported: false } });
assert.equal(appleEvents.level, 'ok');
assert.equal(appleEvents.recommendedRuntime, 'cdp');
assert.equal(appleEvents.checks.find((item) => item.id === 'cookie-auth')?.state, 'info');

const waiting = buildRuntimeHealth({
  scanStatus: scanStatus('playwright', {
    phase: 'waiting_for_verification',
    authChallenge: {
      kind: 'captcha',
      status: 'waiting',
      startedAt: '2026-05-29T00:00:00.000Z',
      deadlineAt: '2026-05-29T00:05:00.000Z',
      message: '浏览器触发了抖音验证码。'
    }
  }),
  cookieAuth: cookieAuth(true)
});
assert.equal(waiting.level, 'action');
assert.equal(waiting.checks.find((item) => item.id === 'verification')?.state, 'fail');
assert.equal(JSON.stringify(waiting).includes('secret'), false);
assert.equal(JSON.stringify(waiting).includes('/Users/'), false);

const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-runtime-health-test-'));
const port = await getFreePort();
const server = createDashboardServer({
  db: path.join(dir, 'followers.db'),
  outDir: dir,
  port,
  host: '127.0.0.1',
  staticDir: path.resolve('web/dist'),
  scanManager: {
    async status() {
      return scanStatus('cdp');
    },
    async start() {
      return { statusCode: 202, body: { status: scanStatus('cdp') } };
    },
    async stop() {
      return { statusCode: 200, body: { status: scanStatus('cdp') } };
    },
    async subscribe(_req, res) {
      res.end();
    }
  }
});

await listen(server, port, '127.0.0.1');
try {
  const response = await requestJson(port, 'GET', '/api/runtime/health');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.level, 'ok');
  assert.equal(response.body.runtime, 'cdp');
  assert.equal(JSON.stringify(response.body).includes('douyin-cookies.json'), false);

  const wrongMethod = await requestJson(port, 'POST', '/api/runtime/health');
  assert.equal(wrongMethod.statusCode, 405);
} finally {
  await close(server);
  await rm(dir, { recursive: true, force: true });
}

console.log('dashboard runtime health tests passed');
