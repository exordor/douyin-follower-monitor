import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { applyCookieAuthToContext } from './cookie-auth.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_TARGET = 'https://www.douyin.com/user/self';
const DEFAULT_RUNTIME = 'auto';
const RUNTIME_LABELS = {
  'apple-events': 'Apple Events browser',
  playwright: 'Playwright profile',
  cdp: 'Chrome DevTools Protocol'
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRuntime(value = DEFAULT_RUNTIME) {
  const runtime = String(value || DEFAULT_RUNTIME).trim().toLowerCase();
  if (!['auto', 'apple-events', 'playwright', 'cdp'].includes(runtime)) {
    throw new Error('--runtime must be one of: auto, playwright, cdp, apple-events');
  }
  return runtime;
}

function resolveBrowserRuntimeConfig(options = {}, env = process.env) {
  const requestedRuntime = normalizeRuntime(options.runtime || env.DOUYIN_RUNTIME || DEFAULT_RUNTIME);
  const browserApp = options.browserApp || env.DOUYIN_BROWSER_APP || '';
  const cdpUrl = options.cdpUrl || env.DOUYIN_CDP_URL || '';
  const profile = options.profile || env.DOUYIN_PROFILE || '';
  const cookieFile = options.cookieFile || env.DOUYIN_COOKIE_FILE || '';
  let runtime = requestedRuntime;

  if (runtime === 'auto') {
    if (browserApp) runtime = 'apple-events';
    else if (cdpUrl) runtime = 'cdp';
    else runtime = 'playwright';
  }

  if (runtime === 'apple-events' && !browserApp) {
    throw new Error('Apple Events runtime requires --browser-app or DOUYIN_BROWSER_APP');
  }
  if (runtime === 'cdp' && !cdpUrl) {
    throw new Error('CDP runtime requires --cdp-url or DOUYIN_CDP_URL');
  }
  if (runtime === 'apple-events' && cookieFile) {
    throw new Error('Apple Events runtime 不支持 --cookie-file。请改用 --runtime playwright/cdp，或继续复用已登录浏览器。');
  }

  return {
    requestedRuntime,
    runtime,
    runtimeLabel: RUNTIME_LABELS[runtime],
    browserApp,
    cdpUrl,
    profile,
    cookieFile
  };
}

function appleScriptTarget(app) {
  if (/^[A-Za-z0-9_.-]+$/.test(app) && app.includes('.')) return `id "${app}"`;
  return `"${String(app).replaceAll('"', '\\"')}"`;
}

function parseJsonOutput(output) {
  try {
    return JSON.parse(output);
  } catch {
    return { ok: false, error: `Browser returned non-JSON output: ${String(output).slice(0, 300)}` };
  }
}

async function evaluateWithMainWorldBridge(evaluateJavascript, expression, { timeoutMs = 30_000, pollMs = 250 } = {}) {
  const key = `data-douyin-main-world-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const mainCode = `(() => {
    const finish = (value) => document.documentElement.setAttribute(${JSON.stringify(key)}, JSON.stringify(value));
    try {
      Promise.resolve(${expression})
        .then((value) => finish({ ok: true, value }))
        .catch((error) => finish({ ok: false, error: String(error && (error.stack || error.message) || error) }));
    } catch (error) {
      finish({ ok: false, error: String(error && (error.stack || error.message) || error) });
    }
  })()`;

  await evaluateJavascript(`(() => {
    document.documentElement.removeAttribute(${JSON.stringify(key)});
    const script = document.createElement('script');
    script.textContent = ${JSON.stringify(mainCode)};
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    return true;
  })()`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = await evaluateJavascript(`document.documentElement.getAttribute(${JSON.stringify(key)}) || ''`);
    if (output) {
      await evaluateJavascript(`document.documentElement.removeAttribute(${JSON.stringify(key)})`).catch(() => {});
      const parsed = JSON.parse(output);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value;
    }
    await sleep(pollMs);
  }

  throw new Error(`页面主环境执行超时: ${timeoutMs}ms`);
}

class AppleEventsRuntime {
  constructor(config) {
    this.name = 'apple-events';
    this.label = RUNTIME_LABELS[this.name];
    this.browserApp = config.browserApp;
    this.cookieAuthSummary = null;
  }

  async openOrFocusTarget(target = DEFAULT_TARGET) {
    const script = `
tell application ${appleScriptTarget(this.browserApp)}
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
  make new tab at end of tabs of targetWindow with properties {URL:"${String(target).replaceAll('"', '\\"')}"}
  set active tab index of targetWindow to (count tabs of targetWindow)
  set index of targetWindow to 1
  return "opened"
end tell`;

    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 10_000 });
    const result = stdout.trim();
    if (result === 'opened') await sleep(4500);
    return result;
  }

  async evaluateJavascript(javascript) {
    const jsPath = path.join(os.tmpdir(), `douyin-follower-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
    await writeFile(jsPath, javascript, 'utf8');

    const appleScript = [
      `set jsCode to read POSIX file "${jsPath.replaceAll('"', '\\"')}" as «class utf8»`,
      `tell application ${appleScriptTarget(this.browserApp)} to execute active tab of front window javascript jsCode`
    ].join('\n');

    try {
      const { stdout } = await execFileAsync('osascript', ['-e', appleScript], {
        maxBuffer: 64 * 1024 * 1024
      });
      return stdout.trim();
    } catch (error) {
      const message = `${error.stdout || ''}${error.stderr || ''}${error.message || ''}`;
      if (/Apple 事件中的 JavaScript|Apple events|JavaScript/.test(message) && /关闭|disabled/i.test(message)) {
        throw new Error([
          `浏览器拒绝执行页面 JavaScript: ${this.browserApp}`,
          '请在浏览器菜单开启: 显示 > 开发者 > 允许 Apple 事件中的 JavaScript',
          '开启后重新运行采集命令。'
        ].join('\n'));
      }
      throw error;
    } finally {
      await unlink(jsPath).catch(() => {});
    }
  }

  async evaluateJson(expression) {
    const output = await this.evaluateJavascript(`(() => {
      try {
        return JSON.stringify(${expression});
      } catch (error) {
        return JSON.stringify({ ok: false, error: String(error && (error.stack || error.message) || error) });
      }
    })()`);
    return parseJsonOutput(output);
  }

  async evaluateMainWorldJson(expression, options) {
    return evaluateWithMainWorldBridge((javascript) => this.evaluateJavascript(javascript), expression, options);
  }

  async readPageInfo() {
    return this.evaluateJson(`({
      ok: true,
      url: location.href,
      title: document.title,
      text: (document.body && document.body.innerText || '').slice(0, 500)
    })`);
  }

  async close() {}
}

