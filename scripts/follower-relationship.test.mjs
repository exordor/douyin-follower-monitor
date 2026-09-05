#!/usr/bin/env node

import assert from 'node:assert/strict';

import { relationshipFromApiUser } from './follower-relationship.mjs';

assert.equal(relationshipFromApiUser({ followStatus: 2 }), 'mutual');
assert.equal(relationshipFromApiUser({ follow_status: 2 }), 'mutual');
assert.equal(relationshipFromApiUser({ followStatus: 0 }), 'follower_only');
assert.equal(relationshipFromApiUser({ follow_status: 0 }), 'follower_only');
assert.equal(relationshipFromApiUser({ followStatus: 1 }), 'unknown');
assert.equal(relationshipFromApiUser({ followStatus: '2' }), 'unknown');
assert.equal(relationshipFromApiUser({}), 'unknown');

console.log('follower relationship tests passed');
