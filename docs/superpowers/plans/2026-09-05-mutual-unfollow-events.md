# Mutual-unfollow Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Prospectively detect and highlight when an explicitly observed mutual follower is confirmed to have unfollowed the user.

**Architecture:** Normalize the existing follower API relationship signal in a focused module, persist only recognized states in the follower ledger, and emit a dedicated event at the existing two-complete-full-scan removal transition. Extend the local dashboard and notification summary without changing the semantics of the existing `removed` event.

**Tech Stack:** Node.js ESM, built-in `node:sqlite`, built-in `node:test`-style assertions, React 19, TypeScript, Vite.

**Spec:** `docs/superpowers/specs/2026-09-05-mutual-unfollow-events.md`

## Global Constraints

- Existing follower rows predate relationship capture and remain `unknown`; no historical event is backfilled.
- Only numeric `followStatus` or `follow_status` value `2` proves `mutual`; value `0` means `follower_only`; every other value is `unknown`.
- Unknown input never overwrites a previously recognized relationship.
- `mutual_unfollowed_you` is emitted only at confirmed removal after two complete full scans and is stored alongside `removed`.
- No new dependency is added.
- Never log cookie or follower identity data.

---

### Task 1: Normalize and persist relationship evidence

**Files:**
- Create: `scripts/follower-relationship.mjs`
- Create: `scripts/follower-relationship.test.mjs`
- Modify: `scripts/collect-followers.mjs`
- Modify: `scripts/monitor-state.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `relationshipFromApiUser(user: object): 'unknown' | 'mutual' | 'follower_only'`.
- Produces: follower columns `relationshipStatus TEXT NOT NULL DEFAULT 'unknown'` and `relationshipObservedAt TEXT` under schema version `2`.
- Consumes: `apiFollowerToFollower(user)` and the existing `applyScanToDatabase(db, options, scanFollowers)` flow.

- [x] **Step 1: Write failing normalization tests**

```js
assert.equal(relationshipFromApiUser({ followStatus: 2 }), 'mutual');
assert.equal(relationshipFromApiUser({ follow_status: 0 }), 'follower_only');
assert.equal(relationshipFromApiUser({ followStatus: 1 }), 'unknown');
assert.equal(relationshipFromApiUser({}), 'unknown');
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `node scripts/follower-relationship.test.mjs`
Expected: FAIL because `scripts/follower-relationship.mjs` does not exist.

- [x] **Step 3: Implement the minimal normalizer and API mapping**

```js
const RELATIONSHIP_STATUSES = new Set(['unknown', 'mutual', 'follower_only']);
function relationshipFromApiUser(user = {}) {
  const value = Number(user.followStatus ?? user.follow_status);
  if (value === 2) return 'mutual';
  if (value === 0) return 'follower_only';
  return 'unknown';
}
```

Add `relationshipStatus: relationshipFromApiUser(user)` to `apiFollowerToFollower`.

- [x] **Step 4: Write failing database migration and preservation tests**

```js
assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '2');
applyScanToDatabase(db, baseOptions({ runId: 'relation-a' }), [follower('sec-m', 'M', 'mutual')]);
applyScanToDatabase(db, baseOptions({ runId: 'relation-b' }), [follower('sec-m', 'M', 'unknown')]);
assert.equal(db.prepare("SELECT relationshipStatus FROM followers WHERE id = 'sec-m'").get().relationshipStatus, 'mutual');
```

- [x] **Step 5: Run state tests and verify RED**

Run: `npm run test:state`
Expected: FAIL because schema version 2 and relationship columns are absent.

- [x] **Step 6: Implement schema version 2 and known-only updates**

Use `PRAGMA table_info(followers)` before `ALTER TABLE`, then update insert/select/update statements. For updates, use SQL `CASE WHEN ? != 'unknown' THEN ? ELSE relationshipStatus END` and set `relationshipObservedAt` only for recognized input.

- [x] **Step 7: Run focused tests and verify GREEN**

Run: `node scripts/follower-relationship.test.mjs && npm run test:state`
Expected: both PASS.

- [x] **Step 8: Commit**

```bash
git add scripts/follower-relationship.mjs scripts/follower-relationship.test.mjs scripts/collect-followers.mjs scripts/monitor-state.test.mjs package.json
git commit -m "feat: persist follower relationship evidence"
```

### Task 2: Emit the confirmed mutual-unfollow event

**Files:**
- Modify: `scripts/collect-followers.mjs`
- Modify: `scripts/monitor-state.test.mjs`

**Interfaces:**
- Consumes: persisted `followers.relationshipStatus` and the existing confirmed-removal branch.
- Produces: `follower_events.type = 'mutual_unfollowed_you'` and `change.mutualUnfollowedYouCount`.

- [x] **Step 1: Write failing confirmation tests**

```js
const typesAfterFirstMiss = db.prepare("SELECT type FROM follower_events WHERE followerId = 'sec-m'").all().map((row) => row.type);
assert.equal(typesAfterFirstMiss.includes('mutual_unfollowed_you'), false);
const typesAfterSecondMiss = db.prepare("SELECT type FROM follower_events WHERE followerId = 'sec-m'").all().map((row) => row.type);
assert.equal(typesAfterSecondMiss.filter((type) => type === 'mutual_unfollowed_you').length, 1);
assert.equal(result.change.mutualUnfollowedYouCount, 1);
```

