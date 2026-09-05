import { spawn } from 'node:child_process';
import { access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const pending = new Map();

function localEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('自动启动仅支持本机 HTTP CDP 地址，例如 http://127.0.0.1:9222');
  }
  return url;
}

async function ready(url) {
  try {
    const response = await fetch(new URL('/json/version', url), { signal: AbortSignal.timeout(1000), redirect: 'error' });
    if (!response.ok) return false;
    const version = await response.json();
    const ws = new URL(version.webSocketDebuggerUrl);
    return /Chrome|Chromium|HeadlessChrome/.test(version.Browser || '') &&
      ['ws:', 'wss:'].includes(ws.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(ws.hostname) && ws.pathname.startsWith('/devtools/browser/');
  } catch { return false; }
}

function portInUse(url) {
  return new Promise(resolve => {
    const socket = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80) });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
    socket.setTimeout(1000, () => finish(true));
  });
}

async function executable(configured) {
  const candidates = configured ? [configured] : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
    : process.platform === 'win32'
      ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map(root => path.join(root, 'Google/Chrome/Application/chrome.exe'))
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try next installation. */ }
  }
  throw new Error('未找到 Chrome 安装，请安装 Google Chrome，或设置 DOUYIN_CHROME_PATH 为浏览器可执行文件路径。');
}

async function launch(url, options) {
  if (await ready(url)) return { launched: false, message: '采集浏览器已连接，可继续采集。' };
  if (await portInUse(url)) throw new Error('CDP 端口已被占用，但不是可用的 Chrome 调试服务。请检查端口或修改 CDP 地址。');
  const chrome = await executable(options.executablePath || process.env.DOUYIN_CHROME_PATH);
  const profileDir = path.resolve(options.profileDir || process.env.DOUYIN_CDP_PROFILE || path.join(homedir(), '.douyin-cdp-profile'));
  try {
    await lstat(path.join(profileDir, 'SingletonLock'));
    throw new Error('采集浏览器配置目录被锁定。请先正常退出使用该专用目录的 Chrome 后重试；不会自动删除锁或关闭日常浏览器。');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const child = (options.spawnImpl || spawn)(chrome, [
    `--remote-debugging-port=${url.port || 80}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', 'https://www.douyin.com/user/self'
  ], { detached: true, stdio: 'ignore', shell: false });
  let failure = '';
  child.once('error', error => { failure = `Chrome 启动失败：${error.message}`; });
  child.once('exit', (code, signal) => { failure = `Chrome 已退出（${signal || code}），请检查专用配置目录是否被占用。`; });
  child.unref();
  const deadline = Date.now() + (options.timeoutMs ?? 20000);
  while (Date.now() < deadline) {
    if (await ready(url)) return { launched: true, message: '采集浏览器已打开。首次使用请登录抖音，然后启动采集。' };
    if (failure) throw new Error(failure);
    await delay(250);
  }
  throw new Error('Chrome 已尝试启动，但 CDP 连接超时。请检查浏览器提示、专用配置目录和调试端口后重试。');
}

export async function ensureCdpBrowser(value, options = {}) {
  const url = localEndpoint(value);
  const key = url.origin;
  if (!pending.has(key)) pending.set(key, launch(url, options).finally(() => pending.delete(key)));
  return pending.get(key);
}
