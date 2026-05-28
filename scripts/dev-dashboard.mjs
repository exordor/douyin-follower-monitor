#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const API_PORT = process.env.DASHBOARD_API_PORT || '4573';
const WEB_PORT = process.env.DASHBOARD_WEB_PORT || '5173';

function run(name, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: ROOT_DIR,
    env: { ...process.env, ...env },
    stdio: 'inherit'
  });
  child.on('exit', (code, signal) => {
    if (signal) console.error(`${name} exited with ${signal}`);
    else if (code) console.error(`${name} exited with code ${code}`);
  });
  return child;
}

const api = run('dashboard-api', process.execPath, [
  '--disable-warning=ExperimentalWarning',
  'scripts/serve-dashboard.mjs',
  '--port',
  API_PORT,
  '--static-dir',
  path.join(ROOT_DIR, 'web', 'dist')
]);

const vite = run('vite', 'npx', [
  'vite',
  'web',
  '--host',
  '127.0.0.1',
  '--port',
  WEB_PORT
], {
  VITE_API_BASE: `http://127.0.0.1:${API_PORT}`
});

function shutdown(signal) {
  api.kill(signal);
  vite.kill(signal);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

console.log(`Dashboard dev UI: http://127.0.0.1:${WEB_PORT}`);
console.log(`Dashboard API: http://127.0.0.1:${API_PORT}`);
