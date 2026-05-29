#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  buildNotificationPayload,
  parseNotifyConfig,
  sendNotification
} from './notify.mjs';

assert.deepEqual(parseNotifyConfig({ notify: 'none' }).mode, 'none');
assert.throws(() => parseNotifyConfig({ notify: 'email' }), /--notify must be one of/);

const payload = buildNotificationPayload({
  options: {
    runId: 'run-1',
    effectiveMode: 'full',
    modeReason: 'test',
    profileStats: { followers: 10 }
  },
  followers: [
    { id: 'sec-a', uid: '100', nickname: '不应外发', profileUrl: 'https://www.douyin.com/user/sec-a' },
    { id: 'sec-b', uid: '200', nickname: '也不应外发', profileUrl: 'https://www.douyin.com/user/sec-b' }
  ],
  change: {
    newCount: 1,
    suspectedRemovedCount: 2,
    removedCount: 3,
    renamedCount: 4,
    reappearedCount: 5,
    hiddenOrUnavailableCount: 8
  }
});
assert.equal('runId' in payload, false);
assert.equal('mode' in payload, false);
assert.equal('reason' in payload, false);
assert.equal('collectedAt' in payload, false);
assert.equal(payload.enumerableCount, 2);
assert.equal(payload.profileFollowerCount, 10);
assert.equal(payload.newCount, 1);
assert.equal(JSON.stringify(payload).includes('不应外发'), false);
assert.equal(JSON.stringify(payload).includes('sec-a'), false);

let calledUrl = '';
let calledBody = '';
const result = await sendNotification(payload, {
  notify: 'webhook',
  env: { DOUYIN_NOTIFY_URL: 'https://example.test/hook' }
}, {
  fetchImpl: async (url, init) => {
    calledUrl = String(url);
    calledBody = init.body;
    return { ok: true };
  }
});
assert.equal(result.ok, true);
assert.equal(result.channel, 'webhook');
assert.equal(calledUrl, 'https://example.test/hook');
assert.equal(calledBody.includes('不应外发'), false);
assert.equal(calledBody.includes('sec-a'), false);

console.log('notification tests passed');
