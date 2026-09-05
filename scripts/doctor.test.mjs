#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseArgs, runDoctor } from './doctor.mjs';

const parsed = parseArgs([
  '--json',
  '--runtime', 'cdp',
  '--cdp-url', 'http://127.0.0.1:9222',
  '--cookie-file', 'cookies.json',
  '--out-dir', 'tmp-doctor-data'
]);
assert.equal(parsed.json, true);
assert.equal(parsed.runtime, 'cdp');
assert.equal(parsed.cdpUrl, 'http://127.0.0.1:9222');
assert.equal(parsed.cookieFile.endsWith('cookies.json'), true);
assert.equal(parsed.outDir.endsWith('tmp-doctor-data'), true);

const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-doctor-test-'));
const outDir = path.join(dir, 'data');
const cookieFile = path.join(dir, 'cookies.json');
await mkdir(outDir, { recursive: true });
await writeFile(cookieFile, JSON.stringify({
  format: 'local-cookie-manager-v1',
  exportedAt: '2026-05-29T00:00:00.000Z',
  sourceUrl: 'https://www.douyin.com',
  cookies: [
    {
      name: 'sessionid',
      value: 'super-secret-cookie-value-that-must-not-leak',
      domain: '.douyin.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'unspecified',
      expirationDate: 1819238400,
      session: false
    }
  ]
}, null, 2));

try {
  const report = await runDoctor({
    runtime: 'playwright',
    cdpUrl: '',
    profile: path.join(dir, 'profile'),
    outDir,
    cookieFile
  });
  assert.equal(report.generatedAt.length > 0, true);
  assert.equal(report.checks.some((item) => item.name === 'node'), true);
  assert.equal(report.checks.some((item) => item.name === 'storage' && item.level === 'ok'), true);
  assert.equal(report.checks.some((item) => item.name === 'cookie' && item.detail.acceptedCount === 1), true);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('super-secret-cookie-value-that-must-not-leak'), false);
  assert.equal(serialized.includes('sessionid'), false);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('doctor tests passed');
