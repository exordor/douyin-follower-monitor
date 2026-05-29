#!/usr/bin/env node

import { execFile } from 'node:child_process';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { getDashboardSummary } from './dashboard-data.mjs';
import { runDoctor } from './doctor.mjs';

const execFileAsync = promisify(execFile);
const ROOT_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const LAUNCHD_LABEL = 'com.exordor.douyin-follower-monitor';
const EXPECTED_SCRIPTS = [
  'doctor',
  'privacy:check',
  'debug:bundle',
  'monitor',
  'monitor:doubao',
  'dashboard',
  'dashboard:doubao'
];

function parseArgs(argv) {
  const options = {
    rootDir: process.env.DOUYIN_MONITOR_ROOT ? path.resolve(process.env.DOUYIN_MONITOR_ROOT) : ROOT_DIR,
    includeDoctor: true
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--root') options.rootDir = path.resolve(next());
    else if (arg === '--no-doctor') options.includeDoctor = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readPackage(rootDir) {
  const pkg = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
  return {
    name: pkg.name || '',
    version: pkg.version || '',
    private: Boolean(pkg.private),
    scripts: pkg.scripts || {}
  };
}

function summarizeScripts(scripts) {
  const available = {};
  const missing = [];
  for (const name of EXPECTED_SCRIPTS) {
    available[name] = Boolean(scripts[name]);
    if (!scripts[name]) missing.push(name);
  }
  return { available, missing };
}

function summarizeDoctor(report) {
  return {
    level: report.level || 'unknown',
    checks: (report.checks || []).map((item) => ({
      name: item.name,
      level: item.level,
      message: item.message
    })),
    runtimeHealth: report.runtimeHealth ? {
      level: report.runtimeHealth.level,
      headline: report.runtimeHealth.headline,
      recommendation: report.runtimeHealth.recommendation,
      recommendedRuntime: report.runtimeHealth.recommendedRuntime
    } : null
  };
}

async function doctorSummary(rootDir, includeDoctor) {
  if (!includeDoctor) return { skipped: true, command: 'npm run doctor -- --json' };
  try {
    const report = await runDoctor({
      runtime: process.env.DOUYIN_RUNTIME || 'auto',
      cdpUrl: process.env.DOUYIN_CDP_URL || '',
      browserApp: process.env.DOUYIN_BROWSER_APP || '',
      profile: process.env.DOUYIN_PROFILE ? path.resolve(rootDir, process.env.DOUYIN_PROFILE) : path.join(rootDir, '.douyin-browser'),
      outDir: path.join(rootDir, 'data'),
      cookieFile: process.env.DOUYIN_COOKIE_FILE || path.join(rootDir, 'data', 'auth', 'douyin-cookies.json')
    });
    return summarizeDoctor(report);
  } catch (error) {
    return { level: 'action', error: String(error.message || error).split('\n')[0] };
  }
}

async function dashboardReachable(port = 4573) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 750 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

async function launchdSummary() {
  if (process.platform !== 'darwin') {
    return { supported: false, loaded: false };
  }
  try {
    const { stdout } = await execFileAsync('launchctl', ['print', `gui/${process.getuid()}/${LAUNCHD_LABEL}`], { maxBuffer: 1024 * 1024 });
    const pid = stdout.match(/\bpid = (\d+)/)?.[1] || null;
    const lastExitCode = stdout.match(/\blast exit code = (-?\d+)/)?.[1] || null;
    return {
      supported: true,
      loaded: true,
      running: Boolean(pid),
      pid: pid ? Number(pid) : null,
      lastExitCode: lastExitCode === null ? null : Number(lastExitCode)
    };
  } catch {
    return { supported: true, loaded: false, running: false, pid: null, lastExitCode: null };
  }
}

function summarizeLatestRun(summary) {
  if (!summary?.latestRun) return null;
  const run = summary.latestRun;
  return {
    mode: run.mode || '',
    requestedMode: run.requestedMode || '',
    status: run.status || '',
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
    profileFollowerCount: run.profileFollowerCount ?? null,
    enumerableCount: run.enumerableCount ?? null,
    pagesFetched: run.pagesFetched ?? null,
    reason: run.reason || ''
  };
}

async function buildSkillInspectReport({ rootDir = ROOT_DIR, includeDoctor = true } = {}) {
  const pkg = await readPackage(rootDir);
  const summary = await getDashboardSummary({
    dbPath: path.join(rootDir, 'data', 'followers.db'),
    outDir: path.join(rootDir, 'data')
  });
  return {
    generatedAt: new Date().toISOString(),
    project: {
      name: pkg.name,
      version: pkg.version,
      private: pkg.private,
      rootName: path.basename(rootDir)
    },
    scripts: summarizeScripts(pkg.scripts),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      runtime: process.env.DOUYIN_RUNTIME || 'auto',
      cdpConfigured: Boolean(process.env.DOUYIN_CDP_URL),
      cookieFileConfigured: Boolean(process.env.DOUYIN_COOKIE_FILE),
      browserAppConfigured: Boolean(process.env.DOUYIN_BROWSER_APP)
    },
    doctor: await doctorSummary(rootDir, includeDoctor),
    data: {
      hasDatabase: summary.hasDatabase,
      statusCounts: summary.statusCounts,
      profileFollowerCount: summary.profileFollowerCount,
      enumerableCount: summary.enumerableCount,
      hiddenOrUnavailableCount: summary.hiddenOrUnavailableCount,
      lastChangeCounts: summary.lastChangeCounts,
      latestRun: summarizeLatestRun(summary)
    },
    dashboard: {
      localUrl: 'http://127.0.0.1:4573',
      reachable: await dashboardReachable()
    },
    launchd: await launchdSummary()
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  console.log(JSON.stringify(await buildSkillInspectReport(options), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export { buildSkillInspectReport, parseArgs };
