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

  // A CDP endpoint may reject browser-level Storage commands while supporting
  // page-level Network commands. Keep the same context and surface real errors.
  for (const failure of ['', 'Browser context management is not supported.', 'Target closed']) {
    const cdp = await createBrowserRuntime({ runtime: 'cdp', cdpUrl: 'http://127.0.0.1:9222', cookieFile }, emptyEnv);
    const calls = [];
    const page = {};
    cdp.browser = {};
    cdp.context = {
      pages: () => [page],
      addCookies: async () => { if (failure) throw new Error(failure); },
      newCDPSession: async target => {
        assert.equal(target, page);
        return {
          send: async (method, params) => calls.push({ method, params }),
          detach: async () => calls.push('detach')
        };
      }
    };
    if (failure === 'Target closed') {
      await assert.rejects(cdp.applyCookieAuth(), /Target closed/);
      assert.equal(cdp.cookiesApplied, false);
      assert.deepEqual(calls, []);
    } else {
      await cdp.applyCookieAuth();
      assert.equal(cdp.cookiesApplied, true);
      assert.equal(cdp.cookieAuthSummary.acceptedCount, 1);
      if (failure) {
        assert.equal(calls[0].method, 'Network.setCookies');
        assert.equal(calls[0].params.cookies[0].name, 'sessionid');
        assert.equal(calls[0].params.cookies[0].httpOnly, true);
        assert.equal(calls[1], 'detach');
      } else assert.deepEqual(calls, []);
      const count = calls.length;
      await cdp.applyCookieAuth();
      assert.equal(calls.length, count);
    }
  }

  const failedCdp = await createBrowserRuntime({ runtime: 'cdp', cdpUrl: 'http://127.0.0.1:9222', cookieFile }, emptyEnv);
  let detached = false;
  let created = false;
  const fallbackPage = {};
  failedCdp.browser = {};
  failedCdp.context = {
    addCookies: async () => { throw new Error('Browser context management is not supported.'); },
    pages: () => [],
    newPage: async () => { created = true; return fallbackPage; },
    newCDPSession: async page => {
      assert.equal(page, fallbackPage);
      return {
        send: async () => { throw new Error('Network cookie write failed'); },
        detach: async () => { detached = true; }
      };
    }
  };
  await assert.rejects(failedCdp.applyCookieAuth(), /Network cookie write failed/);
  assert.equal(failedCdp.cookiesApplied, false);
  assert.equal(detached, true);
  assert.equal(created, true);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('browser runtime tests passed');
