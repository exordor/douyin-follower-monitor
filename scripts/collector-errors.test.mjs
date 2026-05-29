#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  classifyCollectorError,
  errorSuggestion,
  publicErrorMessage
} from './collector-errors.mjs';

assert.equal(classifyCollectorError(new Error('Douyin webpack runtime is not available on this page')), 'douyin_api_shape_changed');
assert.equal(classifyCollectorError(new Error('浏览器触发了抖音验证码，请完成下列验证')), 'captcha_required');
assert.equal(classifyCollectorError(new Error('无法从当前抖音页面读取登录用户 uid/secUid')), 'not_logged_in');
assert.equal(classifyCollectorError(new Error('粉丝接口返回异常: 2149 risk control')), 'rate_limited_or_risk_control');
assert.equal(classifyCollectorError(new Error('random failure')), 'unknown');
assert.equal(errorSuggestion('captcha_required').includes('人工'), true);
assert.equal(publicErrorMessage(new Error(`first line\n${'x'.repeat(600)}`)), 'first line');

console.log('collector error tests passed');
