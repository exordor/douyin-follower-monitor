#!/usr/bin/env node

import assert from 'node:assert/strict';

import { waitForManualAuthIfNeeded } from './collect-followers.mjs';

const EVENT_PREFIX = '__DOUYIN_MONITOR_EVENT__ ';

async function captureLogs(fn) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  try {
    await fn(lines);
  } finally {
    console.log = originalLog;
  }
  return lines;
}

function parseEvents(lines) {
  return lines
    .filter((line) => line.startsWith(EVENT_PREFIX))
    .map((line) => JSON.parse(line.slice(EVENT_PREFIX.length)));
}

const originalIsTty = process.stdin.isTTY;
process.stdin.isTTY = false;

try {
  const resolvedLogs = await captureLogs(async () => {
    let reads = 0;
    const pageInfo = await waitForManualAuthIfNeeded({
      authWaitSeconds: 1,
      authPollMs: 1,
      browserRuntime: {
        async readPageInfo() {
          reads += 1;
          if (reads === 1) throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
          return { title: 'Dead Man 的抖音', text: '粉丝 803 作品 95' };
        }
      }
    }, { title: '验证码中间页', text: '请完成下列验证后继续' });

    assert.equal(pageInfo.title, 'Dead Man 的抖音');
  });

  const resolvedEvents = parseEvents(resolvedLogs);
  assert.deepEqual(resolvedEvents.map((event) => event.type), [
    'auth_wait_started',
    'auth_wait_transient_navigation',
    'auth_wait_resolved'
  ]);
  assert.equal(resolvedEvents[0].kind, 'captcha');
  assert.equal(resolvedEvents[0].status, 'waiting');
  assert.equal(resolvedEvents[2].status, 'resolved');

  const timeoutLogs = await captureLogs(async () => {
    await assert.rejects(
      waitForManualAuthIfNeeded({
        authWaitSeconds: 0.02,
        authPollMs: 1,
        browserRuntime: {
          async readPageInfo() {
            return { title: '验证码中间页', text: '拖动完成上方拼图' };
          }
        }
      }, { title: '验证码中间页', text: '拖动完成上方拼图' }),
      /等待人工登录\/验证码超时/
    );
  });

  const timeoutEvents = parseEvents(timeoutLogs);
  assert.equal(timeoutEvents.at(-1).type, 'auth_wait_timeout');
  assert.equal(timeoutEvents.at(-1).status, 'timeout');
} finally {
  process.stdin.isTTY = originalIsTty;
}

console.log('auth wait tests passed');
