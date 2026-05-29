#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  generateDebugBundle,
  readBundleText,
  sanitizeText
} from './debug-bundle.mjs';

const sensitive = [
  'sessionid=abcd1234abcd1234abcd1234abcd1234',
  `"uid": "${['118', '229', '888'].join('')}"`,
  `"secUid": "${['MS4w', 'LjABAAAArealLookingToken'].join('')}"`,
  `"nickname": "${['Dead', 'Man'].join(' ')}"`,
  `"profileUrl": "https://www.douyin.com/user/${['MS4w', 'LjABAAAArealLookingToken'].join('')}"`,
  '/Users/alice/Library/Application Support/Google/Chrome/Default'
].join('\n');

const sanitized = sanitizeText(sensitive);
assert.equal(sanitized.includes('sessionid'), false);
assert.equal(sanitized.includes('abcd1234abcd1234abcd1234abcd1234'), false);
assert.equal(sanitized.includes(['118', '229', '888'].join('')), false);
assert.equal(sanitized.includes(['MS4w', 'LjABAAAArealLookingToken'].join('')), false);
assert.equal(sanitized.includes(['Dead', 'Man'].join(' ')), false);
assert.equal(sanitized.includes(`https://www.douyin.com/user/${['MS4w', 'LjABAAAArealLookingToken'].join('')}`), false);
assert.equal(sanitized.includes('/Users/alice'), false);

const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-debug-bundle-test-'));
const rootDir = path.join(dir, 'repo');
const outRoot = path.join(dir, 'debug');
await mkdir(rootDir, { recursive: true });
await writeFile(path.join(rootDir, 'package.json'), JSON.stringify({
  name: 'douyin-follower-monitor',
  version: '0.1.0',
  private: true,
  scripts: { check: 'node --check scripts/example.mjs' },
  dependencies: { react: '1.0.0' },
  devDependencies: { vite: '1.0.0' }
}, null, 2));
const errorLogPath = path.join(dir, 'latest-error.log');
await writeFile(errorLogPath, sensitive);

try {
  const result = await generateDebugBundle({
    rootDir,
    outRoot,
    dbPath: path.join(rootDir, 'data', 'followers.db'),
    errorLogPath,
    now: new Date('2026-05-29T00:00:00.000Z')
  });
  const bundleText = await readBundleText(result.bundleDir);
  const doctor = JSON.parse(await readFile(path.join(result.bundleDir, 'doctor.json'), 'utf8'));
  const schema = JSON.parse(await readFile(path.join(result.bundleDir, 'schema.json'), 'utf8'));
  const archiveBytes = result.archivePath ? await readFile(result.archivePath) : Buffer.alloc(0);

  assert.equal(bundleText.includes('sessionid'), false);
  assert.equal(bundleText.includes('abcd1234abcd1234abcd1234abcd1234'), false);
  assert.equal(bundleText.includes(['118', '229', '888'].join('')), false);
  assert.equal(bundleText.includes(['MS4w', 'LjABAAAArealLookingToken'].join('')), false);
  assert.equal(bundleText.includes(['Dead', 'Man'].join(' ')), false);
  assert.equal(bundleText.includes('/Users/alice'), false);
  assert.equal(bundleText.includes('profileUrl'), false);
  assert.equal(bundleText.includes('nickname'), false);
  assert.equal(bundleText.includes('"exists": false'), true);
  assert.equal(doctor.checks.some((check) => check.name === 'node'), true);
  assert.equal(schema.exists, false);
  assert.equal(Boolean(result.bundleDir), true);
  assert.equal(result.archivePath?.endsWith('.zip'), true);
  assert.equal(archiveBytes.subarray(0, 2).toString(), 'PK');
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('debug bundle tests passed');