Add a separate follower-only case asserting that confirmed removal does not create the special event.

- [x] **Step 2: Run state tests and verify RED**

Run: `npm run test:state`
Expected: FAIL because the special event and count do not exist.

- [x] **Step 3: Implement event emission at confirmed removal**

In the `suspected_removed` to `removed` transition, emit the existing `removed` event first. If `row.relationshipStatus === 'mutual'`, emit `mutual_unfollowed_you` with payload `{ missingFullScans, relationshipStatus: 'mutual' }` and append the follower to `change.mutualUnfollowedYou`.

- [x] **Step 4: Run state tests and verify GREEN**

Run: `npm run test:state`
Expected: PASS, including no event after an incomplete or first missing full scan.

- [x] **Step 5: Commit**

```bash
git add scripts/collect-followers.mjs scripts/monitor-state.test.mjs
git commit -m "feat: emit confirmed mutual unfollow events"
```

### Task 3: Expose and highlight the event in the dashboard

**Files:**
- Modify: `scripts/dashboard-data.mjs`
- Modify: `scripts/dashboard-api.test.mjs`
- Modify: `web/src/types.ts`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: event type `mutual_unfollowed_you` and `change.mutualUnfollowedYouCount`.
- Produces: dashboard event filter, high-priority pill label `互关后取关我`, and run-detail `mutual_unfollowed_you` count.

- [x] **Step 1: Write failing dashboard API tests**

```js
const mutualEvents = await getDashboardEvents({ dbPath, type: 'mutual_unfollowed_you', limit: 10, offset: 0 });
assert.equal(mutualEvents.total, 1);
assert.equal(mutualEvents.rows[0].type, 'mutual_unfollowed_you');
assert.equal((await getDashboardRun({ dbPath, runId: 'run-c' })).eventCounts.mutual_unfollowed_you, 1);
```

- [x] **Step 2: Run dashboard API tests and verify RED**

Run: `node --disable-warning=ExperimentalWarning scripts/dashboard-api.test.mjs`
Expected: FAIL because the event filter allowlist and run count omit the new type.

- [x] **Step 3: Implement API and TypeScript contracts**

Add `mutual_unfollowed_you` to `EVENT_TYPES`, `EventType`, and `ScanRunDetail.eventCounts`; include the count in `getDashboardRun`.

- [x] **Step 4: Implement dashboard presentation**

Add `mutual_unfollowed_you: '互关后取关我'` to `EVENT_LABELS`, give it the rose priority pill, and add `互关后取关我` to the run detail count list. Keep daily removal charts unchanged to avoid double counting one removal twice.

- [x] **Step 5: Run API tests and production build**

Run: `node --disable-warning=ExperimentalWarning scripts/dashboard-api.test.mjs && npm run dashboard:build`
Expected: PASS and Vite build completes without TypeScript errors.

- [x] **Step 6: Commit**

```bash
git add scripts/dashboard-data.mjs scripts/dashboard-api.test.mjs web/src/types.ts web/src/App.tsx
git commit -m "feat: highlight mutual unfollows in dashboard"
```

### Task 4: Add completion notification and final verification

**Files:**
- Modify: `scripts/notify.mjs`
- Modify: `scripts/notify.test.mjs`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-05-mutual-unfollow-events.md`

**Interfaces:**
- Consumes: `change.mutualUnfollowedYouCount`.
- Produces: completion message suffix `，互关后取关我 N` only when `N > 0`.

- [x] **Step 1: Write a failing notification test**

```js
assert.match(formatNotificationBody({ newCount: 0, suspectedRemovedCount: 0, removedCount: 1, mutualUnfollowedYouCount: 1, enumerableCount: 9 }), /互关后取关我 1/);
```

- [x] **Step 2: Run the notification test and verify RED**

Run: `node scripts/notify.test.mjs`
Expected: FAIL because the message does not include the mutual-unfollow count.

- [x] **Step 3: Implement conditional notification copy and document the prospective baseline**

Keep existing wording when the count is zero. In README, document that old rows remain unknown, a new CDP full scan establishes relationship evidence, and two complete full misses are required.

- [x] **Step 4: Run the complete project verification**

Run: `npm run check`
Expected: PASS. If the pre-existing `dashboard-runtime-health.test.mjs` unsettled top-level-await warning still stops the chain, run and report every remaining test command separately without changing unrelated runtime-health behavior.

- [x] **Step 5: Review privacy and repository diff**

Run: `npm run privacy:check && git diff --check && git status --short`
Expected: privacy check passes, no whitespace errors, and only planned files are changed.

- [x] **Step 6: Mark all plan checkboxes complete and commit**

```bash
git add README.md scripts/notify.mjs scripts/notify.test.mjs docs/superpowers/specs/2026-09-05-mutual-unfollow-events.md docs/superpowers/plans/2026-09-05-mutual-unfollow-events.md
git commit -m "docs: explain mutual unfollow baseline"
```
