import { spawn as defaultSpawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_BROWSER_APP = 'com.bot.pc.doubao.browser';
const MAX_LOG_LINES = 120;
const DOUYIN_SELF_URL = 'https://www.douyin.com/user/self';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowId(date = new Date()) {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function trimLogLines(lines) {
  return lines.slice(Math.max(0, lines.length - MAX_LOG_LINES));
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

function parseLogLine(job, line) {
  const modeMatch = line.match(/^扫描模式:\s*(\w+)\s*\(([^)]*)\)/);
  if (modeMatch) {
    job.mode = modeMatch[1];
    job.reason = modeMatch[2] || '';
    return;
  }

  const pageMatch = line.match(/^API 第\s*(\d+)\s*页:\s*本页\s*(\d+)，累计\s*(\d+)，hasMore=(true|false)/);
  if (pageMatch) {
    job.pagesFetched = Number(pageMatch[1]);
    job.count = Number(pageMatch[3]);
    job.lastPageSize = Number(pageMatch[2]);
    job.hasMore = pageMatch[4] === 'true';
    return;
  }

  const partialMatch = line.match(/^已保存进度:\s*(\d+)\s*->\s*(.+)$/);
  if (partialMatch) {
    job.count = Number(partialMatch[1]);
    job.partialSavedAt = new Date().toISOString();
    job.partialPath = partialMatch[2];
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
  }
}

function feedChunk(job, emitter, chunk) {
  job.buffer += chunk.toString();
  const lines = job.buffer.split(/\r?\n/);
  job.buffer = lines.pop() || '';
  for (const line of lines) {
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

function mergePartialIntoStatus(status, partialSummary) {
  status.partial = partialSummary;
  if (status.status !== 'idle') {
    status.pagesFetched = Math.max(status.pagesFetched || 0, partialSummary.pagesFetched || 0);
    status.count = Math.max(status.count || 0, partialSummary.count || 0);
    status.profileFollowerCount = status.profileFollowerCount ?? partialSummary.profileFollowerCount;
    if (partialSummary.reason && !status.reason) status.reason = partialSummary.reason;
    if (partialSummary.mode && (!status.mode || status.mode === 'monitor')) status.mode = partialSummary.mode;
  }
}

function appleScriptTarget(app) {
  if (/^[A-Za-z0-9_.-]+$/.test(app) && app.includes('.')) return `id "${app}"`;
  return `"${String(app).replaceAll('"', '\\"')}"`;
}

async function focusDouyinTab(browserApp = DEFAULT_BROWSER_APP) {
  const script = `
tell application ${appleScriptTarget(browserApp)}
  activate
  set foundTab to false
  repeat with w in windows
    set tabIndex to 1
    repeat with t in tabs of w
      try
        if (URL of t contains "douyin.com") then
          set active tab index of w to tabIndex
          set index of w to 1
          set foundTab to true
          exit repeat
        end if
      end try
      set tabIndex to tabIndex + 1
    end repeat
    if foundTab then exit repeat
  end repeat
  if foundTab then return "found"
  if (count windows) is 0 then make new window
  set targetWindow to front window
  make new tab at end of tabs of targetWindow with properties {URL:"${DOUYIN_SELF_URL}"}
  set active tab index of targetWindow to (count tabs of targetWindow)
  set index of targetWindow to 1
  return "opened"
end tell`;

  const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 10_000 });
  return stdout.trim();
}

function createScanJobManager({
  rootDir,
  db,
  outDir,
  browserApp = DEFAULT_BROWSER_APP,
  collectorPath = path.join(rootDir, 'scripts', 'collect-followers.mjs'),
  nodePath = process.execPath,
  spawnImpl = defaultSpawn,
  focusBrowser = true
}) {
  const emitter = new EventEmitter();
  const clients = new Set();
  let currentJob = null;
  let lastJob = null;

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

    try {
      if (focusBrowser) {
        const focusResult = await focusDouyinTab(browserApp);
        if (focusResult === 'found') appendLog(job, '已切换到豆包浏览器中的抖音标签页。');
        else if (focusResult === 'opened') {
          appendLog(job, '未找到已打开的抖音标签页，已打开抖音个人页。');
          await sleep(4500);
        } else appendLog(job, '未找到已打开的抖音标签页，采集脚本将检查当前活动标签页。');
      }
    } catch (error) {
      appendLog(job, `切换抖音标签页失败: ${error.message}`);
    }

    const args = [
      '--disable-warning=ExperimentalWarning',
      collectorPath,
      '--browser-app',
      browserApp,
      '--api',
      '--mode',
      'monitor',
      '--db',
      db,
      '--out-dir',
      outDir
    ];

    const child = spawnImpl(nodePath, args, {
      cwd: rootDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    job.child = child;
    job.status = 'running';
    emitStatus();

    child.stdout?.on('data', (chunk) => feedChunk(job, emitter, chunk));
    child.stderr?.on('data', (chunk) => feedChunk(job, emitter, chunk));

    child.on('error', (error) => {
      job.status = 'failed';
      job.error = error.message;
      job.finishedAt = new Date().toISOString();
      currentJob = null;
      emitStatus();
    });

    child.on('exit', async (code, signal) => {
      if (job.buffer) appendLog(job, job.buffer);
      job.buffer = '';
      job.exitCode = code;
      job.signal = signal || null;
      job.finishedAt = new Date().toISOString();
      if (job.status === 'stopping' || signal === 'SIGTERM' || code === 143) job.status = 'interrupted';
      else job.status = code === 0 ? 'completed' : 'failed';

      const latestPartial = await readJsonIfExists(path.join(outDir, 'in-progress', 'latest.partial.json'));
      if (latestPartial) {
        const partialSummary = partialSummaryFromSnapshot(latestPartial);
        if (partialMatchesJob(partialSummary, job.startedAt, job.status)) mergePartialIntoStatus(job, partialSummary);
      }

      const latestSnapshot = await readJsonIfExists(path.join(outDir, 'latest.json'));
      if (latestSnapshot) {
        job.count = latestSnapshot.count ?? job.count;
        job.profileFollowerCount = latestSnapshot.profileStats?.followers ?? job.profileFollowerCount;
        job.hiddenOrUnavailableCount = latestSnapshot.hiddenOrUnavailableCount ?? job.hiddenOrUnavailableCount;
        job.mode = latestSnapshot.mode || job.mode;
        job.reason = latestSnapshot.reason || job.reason;
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

export { createScanJobManager, focusDouyinTab, parseLogLine };
