#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createBrowserRuntime, resolveBrowserRuntimeConfig } from './browser-runtime.mjs';

const emptyEnv = {};

assert.deepEqual(resolveBrowserRuntimeConfig({
  runtime: 'auto',
  profile: '/tmp/profile'
}, emptyEnv), {
  requestedRuntime: 'auto',
  runtime: 'playwright',
  runtimeLabel: 'Playwright profile',
  browserApp: '',
  cdpUrl: '',
  profile: '/tmp/profile',
  cookieFile: ''
});

assert.deepEqual(resolveBrowserRuntimeConfig({
  runtime: 'auto',
  browserApp: 'com.bot.pc.doubao.browser',
  profile: '/tmp/profile'
}, emptyEnv), {
  requestedRuntime: 'auto',
  runtime: 'apple-events',
  runtimeLabel: 'Apple Events browser',
  browserApp: 'com.bot.pc.doubao.browser',
  cdpUrl: '',
  profile: '/tmp/profile',
  cookieFile: ''
});

assert.deepEqual(resolveBrowserRuntimeConfig({
  runtime: 'auto',
  cdpUrl: 'http://127.0.0.1:9222',
  profile: '/tmp/profile'
}, emptyEnv), {
  requestedRuntime: 'auto',
  runtime: 'cdp',
  runtimeLabel: 'Chrome DevTools Protocol',
  browserApp: '',
  cdpUrl: 'http://127.0.0.1:9222',
  profile: '/tmp/profile',
  cookieFile: ''
});

assert.equal(resolveBrowserRuntimeConfig({
  runtime: 'playwright',
  browserApp: 'com.bot.pc.doubao.browser',
  profile: '/tmp/profile'
}, emptyEnv).runtime, 'playwright');

assert.throws(() => resolveBrowserRuntimeConfig({ runtime: 'cdp' }, emptyEnv), /requires --cdp-url/);
assert.throws(() => resolveBrowserRuntimeConfig({ runtime: 'apple-events' }, emptyEnv), /requires --browser-app/);
assert.throws(() => resolveBrowserRuntimeConfig({
  runtime: 'apple-events',
  browserApp: 'com.bot.pc.doubao.browser',
  cookieFile: '/tmp/cookies.json'
}, emptyEnv), /不支持 --cookie-file/);
assert.throws(() => resolveBrowserRuntimeConfig({ runtime: 'unknown' }, emptyEnv), /--runtime/);

const playwrightRuntime = await createBrowserRuntime({
  runtime: 'playwright',
  profile: path.join('/tmp', 'douyin-runtime-test')
}, emptyEnv);
assert.equal(playwrightRuntime.name, 'playwright');
assert.equal(playwrightRuntime.label, 'Playwright profile');

const cdpRuntime = await createBrowserRuntime({
  runtime: 'cdp',
  cdpUrl: 'http://127.0.0.1:9222'
}, emptyEnv);
assert.equal(cdpRuntime.name, 'cdp');
assert.equal(cdpRuntime.label, 'Chrome DevTools Protocol');

const appleRuntime = await createBrowserRuntime({
  runtime: 'apple-events',
  browserApp: 'com.bot.pc.doubao.browser'
}, emptyEnv);
assert.equal(appleRuntime.name, 'apple-events');
assert.equal(appleRuntime.label, 'Apple Events browser');

const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-runtime-cookie-test-'));
try {
  const cookieFile = path.join(dir, 'cookies.json');
  await writeFile(cookieFile, JSON.stringify({
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
  }));

  const added = [];
  const runtime = await createBrowserRuntime({
    runtime: 'playwright',
    profile: path.join(dir, 'profile'),
    cookieFile
  }, emptyEnv);
  runtime.context = { addCookies: async (cookies) => added.push(...cookies), pages: () => [] };
  await runtime.applyCookieAuth();
  assert.equal(added.length, 1);
  assert.equal(added[0].name, 'sessionid');
  assert.equal(runtime.cookieAuthSummary.acceptedCount, 1);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('browser runtime tests passed');
