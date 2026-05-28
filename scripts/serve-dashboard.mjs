#!/usr/bin/env node

import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_DB,
  DEFAULT_OUT_DIR,
  getDashboardEventDaily,
  getDashboardEvents,
  getDashboardExport,
  getDashboardFollowers,
  getDashboardRuns,
  getDashboardSummary,
  getDashboardTimeline
} from './dashboard-data.mjs';

const ROOT_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_STATIC_DIR = path.join(ROOT_DIR, 'web', 'dist');

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8']
]);

function parseArgs(argv) {
  const options = {
    db: DEFAULT_DB,
    outDir: DEFAULT_OUT_DIR,
    port: Number(process.env.PORT || 4573),
    host: '127.0.0.1',
    staticDir: DEFAULT_STATIC_DIR
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') options.db = path.resolve(argv[++index]);
    else if (arg === '--out-dir') options.outDir = path.resolve(argv[++index]);
    else if (arg === '--port') options.port = Number.parseInt(argv[++index], 10);
    else if (arg === '--host') options.host = argv[++index];
    else if (arg === '--static-dir') options.staticDir = path.resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') options.help = true;
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/serve-dashboard.mjs [options]

Options:
  --db <path>          SQLite database path (default: data/followers.db)
  --out-dir <path>     Export directory containing latest.json/csv (default: data)
  --port <number>      HTTP port (default: 4573)
  --host <host>        Bind host (default: 127.0.0.1)
  --static-dir <path>  Built dashboard directory (default: web/dist)
`);
}

function sendJson(res, statusCode, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  res.end(body);
}

function sendText(res, statusCode, contentType, body) {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  res.end(body);
}

function safeStaticPath(staticDir, pathname) {
  const decoded = decodeURIComponent(pathname);
  const requested = decoded === '/' ? '/index.html' : decoded;
  const target = path.resolve(staticDir, `.${requested}`);
  if (!target.startsWith(path.resolve(staticDir))) return null;
  if (existsSync(target)) return target;
  return path.join(staticDir, 'index.html');
}

async function handleApi(req, res, url, options) {
  const common = { dbPath: options.db, outDir: options.outDir };

  if (url.pathname === '/api/summary') {
    sendJson(res, 200, await getDashboardSummary(common));
    return true;
  }
  if (url.pathname === '/api/timeline') {
    sendJson(res, 200, await getDashboardTimeline({ ...common, days: url.searchParams.get('days') }));
    return true;
  }
  if (url.pathname === '/api/event-daily') {
    sendJson(res, 200, await getDashboardEventDaily({ ...common, days: url.searchParams.get('days') }));
    return true;
  }
  if (url.pathname === '/api/events') {
    sendJson(res, 200, await getDashboardEvents({
      ...common,
      type: url.searchParams.get('type') || '',
      q: url.searchParams.get('q') || '',
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset')
    }));
    return true;
  }
  if (url.pathname === '/api/followers') {
    sendJson(res, 200, await getDashboardFollowers({
      ...common,
      status: url.searchParams.get('status') || '',
      q: url.searchParams.get('q') || '',
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset')
    }));
    return true;
  }
  if (url.pathname === '/api/runs') {
    sendJson(res, 200, await getDashboardRuns({ ...common, limit: url.searchParams.get('limit') }));
    return true;
  }
  if (url.pathname === '/api/export/latest.json' || url.pathname === '/api/export/latest.csv') {
    const name = path.basename(url.pathname);
    const exported = await getDashboardExport({ outDir: options.outDir, name });
    if (!exported) sendJson(res, 404, { error: 'export-not-found', name });
    else sendText(res, 200, exported.contentType, exported.body);
    return true;
  }

  return false;
}

function createDashboardServer(options) {
  return createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'content-type'
      });
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }

    try {
      const url = new URL(req.url || '/', `http://${options.host}:${options.port}`);
      if (url.pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, url, options);
        if (!handled) sendJson(res, 404, { error: 'api-not-found' });
        return;
      }

      const staticPath = safeStaticPath(options.staticDir, url.pathname);
      if (!staticPath || !existsSync(staticPath)) {
        sendJson(res, 404, { error: 'not-found' });
        return;
      }

      const ext = path.extname(staticPath).toLowerCase();
      res.writeHead(200, {
        'content-type': MIME_TYPES.get(ext) || 'application/octet-stream',
        'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
      });
      createReadStream(staticPath).pipe(res);
    } catch (error) {
      sendJson(res, 500, { error: 'dashboard-server-error', message: error.message });
    }
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const server = createDashboardServer(options);
  server.listen(options.port, options.host, () => {
    console.log(`Dashboard: http://${options.host}:${options.port}`);
    console.log(`SQLite: ${options.db}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export { createDashboardServer, parseArgs };
