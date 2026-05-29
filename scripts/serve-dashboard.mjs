#!/usr/bin/env node

import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  defaultCookieFile,
  getCookieAuthStatus,
  removeCookieAuthFile,
  saveCookieAuthFile
} from './cookie-auth.mjs';
import {
  DEFAULT_DB,
  DEFAULT_OUT_DIR,
  getDashboardEventDaily,
  getDashboardEvents,
  getDashboardExport,
  getDashboardFollowers,
  getDashboardCompare,
  getDashboardRun,
  getDashboardRunEvents,
  getDashboardRuns,
  getDashboardSummary,
  getDashboardTimeline
} from './dashboard-data.mjs';
import { buildRuntimeHealth } from './dashboard-runtime-health.mjs';
import { createScanJobManager } from './dashboard-scan-job.mjs';

const ROOT_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_STATIC_DIR = path.join(ROOT_DIR, 'web', 'dist');
const DEFAULT_BROWSER_APP = 'com.bot.pc.doubao.browser';

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
    staticDir: DEFAULT_STATIC_DIR,
    runtime: process.env.DOUYIN_RUNTIME || 'auto',
    profile: process.env.DOUYIN_PROFILE || path.join(ROOT_DIR, '.douyin-browser'),
    cdpUrl: process.env.DOUYIN_CDP_URL || '',
    browserApp: process.env.DOUYIN_BROWSER_APP || '',
    cookieFile: process.env.DOUYIN_COOKIE_FILE ? path.resolve(process.env.DOUYIN_COOKIE_FILE) : '',
    authWaitSeconds: Number.parseInt(process.env.DOUYIN_AUTH_WAIT_SECONDS || '300', 10)
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') options.db = path.resolve(argv[++index]);
    else if (arg === '--out-dir') options.outDir = path.resolve(argv[++index]);
    else if (arg === '--port') options.port = Number.parseInt(argv[++index], 10);
    else if (arg === '--host') options.host = argv[++index];
    else if (arg === '--static-dir') options.staticDir = path.resolve(argv[++index]);
    else if (arg === '--runtime') options.runtime = argv[++index];
    else if (arg === '--profile') options.profile = path.resolve(argv[++index]);
    else if (arg === '--cdp-url') options.cdpUrl = argv[++index];
    else if (arg === '--browser-app') options.browserApp = argv[++index];
    else if (arg === '--cookie-file') options.cookieFile = path.resolve(argv[++index]);
    else if (arg === '--auth-wait-seconds') options.authWaitSeconds = Number.parseInt(argv[++index], 10);
    else if (arg === '--help' || arg === '-h') options.help = true;
  }

  if (!Number.isFinite(options.authWaitSeconds) || options.authWaitSeconds < 0) options.authWaitSeconds = 300;
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
  --runtime <runtime>  Browser runtime: auto, playwright, cdp, apple-events (default: auto)
  --profile <path>     Playwright profile path (default: .douyin-browser)
  --cdp-url <url>      Chrome DevTools Protocol endpoint
  --browser-app <id>   Browser bundle id used by apple-events runtime, e.g. ${DEFAULT_BROWSER_APP}
  --cookie-file <path> cookie-manager lossless JSON for playwright/cdp runtime
  --auth-wait-seconds <n>
                       Seconds dashboard-launched scans wait for manual login/captcha (default: 300)
