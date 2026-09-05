#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createBrowserRuntime, resolveBrowserRuntimeConfig } from './browser-runtime.mjs';
import * as runtimeModule from './browser-runtime.mjs';

assert.equal(typeof runtimeModule.requirePersistentCdpContext, 'function');
assert.throws(() => runtimeModule.requirePersistentCdpContext({ contexts: () => [] }), /持久/);
const persistentContext = {};
assert.equal(runtimeModule.requirePersistentCdpContext({ contexts: () => [persistentContext] }), persistentContext);

const emptyEnv = {};

assert.deepEqual(resolveBrowserRuntimeConfig({
  runtime: 'auto',
  profile: '/tmp/profile'
}, emptyEnv), {
  requestedRuntime: 'auto',
  runtime: 'playwright',
  runtimeLabel: 'Playwright profile',
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
  cdpUrl: 'http://127.0.0.1:9222',
  profile: '/tmp/profile',
  cookieFile: ''
});

assert.throws(() => resolveBrowserRuntimeConfig({ runtime: 'cdp' }, emptyEnv), /requires --cdp-url/);
assert.throws(() => resolveBrowserRuntimeConfig({ runtime: 'apple-events' }, emptyEnv), /--runtime must be one of/);
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
