#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveBrowserRuntimeConfig } from './browser-runtime.mjs';
import { defaultCookieFile, getCookieAuthStatus } from './cookie-auth.mjs';
import { buildRuntimeHealth } from './dashboard-runtime-health.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = {
    json: false,
    runtime: process.env.DOUYIN_RUNTIME || 'auto',
    cdpUrl: process.env.DOUYIN_CDP_URL || '',
    browserApp: process.env.DOUYIN_BROWSER_APP || '',
    profile: process.env.DOUYIN_PROFILE ? path.resolve(ROOT_DIR, process.env.DOUYIN_PROFILE) : path.join(ROOT_DIR, '.douyin-browser'),
    outDir: path.join(ROOT_DIR, 'data'),
    cookieFile: process.env.DOUYIN_COOKIE_FILE ? path.resolve(ROOT_DIR, process.env.DOUYIN_COOKIE_FILE) : '',
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--json') options.json = true;
    else if (arg === '--runtime') options.runtime = next();
    else if (arg === '--cdp-url') options.cdpUrl = next();
    else if (arg === '--browser-app') options.browserApp = next();
    else if (arg === '--profile') options.profile = path.resolve(ROOT_DIR, next());
    else if (arg === '--cookie-file') options.cookieFile = path.resolve(ROOT_DIR, next());
    else if (arg === '--out-dir') options.outDir = path.resolve(ROOT_DIR, next());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.cookieFile = options.cookieFile || defaultCookieFile(options.outDir);
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/doctor.mjs [options]

Options:
  --json                Print machine-readable JSON
  --runtime <runtime>   Browser runtime: auto, playwright, cdp, apple-events
  --cdp-url <url>       Chrome DevTools Protocol endpoint
  --browser-app <id>    Browser app for Apple Events runtime
  --profile <path>      Playwright profile path
  --cookie-file <path>  cookie-manager lossless JSON path
  --out-dir <path>      Data directory to test (default: data)