`);
}

function sendJson(res, statusCode, value, headers = {}) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendText(res, statusCode, contentType, body) {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store'
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

function isLoopbackOrigin(origin) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function corsHeadersFor(req, allowPost = false) {
  const origin = req.headers.origin;
  const headers = {
    vary: 'Origin',
    'access-control-allow-methods': allowPost ? 'GET, POST, DELETE, OPTIONS' : 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type, x-douyin-dashboard-action'
  };
  if (origin && isLoopbackOrigin(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
}

function applyCorsHeaders(res, req, allowPost = false) {
  for (const [name, value] of Object.entries(corsHeadersFor(req, allowPost))) {
    res.setHeader(name, value);
  }
}

function allowedDashboardAction(req, expectedAction) {
  const token = req.headers['x-douyin-dashboard-action'];
  if (token !== expectedAction) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  return isLoopbackOrigin(origin);
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > maxBytes) {
        reject(new Error('request-body-too-large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('invalid-json-body'));
      }
    });
    req.on('error', reject);
  });
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

async function handleScanApi(req, res, url, scanManager) {
  if (url.pathname === '/api/scan/events') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method-not-allowed' }, corsHeadersFor(req));
      return true;
    }
    await scanManager.subscribe(req, res);
    return true;
  }

  if (url.pathname === '/api/scan/status') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method-not-allowed' }, corsHeadersFor(req));
      return true;
    }
    sendJson(res, 200, await scanManager.status(), corsHeadersFor(req));
    return true;
  }

  if (url.pathname === '/api/scan/start' || url.pathname === '/api/scan/stop') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' }, corsHeadersFor(req, true));
      return true;
    }
    if (!allowedDashboardAction(req, 'scan')) {
      sendJson(res, 403, { error: 'scan-post-forbidden' }, corsHeadersFor(req, true));
      return true;
    }
    const result = url.pathname.endsWith('/start') ? await scanManager.start() : await scanManager.stop();
    sendJson(res, result.statusCode, result.body, corsHeadersFor(req, true));
    return true;
  }

  return false;
}

async function handleAuthApi(req, res, url, options, scanManager) {
  if (!url.pathname.startsWith('/api/auth/cookies')) return false;

  const scanStatus = await scanManager.status();
  const runtime = scanStatus.runtime || options.runtime || 'auto';

  if (url.pathname !== '/api/auth/cookies/status' && url.pathname !== '/api/auth/cookies/import' && url.pathname !== '/api/auth/cookies') {
    return false;
  }

  if (url.pathname === '/api/auth/cookies/status') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method-not-allowed' }, corsHeadersFor(req, true));
      return true;
    }
    sendJson(res, 200, await getCookieAuthStatus({ cookieFile: options.cookieFile, runtime }), corsHeadersFor(req));
    return true;
  }

  if (url.pathname === '/api/auth/cookies/import') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' }, corsHeadersFor(req, true));
      return true;
    }
    if (!allowedDashboardAction(req, 'auth')) {
      sendJson(res, 403, { error: 'auth-post-forbidden' }, corsHeadersFor(req, true));
      return true;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: error.message }, corsHeadersFor(req, true));
      return true;
    }
    if (typeof body.content !== 'string') {
      sendJson(res, 400, { error: 'cookie-content-required' }, corsHeadersFor(req, true));
      return true;
    }
    const status = await saveCookieAuthFile({ cookieFile: options.cookieFile, content: body.content });
    status.runtimeSupported = runtime === 'playwright' || runtime === 'cdp';
    sendJson(res, 200, status, corsHeadersFor(req, true));
    return true;
  }

  if (url.pathname === '/api/auth/cookies') {
    if (req.method !== 'DELETE') {
      sendJson(res, 405, { error: 'method-not-allowed' }, corsHeadersFor(req, true));
      return true;
    }
    if (!allowedDashboardAction(req, 'auth')) {
      sendJson(res, 403, { error: 'auth-post-forbidden' }, corsHeadersFor(req, true));
      return true;
    }
    const status = await removeCookieAuthFile(options.cookieFile);
    status.runtimeSupported = runtime === 'playwright' || runtime === 'cdp';
    sendJson(res, 200, status, corsHeadersFor(req, true));
    return true;
  }

  return false;
}

async function handleApi(req, res, url, options, scanManager) {
  const common = { dbPath: options.db, outDir: options.outDir };

  if (url.pathname.startsWith('/api/scan/')) {
    return handleScanApi(req, res, url, scanManager);
  }
  if (url.pathname.startsWith('/api/auth/cookies')) {
    return handleAuthApi(req, res, url, options, scanManager);
  }
  if (url.pathname === '/api/runtime/health') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method-not-allowed' }, corsHeadersFor(req));
      return true;
    }
    const scanStatus = await scanManager.status();
    const cookieAuth = await getCookieAuthStatus({
      cookieFile: options.cookieFile,
      runtime: scanStatus.runtime || options.runtime || 'auto'
    });
    const latestError = await readJsonIfExists(path.join(options.outDir, 'latest-error.json'));
    sendJson(res, 200, buildRuntimeHealth({ scanStatus, cookieAuth, latestError }), corsHeadersFor(req));
    return true;
  }

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
  const runEventsMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (runEventsMatch) {
    const runId = decodeURIComponent(runEventsMatch[1]);
    const run = await getDashboardRun({ ...common, runId });
    if (!run) sendJson(res, 404, { error: 'run-not-found', runId });
    else sendJson(res, 200, await getDashboardRunEvents({
      ...common,
      runId,
      type: url.searchParams.get('type') || '',
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset')
    }));
    return true;
  }
  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1]);
    const run = await getDashboardRun({ ...common, runId });
    if (!run) sendJson(res, 404, { error: 'run-not-found', runId });
    else sendJson(res, 200, run);
    return true;
  }
  if (url.pathname === '/api/compare') {
    const compared = await getDashboardCompare({
      ...common,
      from: url.searchParams.get('from') || '',
      to: url.searchParams.get('to') || ''
    });
    if (!compared) sendJson(res, 404, { error: 'compare-runs-not-found' });
    else sendJson(res, 200, compared);
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

function createDashboardServer(options = {}) {
  const resolvedOptions = {
    db: options.db || DEFAULT_DB,
    outDir: options.outDir || DEFAULT_OUT_DIR,
    port: options.port || 4573,
    host: options.host || '127.0.0.1',
    staticDir: options.staticDir || DEFAULT_STATIC_DIR,
    runtime: options.runtime || 'auto',
    profile: options.profile || path.join(ROOT_DIR, '.douyin-browser'),
    cdpUrl: options.cdpUrl || '',
    browserApp: options.browserApp || '',
    cookieFile: options.cookieFile || '',
    authWaitSeconds: options.authWaitSeconds ?? 300
  };
  resolvedOptions.cookieFile = resolvedOptions.cookieFile || defaultCookieFile(resolvedOptions.outDir);
  const scanManager = options.scanManager || createScanJobManager({
    rootDir: ROOT_DIR,
    db: resolvedOptions.db,
    outDir: resolvedOptions.outDir,
    runtime: resolvedOptions.runtime,
    profile: resolvedOptions.profile,
    cdpUrl: resolvedOptions.cdpUrl,
    browserApp: resolvedOptions.browserApp,
    cookieFile: resolvedOptions.cookieFile,
    authWaitSeconds: resolvedOptions.authWaitSeconds
  });

  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${resolvedOptions.host}:${resolvedOptions.port}`);
    const isApiPath = url.pathname.startsWith('/api/');
    const isScanPath = url.pathname.startsWith('/api/scan/');
    const isAuthPath = url.pathname.startsWith('/api/auth/cookies');
    const allowApiPost = isScanPath || isAuthPath;

    if (isApiPath && !isLoopbackOrigin(req.headers.origin)) {
      sendJson(res, 403, { error: 'api-origin-forbidden' });
      return;
    }

    if (isApiPath) {
      applyCorsHeaders(res, req, allowApiPost);
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeadersFor(req, allowApiPost)
      });
      res.end();
      return;
    }

    if (req.method !== 'GET' && !isScanPath && !isAuthPath) {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }

    try {
      if (url.pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, url, resolvedOptions, scanManager);
        if (!handled) sendJson(res, 404, { error: 'api-not-found' });
        return;
      }

      const staticPath = safeStaticPath(resolvedOptions.staticDir, url.pathname);
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
