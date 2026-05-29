#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildSkillInspectReport } from './agent-skills-inspect.mjs';
import { executeControlAction, parseArgs as parseControlArgs } from './agent-skills-control.mjs';
import { installAgentSkills } from './install-agent-skills.mjs';
import { assertSkillTargetsInSync, SKILL_NAMES } from './sync-agent-skills.mjs';

const ROOT_DIR = path.resolve(new URL('..', import.meta.url).pathname);

const syncResult = await assertSkillTargetsInSync(ROOT_DIR);
assert.equal(syncResult.ok, true, JSON.stringify(syncResult.diffs, null, 2));

for (const platformRoot of ['.agents/skills', '.claude/skills']) {
  for (const skillName of SKILL_NAMES) {
    const content = await readFile(path.join(ROOT_DIR, platformRoot, skillName, 'SKILL.md'), 'utf8');
    assert.match(content, /^---\n/);
    assert.match(content, /\nname:\s*[^\n]+/);
    assert.match(content, /\ndescription:\s*[^\n]+/);
  }
}

const claudeControl = await readFile(path.join(ROOT_DIR, '.claude', 'skills', 'douyin-monitor-control', 'SKILL.md'), 'utf8');
assert.match(claudeControl, /disable-model-invocation:\s*true/);

const codexControlMetadata = await readFile(path.join(ROOT_DIR, '.agents', 'skills', 'douyin-monitor-control', 'agents', 'openai.yaml'), 'utf8');
assert.match(codexControlMetadata, /allow_implicit_invocation:\s*false/);

const tempHome = await mkdtemp(path.join(os.tmpdir(), 'douyin-skills-home-'));
const unrelatedDir = path.join(tempHome, '.agents', 'skills', 'unrelated');
await mkdir(unrelatedDir, { recursive: true });
await writeFile(path.join(unrelatedDir, 'SKILL.md'), 'unrelated\n');

await installAgentSkills({ rootDir: ROOT_DIR, homeDir: tempHome });
for (const skillName of SKILL_NAMES) {
  await stat(path.join(tempHome, '.agents', 'skills', skillName, 'SKILL.md'));
  await stat(path.join(tempHome, '.claude', 'skills', skillName, 'SKILL.md'));
}
assert.equal(await readFile(path.join(unrelatedDir, 'SKILL.md'), 'utf8'), 'unrelated\n');

await installAgentSkills({ rootDir: ROOT_DIR, homeDir: tempHome, uninstall: true });
await stat(unrelatedDir);
for (const skillName of SKILL_NAMES) {
  await assert.rejects(() => stat(path.join(tempHome, '.agents', 'skills', skillName)), /ENOENT/);
  await assert.rejects(() => stat(path.join(tempHome, '.claude', 'skills', skillName)), /ENOENT/);
}

assert.deepEqual(parseControlArgs(['monitor', '--yes']).action, 'monitor');
assert.throws(() => parseControlArgs(['unknown']), /Unknown action/);

const dryMonitor = await executeControlAction({ action: 'monitor', rootDir: ROOT_DIR });
assert.equal(dryMonitor.status, 'dry-run');
assert.equal(dryMonitor.plan.mutating, true);
assert.equal(dryMonitor.plan.willExecute, false);
assert.deepEqual(dryMonitor.plan.command.slice(-2), ['run', 'monitor']);

const dryPrivacy = await executeControlAction({ action: 'privacy-check', dryRun: true, rootDir: ROOT_DIR });
assert.equal(dryPrivacy.status, 'dry-run');
assert.equal(dryPrivacy.plan.mutating, false);
assert.deepEqual(dryPrivacy.plan.command.slice(-2), ['run', 'privacy:check']);

const dryLaunchd = await executeControlAction({ action: 'launchd-install-hourly', rootDir: ROOT_DIR });
assert.equal(dryLaunchd.status, 'dry-run');
assert.equal(dryLaunchd.plan.launchd.schedule, 'hourly at minute 5');
assert.equal(dryLaunchd.plan.launchd.command.includes('/Users/jlw/code/douyin_follower'), false);

const inspect = await buildSkillInspectReport({ rootDir: ROOT_DIR, includeDoctor: false });
const inspectText = JSON.stringify(inspect);
assert.equal(inspect.project.name, 'douyin-follower-monitor');
assert.equal(inspect.doctor.skipped, true);
assert.equal(/MS4w[A-Za-z0-9_-]{8,}/.test(inspectText), false);
assert.equal(/\b(?:sessionid|sid_guard|passport_csrf_token|odin_tt|ttwid)\s*[:=]/i.test(inspectText), false);
assert.equal(/https:\/\/www\.douyin\.com\/user\//.test(inspectText), false);

console.log('agent skills tests passed');
