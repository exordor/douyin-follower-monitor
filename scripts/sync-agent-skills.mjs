#!/usr/bin/env node

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const SOURCE_ROOT = path.join('agent-skills', 'douyin-monitor-pack', 'skills');
const SKILL_NAMES = ['douyin-monitor', 'douyin-monitor-control'];

const TARGETS = [
  { platform: 'codex', root: path.join('.agents', 'skills') },
  { platform: 'claude', root: path.join('.claude', 'skills') }
];

function slash(filePath) {
  return filePath.split(path.sep).join('/');
}

function isControlSkill(skillName) {
  return skillName === 'douyin-monitor-control';
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function walkFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(absolute, base));
    } else if (entry.isFile()) {
      files.push(path.relative(base, absolute));
    }
  }
  return files.sort();
}

function ensureClaudeControlFrontmatter(content) {
  if (/^---\n[\s\S]*?\ndisable-model-invocation:\s*true\n[\s\S]*?\n---/.test(content)) {
    return content;
  }
  return content.replace(/^---\n/, '---\ndisable-model-invocation: true\n');
}

function transformSkillFile({ skillName, platform, relativePath, content }) {
  if (relativePath !== 'SKILL.md') return content;
  if (platform === 'claude' && isControlSkill(skillName)) {
    return ensureClaudeControlFrontmatter(content);
  }
  return content;
}

function openAiYaml(skillName) {
  const control = isControlSkill(skillName);
  const displayName = control ? 'Douyin Monitor Control' : 'Douyin Monitor';
  const shortDescription = control
    ? 'Run allowlisted monitor, dashboard, debug, and launchd control actions.'
    : 'Diagnose and troubleshoot Douyin Follower Monitor safely.';
  const defaultPrompt = control
    ? 'Use douyin-monitor-control to run an allowlisted project action.'
    : 'Use douyin-monitor to diagnose or troubleshoot this project.';
  return `interface:
  display_name: "${displayName}"
  short_description: "${shortDescription}"
  brand_color: "#14b8a6"
  default_prompt: "${defaultPrompt}"
policy:
  allow_implicit_invocation: ${control ? 'false' : 'true'}
`;
}

async function buildExpectedFiles(rootDir = ROOT_DIR, platform = 'codex') {
  const output = new Map();
  for (const skillName of SKILL_NAMES) {
    const sourceDir = path.join(rootDir, SOURCE_ROOT, skillName);
    const files = await walkFiles(sourceDir);
    for (const relativePath of files) {
      const content = await readFile(path.join(sourceDir, relativePath), 'utf8');
      const targetRelative = slash(path.join(skillName, relativePath));
      output.set(targetRelative, transformSkillFile({ skillName, platform, relativePath, content }));
    }
    if (platform === 'codex') {
      output.set(slash(path.join(skillName, 'agents', 'openai.yaml')), openAiYaml(skillName));
    }
  }
  return output;
}

async function writeTarget(rootDir, target) {
  const expected = await buildExpectedFiles(rootDir, target.platform);
  for (const skillName of SKILL_NAMES) {
    await rm(path.join(rootDir, target.root, skillName), { recursive: true, force: true });
  }
  for (const [relativePath, content] of expected) {
    const absolute = path.join(rootDir, target.root, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
}

async function readActualTargetFiles(rootDir, target) {
  const output = new Map();
  for (const skillName of SKILL_NAMES) {
    const skillDir = path.join(rootDir, target.root, skillName);
    if (!await fileExists(skillDir)) continue;
    for (const relativePath of await walkFiles(skillDir)) {
      output.set(slash(path.join(skillName, relativePath)), await readFile(path.join(skillDir, relativePath), 'utf8'));
    }
  }
  return output;
}

async function diffTarget(rootDir, target) {
  const expected = await buildExpectedFiles(rootDir, target.platform);
  const actual = await readActualTargetFiles(rootDir, target);
  const diffs = [];
  for (const [file, content] of expected) {
    if (!actual.has(file)) diffs.push({ file: slash(path.join(target.root, file)), type: 'missing' });
    else if (actual.get(file) !== content) diffs.push({ file: slash(path.join(target.root, file)), type: 'changed' });
  }
  for (const file of actual.keys()) {
    if (!expected.has(file)) diffs.push({ file: slash(path.join(target.root, file)), type: 'extra' });
  }
  return diffs;
}

async function assertSkillTargetsInSync(rootDir = ROOT_DIR) {
  const diffs = [];
  for (const target of TARGETS) {
    diffs.push(...await diffTarget(rootDir, target));
  }
  return { ok: diffs.length === 0, diffs };
}

async function syncAgentSkills(rootDir = ROOT_DIR) {
  for (const target of TARGETS) {
    await writeTarget(rootDir, target);
  }
}

async function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  if (check) {
    const result = await assertSkillTargetsInSync(ROOT_DIR);
    if (!result.ok) {
      console.error('agent skill targets are out of sync');
      for (const diff of result.diffs) console.error(`- ${diff.type}: ${diff.file}`);
      process.exitCode = 1;
      return;
    }
    console.log('agent skill targets are in sync');
    return;
  }
  await syncAgentSkills(ROOT_DIR);
  console.log('agent skill targets synced');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export {
  SKILL_NAMES,
  TARGETS,
  assertSkillTargetsInSync,
  buildExpectedFiles,
  syncAgentSkills
};
