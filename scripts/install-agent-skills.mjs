#!/usr/bin/env node

import { cp, mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SKILL_NAMES } from './sync-agent-skills.mjs';

const ROOT_DIR = path.resolve(new URL('..', import.meta.url).pathname);

const INSTALL_TARGETS = [
  { platform: 'codex', repoRoot: path.join('.agents', 'skills'), userRoot: path.join('.agents', 'skills') },
  { platform: 'claude', repoRoot: path.join('.claude', 'skills'), userRoot: path.join('.claude', 'skills') }
];

async function ensureDirExists(dir) {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) throw new Error(`${dir} is not a directory`);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Missing skill source directory: ${dir}. Run npm run skills:sync first.`);
    throw error;
  }
}

async function installAgentSkills({ rootDir = ROOT_DIR, homeDir = os.homedir(), uninstall = false } = {}) {
  const changes = [];
  for (const target of INSTALL_TARGETS) {
    const userRoot = path.join(homeDir, target.userRoot);
    await mkdir(userRoot, { recursive: true });
    for (const skillName of SKILL_NAMES) {
      const source = path.join(rootDir, target.repoRoot, skillName);
      const destination = path.join(userRoot, skillName);
      if (uninstall) {
        await rm(destination, { recursive: true, force: true });
        changes.push({ platform: target.platform, skillName, action: 'removed' });
      } else {
        await ensureDirExists(source);
        await rm(destination, { recursive: true, force: true });
        await cp(source, destination, { recursive: true });
        changes.push({ platform: target.platform, skillName, action: 'installed' });
      }
    }
  }
  return { homeDir, uninstall, changes };
}

function parseArgs(argv) {
  const options = { rootDir: ROOT_DIR, homeDir: os.homedir(), uninstall: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--root') options.rootDir = path.resolve(next());
    else if (arg === '--home') options.homeDir = path.resolve(next());
    else if (arg === '--uninstall') options.uninstall = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const result = await installAgentSkills(parseArgs(argv));
  for (const change of result.changes) {
    console.log(`${change.action}: ${change.platform}/${change.skillName}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export { INSTALL_TARGETS, installAgentSkills, parseArgs };
