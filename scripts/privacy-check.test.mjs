#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  checkTrackedPaths,
  findContentFindings,
  validateDemoMockData
} from './privacy-check.mjs';

const trackedFindings = checkTrackedPaths([
  'data/followers.db',
  'debug/douyin-monitor-debug-2026-05-29/runtime-health.json',
  'debug/douyin-monitor-debug-2026-05-29.zip',
  'exports/latest.csv',
  'data/in-progress/latest.partial.json',
  'profiles/User Data/Default/Cookies',
  'README.md'
]);
assert.equal(trackedFindings.some((finding) => finding.rule === 'tracked-data-dir'), true);
assert.equal(trackedFindings.some((finding) => finding.rule === 'tracked-debug-dir'), true);
assert.equal(trackedFindings.some((finding) => finding.rule === 'tracked-sqlite'), true);
assert.equal(trackedFindings.some((finding) => finding.rule === 'tracked-csv'), true);
assert.equal(trackedFindings.some((finding) => finding.rule === 'tracked-archive'), true);
assert.equal(trackedFindings.some((finding) => finding.rule === 'tracked-partial'), true);
assert.equal(trackedFindings.some((finding) => finding.rule === 'tracked-browser-profile'), true);

const contentFindings = findContentFindings('README.md', `
Real nickname: ${['Dead', 'Man'].join(' ')}
uid: ${['118', '229', '888'].join('')}
secUid: ${['MS4w', 'LjABAAAArealLookingToken'].join('')}
sessionid=abcd1234abcd1234abcd1234abcd1234
Cookie: sessionid=abcd1234abcd1234abcd1234abcd1234
/Users/alice/Library/Application Support/Google/Chrome/Default
`);
assert.equal(contentFindings.some((finding) => finding.rule === 'known-real-nickname'), true);
assert.equal(contentFindings.some((finding) => finding.rule === 'known-real-uid'), true);
assert.equal(contentFindings.some((finding) => finding.rule === 'real-douyin-secuid-prefix'), true);
assert.equal(contentFindings.some((finding) => finding.rule === 'long-session-value'), true);
assert.equal(contentFindings.some((finding) => finding.rule === 'cookie-header'), true);
assert.equal(contentFindings.some((finding) => finding.rule === 'browser-profile-content-path'), true);

const genericFixture = findContentFindings('scripts/cookie-auth.test.mjs', `
const cookie = { name: 'sessionid', value: 'secret' };
`);
assert.equal(genericFixture.length, 0);

const demoFindings = validateDemoMockData(JSON.stringify({
  followers: {
    rows: [
      { id: 'demo-sec-001', profileUrl: 'https://www.douyin.com/user/demo-sec-001' },
      {
        id: ['MS4w', 'LjABAAAArealLookingToken'].join(''),
        profileUrl: `https://www.douyin.com/user/${['MS4w', 'LjABAAAArealLookingToken'].join('')}`
      }
    ]
  }
}, null, 2));
assert.equal(demoFindings.length, 1);
assert.equal(demoFindings[0].rule, 'demo-real-profile-url');

console.log('privacy check tests passed');
