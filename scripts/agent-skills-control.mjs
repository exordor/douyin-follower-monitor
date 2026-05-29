#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const LABEL = 'com.exordor.douyin-follower-monitor';

const ACTIONS = new Map([
  ['doctor', { mutating: false, command: ['npm', ['run', 'doctor']] }],
  ['privacy-check', { mutating: false, command: ['npm', ['run', 'privacy:check']] }],
  ['debug-bundle', { mutating: true, command: ['npm', ['run', 'debug:bundle']] }],
  ['monitor', { mutating: true, command: ['npm', ['run', 'monitor']] }],
  ['monitor-doubao', { mutating: true, command: ['npm', ['run', 'monitor:doubao']] }],
  ['dashboard', { mutating: true, command: ['npm', ['run', 'dashboard']] }],
  ['dashboard-doubao', { mutating: true, command: ['npm', ['run', 'dashboard:doubao']] }],
  ['launchd-install-hourly', { mutating: true, launchd: 'install' }],
  ['launchd-status', { mutating: false, launchd: 'status' }],
  ['launchd-kickstart', { mutating: true, launchd: 'kickstart' }],
  ['launchd-stop', { mutating: true, launchd: 'stop' }]
]);

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function parseArgs(argv) {
  const options = {
    action: '',
    yes: false,
    dryRun: false,
    rootDir: process.env.DOUYIN_MONITOR_ROOT ? path.resolve(process.env.DOUYIN_MONITOR_ROOT) : ROOT_DIR
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (!options.action && !arg.startsWith('--')) options.action = arg;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--root') options.rootDir = path.resolve(next());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.action) throw new Error(`Missing action. Allowed actions: ${[...ACTIONS.keys()].join(', ')}`);
  if (!ACTIONS.has(options.action)) throw new Error(`Unknown action: ${options.action}. Allowed actions: ${[...ACTIONS.keys()].join(', ')}`);
  return options;
}

function commandForAction(action) {
  const spec = ACTIONS.get(action);
  if (!spec?.command) return null;
  const [bin, args] = spec.command;
  return { bin: bin === 'npm' ? npmCommand() : bin, args };
}

function launchdPaths(rootDir) {
  const home = os.homedir();
  return {
    plist: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    launchAgentsDir: path.join(home, 'Library', 'LaunchAgents'),
    logDir: path.join(home, 'Library', 'Logs', 'douyin-follower-monitor'),
    stdout: path.join(home, 'Library', 'Logs', 'douyin-follower-monitor', 'monitor.out.log'),
    stderr: path.join(home, 'Library', 'Logs', 'douyin-follower-monitor', 'monitor.err.log'),
    cookieFile: path.join(rootDir, 'data', 'auth', 'douyin-cookies.json')
  };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plistContent(rootDir) {
  const paths = launchdPaths(rootDir);
  const args = [
    process.execPath,
    '--disable-warning=ExperimentalWarning',
    'scripts/collect-followers.mjs',
    '--api',
    '--mode',
    'monitor',
    '--runtime',
    'playwright',
    '--cookie-file',
    paths.cookieFile,
    '--auth-wait-seconds',
    '300'
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(rootDir)}</string>
    <key>ProgramArguments</key>
    <array>
${args.map((arg) => `      <string>${xmlEscape(arg)}</string>`).join('\n')}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Minute</key>
      <integer>5</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${xmlEscape(paths.stdout)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(paths.stderr)}</string>
  </dict>
</plist>
`;
}

function launchdDryRun(action, rootDir) {
  const paths = launchdPaths(rootDir);
  const service = `gui/${process.getuid?.() ?? '[uid]'}/${LABEL}`;
  if (action === 'install') {
    return {
      platform: 'darwin',
      plistBasename: path.basename(paths.plist),
      schedule: 'hourly at minute 5',
      command: [process.execPath, '--disable-warning=ExperimentalWarning', 'scripts/collect-followers.mjs', '--api', '--mode', 'monitor', '--runtime', 'playwright', '--cookie-file', 'data/auth/douyin-cookies.json', '--auth-wait-seconds', '300'],
      launchctl: [
        ['bootout', `gui/${process.getuid?.() ?? '[uid]'}`, paths.plist],
        ['bootstrap', `gui/${process.getuid?.() ?? '[uid]'}`, paths.plist]
      ]
    };
  }
  if (action === 'status') return { platform: 'darwin', launchctl: ['print', service] };
  if (action === 'kickstart') return { platform: 'darwin', launchctl: ['kickstart', '-k', service] };
  if (action === 'stop') return { platform: 'darwin', launchctl: ['bootout', `gui/${process.getuid?.() ?? '[uid]'}`, paths.plist] };
  return {};
}

async function runCommand(bin, args, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve({ code, signal });
      else reject(new Error(`${bin} ${args.join(' ')} exited with ${code ?? signal}`));
    });
  });
}

async function runLaunchd(action, rootDir) {
  if (process.platform !== 'darwin') {
    throw new Error(`launchd action "${action}" requires macOS`);
  }
  const uid = process.getuid();
  const paths = launchdPaths(rootDir);
  const gui = `gui/${uid}`;
  const service = `${gui}/${LABEL}`;
  if (action === 'install') {
    await mkdir(paths.launchAgentsDir, { recursive: true });
    await mkdir(paths.logDir, { recursive: true });
    await writeFile(paths.plist, plistContent(rootDir), { mode: 0o644 });
    try {
      await execFileAsync('launchctl', ['bootout', gui, paths.plist]);
    } catch {
      // The service may not be loaded yet.
    }
    await execFileAsync('launchctl', ['bootstrap', gui, paths.plist]);
    return { action, loaded: true, plist: path.basename(paths.plist) };
  }
  if (action === 'status') {
    try {
      const { stdout } = await execFileAsync('launchctl', ['print', service], { maxBuffer: 1024 * 1024 });
      const pid = stdout.match(/\bpid = (\d+)/)?.[1] || null;
      const lastExitCode = stdout.match(/\blast exit code = (-?\d+)/)?.[1] || null;
      return { action, loaded: true, running: Boolean(pid), pid: pid ? Number(pid) : null, lastExitCode: lastExitCode === null ? null : Number(lastExitCode) };
    } catch {
      return { action, loaded: false, running: false, pid: null, lastExitCode: null };
    }
  }
  if (action === 'kickstart') {
    await execFileAsync('launchctl', ['kickstart', '-k', service]);
    return { action, kicked: true };
  }
  if (action === 'stop') {
    await execFileAsync('launchctl', ['bootout', gui, paths.plist]);
    return { action, stopped: true };
  }
  throw new Error(`Unsupported launchd action: ${action}`);
}

async function executeControlAction({ action, yes = false, dryRun = false, rootDir = ROOT_DIR } = {}) {
  const spec = ACTIONS.get(action);
  if (!spec) throw new Error(`Unknown action: ${action}`);
  const command = commandForAction(action);
  const launchd = spec.launchd ? launchdDryRun(spec.launchd, rootDir) : null;
  const plan = {
    action,
    mutating: spec.mutating,
    requiresYes: spec.mutating,
    willExecute: !dryRun && (!spec.mutating || yes),
    cwd: path.basename(rootDir),
    command: command ? [command.bin, ...command.args] : null,
    launchd
  };
  if (dryRun || (spec.mutating && !yes)) return { status: 'dry-run', plan };
  if (spec.launchd) {
    return { status: 'completed', result: await runLaunchd(spec.launchd, rootDir) };
  }
  await runCommand(command.bin, command.args, { cwd: rootDir });
  return { status: 'completed', action };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await executeControlAction(options);
  if (result.status === 'dry-run') {
    console.log(JSON.stringify(result, null, 2));
    if (result.plan.mutating) {
      console.log('Dry run only. Re-run with --yes after explicit user confirmation.');
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export { ACTIONS, executeControlAction, launchdDryRun, parseArgs };