class PlaywrightRuntime {
  constructor(config) {
    this.name = 'playwright';
    this.label = RUNTIME_LABELS[this.name];
    this.profile = config.profile;
    this.cookieFile = config.cookieFile;
    this.headless = Boolean(config.headless);
    this.slowMo = config.slowMo ?? 40;
    this.context = null;
    this.page = null;
    this.cookieAuthSummary = null;
    this.cookiesApplied = false;
  }

  async ensureContext() {
    if (this.context) return this.context;
    const { chromium } = await import('playwright');
    const launchOptions = {
      headless: this.headless,
      slowMo: this.slowMo,
      viewport: { width: 1365, height: 900 },
      locale: 'zh-CN'
    };
    const preferredChannel = process.env.PLAYWRIGHT_CHANNEL || 'chrome';
    try {
      this.context = await chromium.launchPersistentContext(this.profile, {
        ...launchOptions,
        channel: preferredChannel
      });
    } catch (error) {
      if (process.env.PLAYWRIGHT_CHANNEL) throw error;
      console.warn(`无法启动系统 Chrome，改用 Playwright Chromium: ${error.message.split('\n')[0]}`);
      console.warn('如果这里失败，请运行: npx playwright install chromium');
      this.context = await chromium.launchPersistentContext(this.profile, launchOptions);
    }
    return this.context;
  }

