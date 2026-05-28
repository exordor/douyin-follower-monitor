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

function createFakeSpawn() {
  const children = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killSignal = null;
    child.kill = (signal) => {
      child.killSignal = signal;
      setTimeout(() => child.emit('exit', 143, signal), 5);
      return true;
    };
    children.push(child);
    setTimeout(() => {
      child.stdout.write('扫描模式: full (profile-followers-decreased)\n');
      child.stdout.write('API 第 1 页: 本页 20，累计 20，hasMore=true\n');
      child.stdout.write('已保存进度: 20 -> /tmp/latest.partial.json\n');
    }, 10);
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

function requestJson(port, method, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers
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
    req.end();
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
  spawnImpl,
  focusBrowser: false
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

  const ssePromise = waitForSse(port, (status) => status.status === 'running' || status.count >= 20);
  const started = await requestJson(port, 'POST', '/api/scan/start', {
    'x-douyin-dashboard-action': 'scan'
  });
  assert.equal(started.statusCode, 202);

  const duplicate = await requestJson(port, 'POST', '/api/scan/start', {
    'x-douyin-dashboard-action': 'scan'
  });
  assert.equal(duplicate.statusCode, 409);

  const eventStatus = await ssePromise;
  assert.equal(['running', 'starting'].includes(eventStatus.status), true);

  const parsed = await waitFor(async () => {
    const current = await manager.status();
    return current.count >= 20 ? current : null;
  });
  assert.equal(parsed.mode, 'full');
  assert.equal(parsed.reason, 'profile-followers-decreased');
  assert.equal(parsed.pagesFetched, 1);
  assert.equal(parsed.count, 20);
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
  assert.equal(children[0].killSignal, 'SIGTERM');
} finally {
  await close(server);
  await rm(dir, { recursive: true, force: true });
}

console.log('dashboard scan job tests passed');
