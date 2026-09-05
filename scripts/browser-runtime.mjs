import process from 'node:process';
import { ensureCdpBrowser } from './cdp-browser.mjs';

import { applyCookieAuthToContext } from './cookie-auth.mjs';

const DEFAULT_TARGET = 'https://www.douyin.com/user/self';
const DEFAULT_RUNTIME = 'auto';
const RUNTIME_LABELS = {
  playwright: 'Playwright profile',
  cdp: 'Chrome DevTools Protocol'
};

function normalizeRuntime(value = DEFAULT_RUNTIME) {
  const runtime = String(value || DEFAULT_RUNTIME).trim().toLowerCase();
  if (!['auto', 'playwright', 'cdp'].includes(runtime)) {
    throw new Error('--runtime must be one of: auto, playwright, cdp');
  }
  return runtime;
}

function resolveBrowserRuntimeConfig(options = {}, env = process.env) {
  const requestedRuntime = normalizeRuntime(options.runtime || env.DOUYIN_RUNTIME || DEFAULT_RUNTIME);
  const cdpUrl = options.cdpUrl || env.DOUYIN_CDP_URL || '';
  const profile = options.profile || env.DOUYIN_PROFILE || '';
  const cookieFile = options.cookieFile || env.DOUYIN_COOKIE_FILE || '';
  let runtime = requestedRuntime;

  if (runtime === 'auto') {
    if (cdpUrl) runtime = 'cdp';
    else runtime = 'playwright';
  }

  if (runtime === 'cdp' && !cdpUrl) {
    throw new Error('CDP runtime requires --cdp-url or DOUYIN_CDP_URL');
  }

  return {
    requestedRuntime,
    runtime,
    runtimeLabel: RUNTIME_LABELS[runtime],
    cdpUrl,
    profile,
    cookieFile
  };
}

function parseJsonOutput(output) {
  try {
    return JSON.parse(output);
  } catch {
    return { ok: false, error: `Browser returned non-JSON output: ${String(output).slice(0, 300)}` };
  }
}

function isDouyinUrl(value) {
  try {
    return /(^|\.)douyin\.com$/.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isTargetPageUrl(value, target = DEFAULT_TARGET) {
  try {
    const url = new URL(value);
    const targetUrl = new URL(target);
    return url.hostname === targetUrl.hostname && url.pathname === targetUrl.pathname;
  } catch {
    return false;
  }
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
    this.page = pages.find((page) => isTargetPageUrl(page.url(), target)) ||
      pages.find((page) => isDouyinUrl(page.url())) ||
      pages[0] ||
      (await context.newPage());
    if (!isTargetPageUrl(this.page.url(), target)) {
      await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await this.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    }
    await this.page.bringToFront().catch(() => {});
    return isTargetPageUrl(this.page.url(), target) ? 'found' : 'opened';
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
    // Remote CDP remains attach-only; only local HTTP endpoints are auto-started.
    const endpoint = new URL(this.cdpUrl);
    if (endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
      await ensureCdpBrowser(this.cdpUrl);
    }
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
    const applyingCookies = !this.cookiesApplied;
    await this.applyCookieAuth();
    const pages = this.context.pages();
    this.page = pages.find((page) => isTargetPageUrl(page.url(), target)) ||
      pages.find((page) => isDouyinUrl(page.url())) ||
      pages[0] ||
      (await this.context.newPage());
    if (!isTargetPageUrl(this.page.url(), target) || (applyingCookies && this.cookieAuthSummary?.acceptedCount > 0)) {
      await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await this.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    }
    await this.page.bringToFront().catch(() => {});
    return isTargetPageUrl(this.page.url(), target) ? 'found' : 'opened';
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
  if (config.runtime === 'cdp') return new CdpRuntime({ ...options, ...config });
  return new PlaywrightRuntime({ ...options, ...config });
}

export {
  DEFAULT_TARGET,
  RUNTIME_LABELS,
  createBrowserRuntime,
  resolveBrowserRuntimeConfig
};