`);
}

function levelRank(level) {
  return { ok: 0, warning: 1, action: 2 }[level] ?? 1;
}

function combineLevel(checks) {
  return checks.reduce((level, item) => (levelRank(item.level) > levelRank(level) ? item.level : level), 'ok');
}

function check(name, level, message, detail = {}) {
  return { name, level, message, detail };
}

async function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  return check(
    'node',
    major >= 24 ? 'ok' : 'action',
    major >= 24 ? `Node ${process.versions.node}` : `Node ${process.versions.node}; requires >=24`,
    { version: process.versions.node, required: '>=24' }
  );
}

async function checkDependencies(rootDir = ROOT_DIR) {
  const packageLock = existsSync(path.join(rootDir, 'package-lock.json'));
  const nodeModules = existsSync(path.join(rootDir, 'node_modules'));
  return check(
    'dependencies',
    packageLock && nodeModules ? 'ok' : 'action',
    packageLock && nodeModules ? 'Dependencies look installed' : 'Run npm ci before collecting',
    { packageLock, nodeModules }
  );
}

async function checkPlaywright() {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return check('playwright', 'ok', 'Playwright Chromium can launch');
  } catch (error) {
    return check('playwright', 'action', 'Playwright Chromium cannot launch', { error: String(error.message || error).split('\n')[0] });
  }
}

async function checkCdp(cdpUrl) {
  if (!cdpUrl) return check('cdp', 'warning', 'CDP URL is not configured');
  try {
    const response = await fetch(new URL('/json/version', cdpUrl), { signal: AbortSignal.timeout(2500) });
    return check('cdp', response.ok ? 'ok' : 'action', response.ok ? 'CDP endpoint is reachable' : `CDP endpoint returned ${response.status}`);
  } catch (error) {
    return check('cdp', 'action', 'CDP endpoint is not reachable', { error: String(error.message || error) });
  }
}

async function checkWritableOutDir(outDir) {
  const probe = path.join(outDir, `.doctor-${process.pid}.tmp`);
  try {
    await mkdir(outDir, { recursive: true });
    await writeFile(probe, 'ok\n', { mode: 0o600 });
    await access(probe);
    await rm(probe, { force: true });
    const { DatabaseSync } = await import('node:sqlite');
    const dbPath = path.join(outDir, `.doctor-${process.pid}.db`);
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE IF NOT EXISTS doctor_probe (ok INTEGER)');
    db.close();
    await rm(dbPath, { force: true });
    return check('storage', 'ok', 'Data directory is writable and SQLite can create a database', { outDir: path.basename(outDir) });
  } catch (error) {
    return check('storage', 'action', 'Data directory or SQLite check failed', { error: String(error.message || error) });
  }
}

async function readLatestError(outDir) {
  try {
    return JSON.parse(await readFile(path.join(outDir, 'latest-error.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function runDoctor(options = {}) {
  const checks = [];
  checks.push(await checkNodeVersion());
  checks.push(await checkDependencies());
  checks.push(await checkPlaywright());
  checks.push(await checkCdp(options.cdpUrl));
  checks.push(await checkWritableOutDir(options.outDir));

  let runtimeConfig;
  try {
    runtimeConfig = resolveBrowserRuntimeConfig(
      { runtime: options.runtime, cdpUrl: options.cdpUrl, browserApp: options.browserApp, profile: options.profile, cookieFile: '' },
      { ...process.env, DOUYIN_COOKIE_FILE: '' }
    );
    checks.push(check('runtime', 'ok', `Runtime resolves to ${runtimeConfig.runtimeLabel}`, { runtime: runtimeConfig.runtime }));
  } catch (error) {
    runtimeConfig = { runtime: options.runtime || 'auto', runtimeLabel: options.runtime || 'auto' };
    checks.push(check('runtime', 'action', 'Runtime configuration is invalid', { error: String(error.message || error) }));
  }

  const cookieAuth = await getCookieAuthStatus({ cookieFile: options.cookieFile, runtime: runtimeConfig.runtime });
  checks.push(check(
    'cookie',
    cookieAuth.error ? 'action' : cookieAuth.configured ? 'ok' : 'warning',
    cookieAuth.error
      ? 'Cookie file cannot be parsed'
      : cookieAuth.configured
        ? `Cookie file configured with ${cookieAuth.acceptedCount}/${cookieAuth.cookieCount} accepted cookies`
        : 'Cookie file is not configured',
    {
      configured: cookieAuth.configured,
      acceptedCount: cookieAuth.acceptedCount,
      cookieCount: cookieAuth.cookieCount,
      skippedCount: cookieAuth.skippedCount,
      runtimeSupported: cookieAuth.runtimeSupported
    }
  ));

  const runtimeHealth = buildRuntimeHealth({
    scanStatus: {
      runtime: runtimeConfig.runtime,
      runtimeLabel: runtimeConfig.runtimeLabel,
      phase: 'idle',
      authChallenge: null
    },
    cookieAuth,
    latestError: await readLatestError(options.outDir)
  });

  const level = combineLevel(checks);
  return {
    generatedAt: new Date().toISOString(),
    level,
    checks,
    runtimeHealth,
    nextSteps: checks
      .filter((item) => item.level !== 'ok')
      .map((item) => item.message)
  };
}

function printHuman(report) {
  const marker = { ok: 'OK', warning: 'WARN', action: 'ACTION' };
  console.log(`Doctor: ${marker[report.level] || report.level}`);
  for (const item of report.checks) {
    console.log(`- ${marker[item.level] || item.level} ${item.name}: ${item.message}`);
  }
  console.log(`Runtime: ${report.runtimeHealth.headline}`);
  console.log(report.runtimeHealth.recommendation);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const report = await runDoctor(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  if (report.level === 'action') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export { parseArgs, runDoctor };
