import { spawn as defaultSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { resolveBrowserRuntimeConfig } from './browser-runtime.mjs';
import { defaultCookieFile, getCookieAuthStatus } from './cookie-auth.mjs';

const MAX_LOG_LINES = 120;
const MONITOR_EVENT_PREFIX = '__DOUYIN_MONITOR_EVENT__ ';
const DEFAULT_AUTH_WAIT_SECONDS = 300;

function nowId(date = new Date()) {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function trimLogLines(lines) {
  return lines.slice(Math.max(0, lines.length - MAX_LOG_LINES));
}

function phaseFromStatus(status) {
  if (status === 'idle') return 'idle';
  if (status === 'starting') return 'starting';
  if (status === 'stopping') return 'stopping';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'interrupted') return 'interrupted';
  return 'scanning';
}

function publicJob(job) {
  if (!job) {
    return {
      id: null,
      status: 'idle',
      mode: 'monitor',
      requestedMode: 'monitor',
      reason: '',
      startedAt: null,
      finishedAt: null,
      pagesFetched: 0,
      count: 0,
      profileFollowerCount: null,
      hiddenOrUnavailableCount: null,
      runtime: 'auto',
      runtimeLabel: '',
      cookieAuth: null,
      phase: 'idle',
      authChallenge: null,
      exitCode: null,
      signal: null,
      error: '',
      logLines: [],
      changeSummary: null,
      partial: null
    };
  }

  return {
    id: job.id,
    status: job.status,
    mode: job.mode,
    requestedMode: job.requestedMode,
    reason: job.reason,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    pagesFetched: job.pagesFetched,
    count: job.count,
    profileFollowerCount: job.profileFollowerCount,
    hiddenOrUnavailableCount: job.hiddenOrUnavailableCount,
    runtime: job.runtime,
    runtimeLabel: job.runtimeLabel,
    cookieAuth: job.cookieAuth || null,
    phase: job.phase || phaseFromStatus(job.status),
    authChallenge: job.authChallenge || null,
    exitCode: job.exitCode,
    signal: job.signal,
    error: job.error,
    logLines: trimLogLines(job.logLines),
    changeSummary: job.changeSummary || null,
    partial: job.partial || null
  };
}

function appendLog(job, line) {
  const text = String(line || '').trimEnd();
  if (!text) return;
  job.logLines.push(text);
  job.logLines = trimLogLines(job.logLines);
  parseLogLine(job, text);
}

function applyMonitorEvent(job, event) {
  if (!event || typeof event.type !== 'string') return false;

  if (event.type === 'auth_wait_started') {
    job.phase = 'waiting_for_verification';
    job.authChallenge = {
      kind: event.kind === 'login' ? 'login' : 'captcha',
      status: 'waiting',
      startedAt: event.startedAt || new Date().toISOString(),
      deadlineAt: event.deadlineAt || null,
      message: event.message || '请在浏览器中完成人工验证。'
    };
    return true;
  }

  if (event.type === 'auth_wait_transient_navigation') {
    job.phase = 'waiting_for_verification';
    job.authChallenge = {
      ...(job.authChallenge || {}),
      kind: event.kind === 'login' ? 'login' : (job.authChallenge?.kind || 'captcha'),
      status: 'waiting',
      startedAt: event.startedAt || job.authChallenge?.startedAt || new Date().toISOString(),
      deadlineAt: event.deadlineAt || job.authChallenge?.deadlineAt || null,
      message: event.message || job.authChallenge?.message || '页面正在跳转或验证中，继续等待。'
    };
    return true;
  }

  if (event.type === 'auth_wait_resolved') {
    job.phase = 'authenticating';
    job.authChallenge = {
      ...(job.authChallenge || {}),
      kind: event.kind === 'login' ? 'login' : (job.authChallenge?.kind || 'captcha'),
      status: 'resolved',
      startedAt: event.startedAt || job.authChallenge?.startedAt || new Date().toISOString(),
      deadlineAt: event.deadlineAt || job.authChallenge?.deadlineAt || null,
      message: event.message || '人工登录/验证已完成，继续采集。'
    };
    return true;
  }

  if (event.type === 'auth_wait_timeout') {
    job.phase = 'waiting_for_verification';
    job.authChallenge = {
      ...(job.authChallenge || {}),
      kind: event.kind === 'login' ? 'login' : (job.authChallenge?.kind || 'captcha'),
      status: 'timeout',
      startedAt: event.startedAt || job.authChallenge?.startedAt || new Date().toISOString(),
      deadlineAt: event.deadlineAt || job.authChallenge?.deadlineAt || null,
      message: event.message || '等待人工登录/验证码超时。'
    };
    return true;
  }

  return false;
}

function parseMonitorEventLine(job, line) {
  if (!line.startsWith(MONITOR_EVENT_PREFIX)) return false;
  try {
    const event = JSON.parse(line.slice(MONITOR_EVENT_PREFIX.length));
    return applyMonitorEvent(job, event);
  } catch {
    return false;
  }
}

function parseLogLine(job, line) {
  const modeMatch = line.match(/^扫描模式:\s*(\w+)\s*\(([^)]*)\)/);
  if (modeMatch) {
    job.mode = modeMatch[1];
    job.reason = modeMatch[2] || '';
    job.phase = 'scanning';
    return;
  }

  const runtimeMatch = line.match(/^Runtime:\s*(.+)\s+\(([^)]+)\)/);
  if (runtimeMatch) {
    job.runtimeLabel = runtimeMatch[1];
    job.runtime = runtimeMatch[2];
    if (job.phase === 'starting') job.phase = 'authenticating';
    return;
  }

  const pageMatch = line.match(/^API 第\s*(\d+)\s*页:\s*本页\s*(\d+)，累计\s*(\d+)，hasMore=(true|false)/);
  if (pageMatch) {
    job.pagesFetched = Number(pageMatch[1]);
    job.count = Number(pageMatch[3]);
    job.lastPageSize = Number(pageMatch[2]);
    job.hasMore = pageMatch[4] === 'true';
    job.phase = 'scanning';
    return;
  }

  const partialMatch = line.match(/^已保存进度:\s*(\d+)\s*->\s*(.+)$/);
  if (partialMatch) {
    job.count = Number(partialMatch[1]);
    job.partialSavedAt = new Date().toISOString();
    job.partialPath = partialMatch[2];
    job.phase = 'scanning';
    return;
  }

  const countMatch = line.match(/^当前采集数量:\s*(\d+)/);
  if (countMatch) {
    job.count = Number(countMatch[1]);
    return;
  }

  const diffMatch = line.match(/^主页粉丝数与可枚举列表差值:\s*(\d+)/);
  if (diffMatch) {
    job.hiddenOrUnavailableCount = Number(diffMatch[1]);
    return;
  }

  const changeMatch = line.match(/^新增:\s*(\d+)，疑似取关:\s*(\d+)，确认取关:\s*(\d+)，重新出现:\s*(\d+)，改名:\s*(\d+)/);
  if (changeMatch) {
    job.changeSummary = {
      newCount: Number(changeMatch[1]),
      suspectedRemovedCount: Number(changeMatch[2]),
      removedCount: Number(changeMatch[3]),
      reappearedCount: Number(changeMatch[4]),
      renamedCount: Number(changeMatch[5])
    };
    return;
  }

  const cookieMatch = line.match(/^Cookie 登录态:\s*已导入\s*(\d+)\/(\d+)，跳过\s*(\d+)(?:；跳过原因:\s*(.+))?/);
  if (cookieMatch) {
    job.cookieAuth = {
      configured: true,
      acceptedCount: Number(cookieMatch[1]),
      cookieCount: Number(cookieMatch[2]),
      skippedCount: Number(cookieMatch[3]),
      skippedReasons: (cookieMatch[4] || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
          const [reason, count] = item.split('=');
          return { reason, count: Number(count || 0) };
        })
    };
  }
}

