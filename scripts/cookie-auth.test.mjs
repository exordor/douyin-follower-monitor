#!/usr/bin/env node

import assert from 'node:assert/strict';

import { parseCookieAuthContent } from './cookie-auth.mjs';

const future = Math.floor(Date.parse('2030-01-01T00:00:00.000Z') / 1000);
const baseExport = {
  format: 'local-cookie-manager-v1',
  exportedAt: '2026-05-29T00:00:00.000Z',
  sourceUrl: 'https://www.douyin.com/user/self',
  scope: {
    type: 'current-tab-url',
    origin: 'https://www.douyin.com',
    url: 'https://www.douyin.com/user/self'
  },
  redacted: false,
  cookieCount: 7,
  cookies: [
    {
      name: 'sessionid',
      value: 'secret',
      domain: '.douyin.com',
      hostOnly: false,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
      session: false,
      expirationDate: future,
      storeId: '0'
    },
    {
      name: 'host_cookie',
      value: 'value',
      domain: 'www.douyin.com',
      hostOnly: true,
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      session: true,
      storeId: '0'
    },
    {
      name: 'strict_cookie',
      value: 'value',
      domain: '.douyin.com',
      hostOnly: false,
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'strict',
      session: true,
      storeId: '0'
    },
    {
      name: 'creator_only',
      value: 'value',
      domain: 'creator.douyin.com',
      hostOnly: true,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'unspecified',
      session: true,
      storeId: '0'
    },
    {
      name: 'other',
      value: 'value',
      domain: '.example.com',
      hostOnly: false,
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      session: true,
      storeId: '0'
    },
    {
      name: 'expired',
      value: 'value',
      domain: '.douyin.com',
      hostOnly: false,
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      session: false,
      expirationDate: 1,
      storeId: '0'
    },
    {
      name: 'partitioned',
      value: 'value',
      domain: '.douyin.com',
      hostOnly: false,
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      session: true,
      storeId: '0',
      partitionKey: { topLevelSite: 'https://www.douyin.com' }
    }
  ]
};

const parsed = parseCookieAuthContent(JSON.stringify(baseExport), {
  now: new Date('2026-05-29T00:00:00.000Z')
});
assert.equal(parsed.cookieCount, 7);
assert.equal(parsed.acceptedCount, 3);
assert.equal(parsed.skippedCount, 4);
assert.deepEqual(parsed.skippedReasons, [
  { reason: 'expired', count: 1 },
  { reason: 'non-douyin-domain', count: 1 },
  { reason: 'non-target-douyin-subdomain', count: 1 },
  { reason: 'partition-key-unsupported', count: 1 }
]);
assert.deepEqual(parsed.cookies[0], {
  name: 'sessionid',
  value: 'secret',
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'None',
  expires: future,
  domain: '.douyin.com'
});
assert.equal(parsed.cookies[1].url, 'https://www.douyin.com/');
assert.equal(parsed.cookies[1].sameSite, 'Lax');
assert.equal(parsed.cookies[2].sameSite, 'Strict');

assert.throws(() => parseCookieAuthContent('{nope'), /有效 JSON/);
assert.throws(() => parseCookieAuthContent(JSON.stringify({ ...baseExport, format: 'other' })), /只支持/);
assert.throws(() => parseCookieAuthContent(JSON.stringify({ ...baseExport, redacted: true })), /Redacted/);

console.log('cookie auth tests passed');
