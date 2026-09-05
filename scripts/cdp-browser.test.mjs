import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import * as cdp from './cdp-browser.mjs';
import { createDashboardServer } from './serve-dashboard.mjs';
import { chromium } from 'playwright';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

assert.equal(typeof cdp.ensureCdpBrowser, 'function', 'CDP readiness must auto-start a dedicated browser');
const server = createServer((req, res) => res.end(JSON.stringify({ Browser: 'Chrome/140', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/test` })));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
try {
  assert.equal((await cdp.ensureCdpBrowser(url)).launched, false);
} finally { await new Promise(resolve => server.close(resolve)); }

const occupied = createServer((req, res) => res.end('another app'));
await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
try {
  await assert.rejects(cdp.ensureCdpBrowser(`http://127.0.0.1:${occupied.address().port}`), /端口.*占用/);
} finally { await new Promise(resolve => occupied.close(resolve)); }
await assert.rejects(cdp.ensureCdpBrowser('http://example.com:9222'), /本机/);
await assert.rejects(cdp.ensureCdpBrowser(url, { executablePath: '/nonexistent/chrome' }), /Chrome.*安装|Chrome.*路径/);

let launches = 0;
const child = new EventEmitter();
child.unref = () => {};
const opts = {
  executablePath: process.execPath,
  profileDir: '/tmp/douyin-test-profile',
  spawnImpl(executable, args, options) {
    launches++;
    assert.equal(executable, process.execPath);
    assert.ok(args.includes('--user-data-dir=/tmp/douyin-test-profile'));
    assert.ok(args.includes('--profile-directory=Default'), 'restart must not select another last-used Chrome profile');
    assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
    assert.equal(options.shell, false);
    setTimeout(() => server.listen(Number(new URL(url).port), '127.0.0.1'), 30);
    return child;
  }
};
try {
  const results = await Promise.all([cdp.ensureCdpBrowser(url, opts), cdp.ensureCdpBrowser(url, opts)]);
  assert.ok(results.every(result => result.launched));
  assert.equal(launches, 1, 'concurrent requests must share one launch');
} finally { await new Promise(resolve => server.close(resolve)); }
console.log('cdp-browser tests passed');

const temp = await mkdtemp(path.join(os.tmpdir(), 'cdp-cookie-test-'));
const cookieFile = path.join(temp, 'cookies.json');
await writeFile(cookieFile, JSON.stringify({ format: 'local-cookie-manager-v1', redacted: false, cookies: [{ name: 'cdp_test', value: 'synthetic', domain: '.douyin.com', path: '/', secure: true, session: true }] }));
const dashboard = createDashboardServer({ runtime: 'playwright', cookieFile });
await new Promise(resolve => dashboard.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${dashboard.address().port}`;
const headers = { 'x-douyin-dashboard-action': 'scan', 'content-type': 'application/json' };
try {
  assert.equal((await fetch(`${base}/api/scan/browser`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${base}/api/scan/browser`)).status, 405);
  assert.equal((await fetch(`${base}/api/scan/browser`, { method: 'POST', headers: { ...headers, origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/scan/browser`, { method: 'POST', headers })).status, 409);
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${new URL(url).port}`] });
  const connection = await chromium.connectOverCDP(url);
  const context = connection.contexts()[0];
  let authenticatedRequest = false;
  await context.route('https://www.douyin.com/**', async route => {
    authenticatedRequest = (await route.request().allHeaders()).cookie?.includes('cdp_test=synthetic') || false;
    await route.fulfill({ body: '<html><body>test</body></html>', contentType: 'text/html' });
  });
  try {
    const page = await context.newPage();
    await page.goto('https://www.douyin.com/user/self');
    await fetch(`${base}/api/scan/config`, { method: 'POST', headers, body: JSON.stringify({ runtime: 'cdp', cdpUrl: url }) });
    const opened = await fetch(`${base}/api/scan/browser`, { method: 'POST', headers });
    assert.equal(opened.status, 200);
    assert.equal((await opened.json()).cookieApplied, true);
    assert.equal(authenticatedRequest, true, 'manual open must apply saved cookies and refresh an already open target');
  } finally { await connection.close(); await browser.close(); }
} finally {
  await new Promise(resolve => dashboard.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