  async applyCookieAuth() {
    if (this.cookiesApplied) return;
    this.cookieAuthSummary = await applyCookieAuthToContext(await this.ensureContext(), this.cookieFile);
    this.cookiesApplied = true;
  }

  async openOrFocusTarget(target = DEFAULT_TARGET) {
    const context = await this.ensureContext();
    await this.applyCookieAuth();
    const pages = context.pages();
    this.page = pages.find((page) => /douyin\.com/.test(page.url())) || pages[0] || (await context.newPage());
    if (!/douyin\.com/.test(this.page.url())) {
      await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await this.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    }
    await this.page.bringToFront().catch(() => {});
    return /douyin\.com/.test(this.page.url()) ? 'found' : 'opened';
  }

  async evaluateJson(expression) {
    const output = await this.page.evaluate(`(() => {
      try {
        return JSON.stringify(${expression});
      } catch (error) {
        return JSON.stringify({ ok: false, error: String(error && (error.stack || error.message) || error) });
      }
    })()`);
    return parseJsonOutput(output);
  }

  async evaluateMainWorldJson(expression) {
    return this.page.evaluate(expression);
  }

  async readPageInfo() {
    return this.evaluateJson(`({
      ok: true,
      url: location.href,
      title: document.title,
      text: (document.body && document.body.innerText || '').slice(0, 500)
    })`);
  }

  async close() {
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
  }
}

class CdpRuntime {
  constructor(config) {
    this.name = 'cdp';
    this.label = RUNTIME_LABELS[this.name];
    this.cdpUrl = config.cdpUrl;
    this.cookieFile = config.cookieFile;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.cookieAuthSummary = null;
    this.cookiesApplied = false;
  }

  async ensureConnection() {
    if (this.browser) return;
    const { chromium } = await import('playwright');
    this.browser = await chromium.connectOverCDP(this.cdpUrl, { noDefaults: true });
    this.context = this.browser.contexts()[0] || await this.browser.newContext();
  }

  async applyCookieAuth() {
    if (this.cookiesApplied) return;
    await this.ensureConnection();
    this.cookieAuthSummary = await applyCookieAuthToContext(this.context, this.cookieFile);
    this.cookiesApplied = true;
  }

  async openOrFocusTarget(target = DEFAULT_TARGET) {
    await this.ensureConnection();
    await this.applyCookieAuth();
    const pages = this.context.pages();
    this.page = pages.find((page) => /douyin\.com/.test(page.url())) || pages[0] || (await this.context.newPage());
    if (!/douyin\.com/.test(this.page.url())) {
      await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await this.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    }
    await this.page.bringToFront().catch(() => {});
    return /douyin\.com/.test(this.page.url()) ? 'found' : 'opened';
  }

  async evaluateJson(expression) {
    const output = await this.page.evaluate(`(() => {
      try {
        return JSON.stringify(${expression});
      } catch (error) {
        return JSON.stringify({ ok: false, error: String(error && (error.stack || error.message) || error) });
      }
    })()`);
    return parseJsonOutput(output);
  }

  async evaluateMainWorldJson(expression) {
    return this.page.evaluate(expression);
  }

  async readPageInfo() {
    return this.evaluateJson(`({
      ok: true,
      url: location.href,
      title: document.title,
      text: (document.body && document.body.innerText || '').slice(0, 500)
    })`);
  }

  async close() {
    if (typeof this.browser?.disconnect === 'function') this.browser.disconnect();
    else await this.browser?.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}

async function createBrowserRuntime(options = {}, env = process.env) {
  const config = resolveBrowserRuntimeConfig(options, env);
  if (config.runtime === 'apple-events') return new AppleEventsRuntime({ ...options, ...config });
  if (config.runtime === 'cdp') return new CdpRuntime({ ...options, ...config });
  return new PlaywrightRuntime({ ...options, ...config });
}

export {
  DEFAULT_TARGET,
  RUNTIME_LABELS,
  createBrowserRuntime,
  resolveBrowserRuntimeConfig
};
