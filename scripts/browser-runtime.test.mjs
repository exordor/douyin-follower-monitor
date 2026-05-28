#!/usr/bin/env node

import assert from 'node:assert/strict';
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
  profile: '/tmp/profile'
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
  profile: '/tmp/profile'
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
  profile: '/tmp/profile'
});

assert.equal(resolveBrowserRuntimeConfig({
  runtime: 'playwright',
  browserApp: 'com.bot.pc.doubao.browser',
  profile: '/tmp/profile'
}, emptyEnv).runtime, 'playwright');

assert.throws(() => resolveBrowserRuntimeConfig({ runtime: 'cdp' }, emptyEnv), /requires --cdp-url/);
assert.throws(() => resolveBrowserRuntimeConfig({ runtime: 'apple-events' }, emptyEnv), /requires --browser-app/);
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

console.log('browser runtime tests passed');