function feedChunk(job, emitter, chunk) {
  job.buffer += chunk.toString();
  const lines = job.buffer.split(/\r?\n/);
  job.buffer = lines.pop() || '';
  for (const line of lines) {
    if (parseMonitorEventLine(job, line)) {
      emitter.emit('update');
      continue;
    }
    appendLog(job, line);
    emitter.emit('update');
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

function partialSummaryFromSnapshot(partial) {
  return {
    collectedAt: partial.collectedAt || null,
    status: partial.status || '',
    mode: partial.mode || '',
    requestedMode: partial.requestedMode || '',
    reason: partial.reason || '',
    runtime: partial.runtime || '',
    runtimeLabel: partial.runtimeLabel || '',
    cookieAuth: partial.cookieAuth || null,
    pagesFetched: partial.pagesFetched || 0,
    count: partial.count || 0,
    scanComplete: partial.scanComplete ?? null,
    profileFollowerCount: partial.profileStats?.followers ?? null
  };
}

function partialMatchesJob(partialSummary, startedAt, status) {
  if (status === 'idle') return true;
  const partialTime = partialSummary.collectedAt ? Date.parse(partialSummary.collectedAt) : 0;
  const startedTime = startedAt ? Date.parse(startedAt) : 0;
  return Boolean(partialTime && startedTime && partialTime >= startedTime - 2000);
}

function snapshotMatchesJob(snapshot, startedAt) {
  const snapshotTime = snapshot?.collectedAt ? Date.parse(snapshot.collectedAt) : 0;
  const startedTime = startedAt ? Date.parse(startedAt) : 0;
  return Boolean(snapshotTime && startedTime && snapshotTime >= startedTime - 2000);
}

function mergePartialIntoStatus(status, partialSummary) {
  status.partial = partialSummary;
  status.pagesFetched = Math.max(status.pagesFetched || 0, partialSummary.pagesFetched || 0);
  status.count = Math.max(status.count || 0, partialSummary.count || 0);
  status.profileFollowerCount = status.profileFollowerCount ?? partialSummary.profileFollowerCount;
  if (partialSummary.reason && !status.reason) status.reason = partialSummary.reason;
  if (partialSummary.mode && (!status.mode || status.mode === 'monitor')) status.mode = partialSummary.mode;
  if (partialSummary.runtime) status.runtime = partialSummary.runtime;
  if (partialSummary.runtimeLabel) status.runtimeLabel = partialSummary.runtimeLabel;
  if (partialSummary.cookieAuth) status.cookieAuth = partialSummary.cookieAuth;
}

function createScanJobManager({
  rootDir,
  db,
  outDir,
  runtime = process.env.DOUYIN_RUNTIME || 'auto',
  profile,
  cdpUrl = process.env.DOUYIN_CDP_URL || '',
  browserApp = process.env.DOUYIN_BROWSER_APP || '',
  cookieFile = process.env.DOUYIN_COOKIE_FILE || defaultCookieFile(outDir),
  authWaitSeconds = Number.parseInt(process.env.DOUYIN_AUTH_WAIT_SECONDS || `${DEFAULT_AUTH_WAIT_SECONDS}`, 10),
  collectorPath = path.join(rootDir, 'scripts', 'collect-followers.mjs'),
  nodePath = process.execPath,
  spawnImpl = defaultSpawn
}) {
  const emitter = new EventEmitter();
  const clients = new Set();
  let currentJob = null;
  let lastJob = null;
  const runtimeConfig = resolveBrowserRuntimeConfig(
    { runtime, profile, cdpUrl, browserApp, cookieFile: '' },
    { ...process.env, DOUYIN_COOKIE_FILE: '' }
  );
  const supportsCookieAuth = runtimeConfig.runtime === 'playwright' || runtimeConfig.runtime === 'cdp';
  const resolvedAuthWaitSeconds = Number.isFinite(authWaitSeconds) && authWaitSeconds >= 0
    ? authWaitSeconds
    : DEFAULT_AUTH_WAIT_SECONDS;

  function isActive(job) {
    return job && ['starting', 'running', 'stopping'].includes(job.status);
  }

  function emitStatus() {
    const status = publicJob(currentJob || lastJob);
    emitter.emit('status', status);
    const payload = `event: status\ndata: ${JSON.stringify(status)}\n\n`;
    for (const res of [...clients]) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  }

  async function enrichStatus(status) {
    const partial = await readJsonIfExists(path.join(outDir, 'in-progress', 'latest.partial.json'));
    if (partial) {
      const partialSummary = partialSummaryFromSnapshot(partial);
      if (partialMatchesJob(partialSummary, status.startedAt, status.status)) mergePartialIntoStatus(status, partialSummary);
    }
    if (status.status === 'idle') {
      status.runtime = runtimeConfig.runtime;
      status.runtimeLabel = runtimeConfig.runtimeLabel;
    }
    status.cookieAuth = await getCookieAuthStatus({
      cookieFile,
      runtime: runtimeConfig.runtime
    });
    return status;
  }

  async function status() {
    return enrichStatus(publicJob(currentJob || lastJob));
  }

  async function start() {
    if (isActive(currentJob)) {
      return { statusCode: 409, body: { error: 'scan-already-running', status: await status() } };
    }

    const job = {
      id: `scan-${nowId()}`,
      status: 'starting',
      mode: 'monitor',
      requestedMode: 'monitor',
      reason: '',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      pagesFetched: 0,
      count: 0,
      profileFollowerCount: null,
      hiddenOrUnavailableCount: null,
      runtime: runtimeConfig.runtime,
      runtimeLabel: runtimeConfig.runtimeLabel,
      cookieAuth: await getCookieAuthStatus({ cookieFile, runtime: runtimeConfig.runtime }),
      phase: 'starting',
      authChallenge: null,
      exitCode: null,
      signal: null,
      error: '',
      logLines: [],
      changeSummary: null,
      partial: null,
      buffer: '',
      child: null
    };

    currentJob = job;
    lastJob = job;
    emitStatus();

    const args = [
      '--disable-warning=ExperimentalWarning',
      collectorPath,
      '--runtime',
      runtimeConfig.runtime,
      '--api',
      '--mode',
      'monitor',
      '--auth-wait-seconds',
      String(resolvedAuthWaitSeconds),
      '--db',
      db,
      '--out-dir',
      outDir
    ];
    if (runtimeConfig.profile) args.push('--profile', runtimeConfig.profile);
    if (runtimeConfig.cdpUrl) args.push('--cdp-url', runtimeConfig.cdpUrl);
    if (runtimeConfig.browserApp) args.push('--browser-app', runtimeConfig.browserApp);
    if (supportsCookieAuth && job.cookieAuth?.configured) args.push('--cookie-file', cookieFile);

    const childEnv = { ...process.env, DOUYIN_COOKIE_FILE: '' };
    if (supportsCookieAuth && job.cookieAuth?.configured) childEnv.DOUYIN_COOKIE_FILE = cookieFile;

    const child = spawnImpl(nodePath, args, {
      cwd: rootDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    job.child = child;
    job.status = 'running';
    job.phase = 'authenticating';
    emitStatus();

    child.stdout?.on('data', (chunk) => feedChunk(job, emitter, chunk));
    child.stderr?.on('data', (chunk) => feedChunk(job, emitter, chunk));

    child.on('error', (error) => {
      job.status = 'failed';
      job.error = error.message;
      job.finishedAt = new Date().toISOString();
      job.phase = 'failed';
      currentJob = null;
      emitStatus();
    });

    child.on('exit', async (code, signal) => {
      if (job.buffer) {
        if (!parseMonitorEventLine(job, job.buffer)) appendLog(job, job.buffer);
      }
      job.buffer = '';
      job.exitCode = code;
      job.signal = signal || null;
      job.finishedAt = new Date().toISOString();
      if (job.status === 'stopping' || signal === 'SIGTERM' || code === 143) job.status = 'interrupted';
      else job.status = code === 0 ? 'completed' : 'failed';
      job.phase = phaseFromStatus(job.status);

      const latestPartial = await readJsonIfExists(path.join(outDir, 'in-progress', 'latest.partial.json'));
      if (latestPartial) {
        const partialSummary = partialSummaryFromSnapshot(latestPartial);
        if (partialMatchesJob(partialSummary, job.startedAt, job.status)) mergePartialIntoStatus(job, partialSummary);
      }

      const latestSnapshot = await readJsonIfExists(path.join(outDir, 'latest.json'));
      if (latestSnapshot && snapshotMatchesJob(latestSnapshot, job.startedAt)) {
        job.count = latestSnapshot.count ?? job.count;
        job.profileFollowerCount = latestSnapshot.profileStats?.followers ?? job.profileFollowerCount;
        job.hiddenOrUnavailableCount = latestSnapshot.hiddenOrUnavailableCount ?? job.hiddenOrUnavailableCount;
        job.mode = latestSnapshot.mode || job.mode;
        job.reason = latestSnapshot.reason || job.reason;
        job.runtime = latestSnapshot.runtime || job.runtime;
        job.runtimeLabel = latestSnapshot.runtimeLabel || job.runtimeLabel;
        job.cookieAuth = latestSnapshot.cookieAuth || job.cookieAuth;
      }

      const latestChange = await readJsonIfExists(path.join(outDir, 'latest-change.json'));
      if (latestChange) {
        job.changeSummary = {
          newCount: latestChange.newCount ?? latestChange.addedCount ?? 0,
          suspectedRemovedCount: latestChange.suspectedRemovedCount ?? 0,
          removedCount: latestChange.removedCount ?? 0,
          reappearedCount: latestChange.reappearedCount ?? 0,
          renamedCount: latestChange.renamedCount ?? 0,
          hiddenOrUnavailableCount: latestChange.hiddenOrUnavailableCount ?? null
        };
        job.hiddenOrUnavailableCount = latestChange.hiddenOrUnavailableCount ?? job.hiddenOrUnavailableCount;
      }

      currentJob = null;
      emitStatus();
    });

    return { statusCode: 202, body: { status: await status() } };
  }

  async function stop() {
    if (!isActive(currentJob)) {
      return { statusCode: 200, body: { status: await status() } };
    }
    currentJob.status = 'stopping';
    currentJob.phase = 'stopping';
    appendLog(currentJob, '正在请求中止采集...');
    currentJob.child?.kill('SIGTERM');
    emitStatus();
    return { statusCode: 202, body: { status: await status() } };
  }

  async function subscribe(req, res) {
    clients.add(res);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'access-control-allow-origin': req.headers.origin || '*'
    });
    res.write(`event: status\ndata: ${JSON.stringify(await status())}\n\n`);

    const ping = setInterval(() => {
      try {
        res.write(`event: ping\ndata: ${Date.now()}\n\n`);
      } catch {
        clients.delete(res);
        clearInterval(ping);
      }
    }, 15_000);
    ping.unref?.();

    const cleanup = () => {
      clients.delete(res);
      clearInterval(ping);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  emitter.on('update', emitStatus);

  return {
    start,
    stop,
    status,
    subscribe,
    _emitter: emitter
  };
}

export { createScanJobManager, parseLogLine };
