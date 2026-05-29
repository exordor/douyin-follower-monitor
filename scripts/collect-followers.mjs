#!/usr/bin/env node

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline/promises';

import { createBrowserRuntime, resolveBrowserRuntimeConfig } from './browser-runtime.mjs';
import { classifyCollectorError, errorSuggestion, publicErrorMessage } from './collector-errors.mjs';
import { buildNotificationPayload, parseNotifyConfig, sendNotification } from './notify.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TARGET = 'https://www.douyin.com/user/self';
const MONITOR_EVENT_PREFIX = '__DOUYIN_MONITOR_EVENT__ ';

function parseArgs(argv) {
  const options = {
    target: DEFAULT_TARGET,
    profile: process.env.DOUYIN_PROFILE ? path.resolve(ROOT_DIR, process.env.DOUYIN_PROFILE) : path.join(ROOT_DIR, '.douyin-browser'),
    runtime: process.env.DOUYIN_RUNTIME || 'auto',
    cdpUrl: process.env.DOUYIN_CDP_URL || '',
    browserApp: process.env.DOUYIN_BROWSER_APP || '',
    cookieFile: process.env.DOUYIN_COOKIE_FILE ? path.resolve(ROOT_DIR, process.env.DOUYIN_COOKIE_FILE) : '',
    outDir: path.join(ROOT_DIR, 'data'),
    headless: false,
    manual: false,
    api: false,
    mode: 'full',
    apiSourceType: 0,
    recentPages: 5,
    fullIntervalHours: 24,
    forceFull: false,
    db: path.join(ROOT_DIR, 'data', 'followers.db'),
    confirmRemoveScans: 2,
    max: 0,
    idleRounds: 30,
    maxRounds: 1200,
    waitMinMs: 450,
    waitMaxMs: 900,
    slowMo: 40,
    checkpointEvery: 1,
    authWaitSeconds: Number.parseInt(process.env.DOUYIN_AUTH_WAIT_SECONDS || '0', 10),
    notify: process.env.DOUYIN_NOTIFY || 'none',
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return value;
    };

    if (arg === '--target') options.target = next();
    else if (arg === '--profile') options.profile = path.resolve(ROOT_DIR, next());
    else if (arg === '--runtime') options.runtime = next();
    else if (arg === '--cdp-url') options.cdpUrl = next();
    else if (arg === '--browser-app') options.browserApp = next();
    else if (arg === '--cookie-file') options.cookieFile = path.resolve(ROOT_DIR, next());
    else if (arg === '--out-dir') options.outDir = path.resolve(ROOT_DIR, next());
    else if (arg === '--mode') options.mode = next();
    else if (arg === '--max') options.max = Number.parseInt(next(), 10);
    else if (arg === '--recent-pages') options.recentPages = Number.parseInt(next(), 10);
    else if (arg === '--full-interval-hours') options.fullIntervalHours = Number.parseInt(next(), 10);
    else if (arg === '--db') options.db = path.resolve(ROOT_DIR, next());
    else if (arg === '--confirm-remove-scans') options.confirmRemoveScans = Number.parseInt(next(), 10);
    else if (arg === '--idle-rounds') options.idleRounds = Number.parseInt(next(), 10);
    else if (arg === '--max-rounds') options.maxRounds = Number.parseInt(next(), 10);
    else if (arg === '--wait-min-ms') options.waitMinMs = Number.parseInt(next(), 10);
    else if (arg === '--wait-max-ms') options.waitMaxMs = Number.parseInt(next(), 10);
    else if (arg === '--slow-mo') options.slowMo = Number.parseInt(next(), 10);
    else if (arg === '--checkpoint-every') options.checkpointEvery = Number.parseInt(next(), 10);
    else if (arg === '--auth-wait-seconds') options.authWaitSeconds = Number.parseInt(next(), 10);
    else if (arg === '--notify') options.notify = next();
    else if (arg === '--api-source-type') options.apiSourceType = Number.parseInt(next(), 10);
    else if (arg === '--headless') options.headless = true;
    else if (arg === '--manual') options.manual = true;
    else if (arg === '--api') options.api = true;
    else if (arg === '--force-full') options.forceFull = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!['recent', 'full', 'monitor'].includes(options.mode)) {
    throw new Error('--mode must be one of: recent, full, monitor');
  }

  for (const [name, value] of Object.entries({
    max: options.max,
    recentPages: options.recentPages,
    fullIntervalHours: options.fullIntervalHours,
    confirmRemoveScans: options.confirmRemoveScans,
    idleRounds: options.idleRounds,
    maxRounds: options.maxRounds,
    waitMinMs: options.waitMinMs,
    waitMaxMs: options.waitMaxMs,
    slowMo: options.slowMo,
    checkpointEvery: options.checkpointEvery,
    authWaitSeconds: options.authWaitSeconds,
    apiSourceType: options.apiSourceType
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be a non-negative number`);
    }
  }

  if (options.waitMaxMs < options.waitMinMs) {
    throw new Error('--wait-max-ms must be greater than or equal to --wait-min-ms');
  }

  if (options.confirmRemoveScans < 2) {
    throw new Error('--confirm-remove-scans must be at least 2');
  }
  parseNotifyConfig({ notify: options.notify });

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/collect-followers.mjs [options]

Options:
  --target <url>         Douyin profile URL (default: ${DEFAULT_TARGET})
  --runtime <runtime>    Browser runtime: auto, playwright, cdp, apple-events (default: auto)
  --profile <path>       Browser profile directory (default: .douyin-browser)
  --cdp-url <url>        Chrome DevTools Protocol endpoint, e.g. http://127.0.0.1:9222
  --browser-app <app>    Use the active tab of an existing browser app/bundle id
  --cookie-file <path>   cookie-manager lossless JSON for playwright/cdp runtime
  --out-dir <path>       Output directory (default: data)
  --api                  Use Douyin's in-page follower API instead of DOM scrolling
  --api-source-type <n>  Follower API source_type (default: 0)
  --mode <mode>          API scan mode: recent, full, monitor (default: full)
  --recent-pages <n>     Pages to fetch in recent mode (default: 5)
  --full-interval-hours <n>
                         Full scan interval for monitor mode (default: 24)
  --force-full           Force full scan in monitor mode
  --db <path>            SQLite database path (default: data/followers.db)
  --confirm-remove-scans <n>
                         Full missing scans needed to confirm removal (default: 2)
  --manual               Do not auto-click "粉丝"; wait for you to open the list
  --max <number>         Stop after collecting this many followers
  --idle-rounds <number> Stop after this many scrolls without new rows (default: 30)
  --max-rounds <number>  Hard scroll limit (default: 1200)
  --checkpoint-every <n> Save partial progress after this many new rows (default: 1, 0 disables periodic saves)
  --auth-wait-seconds <n>
                         Wait this long for manual login/captcha in non-TTY browser runtime (default: 0)
  --notify <mode>        Completion notification: none, macos, webhook, bark (default: none)
  --headless             Run headless; not recommended for login
  --help                 Show this message
`);
}

function nowStamp(date = new Date()) {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function promptEnter(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question(`${message}\n按 Enter 继续...`);
  } finally {
    rl.close();
  }
}

async function launchBrowser(options) {
  const { chromium } = await import('playwright');
  const launchOptions = {
    headless: options.headless,
    slowMo: options.slowMo,
    viewport: { width: 1365, height: 900 },
    locale: 'zh-CN'
  };

  const preferredChannel = process.env.PLAYWRIGHT_CHANNEL || 'chrome';
  try {
    return await chromium.launchPersistentContext(options.profile, {
      ...launchOptions,
      channel: preferredChannel
    });
  } catch (error) {
    if (process.env.PLAYWRIGHT_CHANNEL) throw error;
    console.warn(`无法启动系统 Chrome，改用 Playwright Chromium: ${error.message.split('\n')[0]}`);
    console.warn('如果这里失败，请运行: npx playwright install chromium');
    return chromium.launchPersistentContext(options.profile, launchOptions);
  }
}

async function waitForInitialPage(page, target) {
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}

async function looksLoggedOut(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    return /扫码登录|验证码登录|密码登录|登录后可/.test(text);
  }).catch(() => false);
}

async function tryOpenFollowerList(page) {
  const candidates = [
    'button:has-text("粉丝")',
    'a:has-text("粉丝")',
    '[role="button"]:has-text("粉丝")',
    'text=粉丝'
  ];

  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count()) {
        await locator.click({ timeout: 5_000 });
        await page.waitForTimeout(1_500);
        if (await hasFollowerLikePanel(page)) return true;
      }
    } catch {
      // Try the next selector. Douyin changes its markup often.
    }
  }

  return false;
}

async function hasFollowerLikePanel(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 160 && rect.height > 160 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const roots = [
      ...document.querySelectorAll('[role="dialog"], [class*="dialog" i], [class*="modal" i], body')
    ].filter(visible);

    return roots.some((root) => {
      const text = root.innerText || '';
      const userLinks = root.querySelectorAll('a[href*="/user/"]').length;
      return userLinks > 0 && /粉丝|关注/.test(text);
    });
  }).catch(() => false);
}

async function collectFollowers(page, options) {
  const byKey = new Map();
  const checkpoint = { lastCount: 0 };
  let lastCount = 0;
  let idleRounds = 0;

  for (let round = 1; round <= options.maxRounds; round += 1) {
    const result = await page.evaluate(extractFollowersInPage);
    mergeFollowers(byKey, result.followers);
    let followers = [...byKey.values()];
    options.currentFollowers = followers;
    const reachedMax = options.max > 0 && followers.length >= options.max;
    if (reachedMax) followers = followers.slice(0, options.max);

    if (followers.length > lastCount) {
      console.log(`已采集 ${followers.length} 个粉丝候选，容器: ${result.containerLabel}`);
      lastCount = followers.length;
      idleRounds = 0;
      await maybePersistProgress(options, followers, checkpoint, {
        round,
        status: 'collecting',
        containerLabel: result.containerLabel
      });
    } else {
      idleRounds += 1;
    }

    if (reachedMax) {
      console.log(`已达到 --max=${options.max}，停止滚动。`);
      await maybePersistProgress(options, followers, checkpoint, {
        round,
        status: 'max-reached',
        containerLabel: result.containerLabel,
        force: true
      });
      break;
    }

    if (result.noMore) {
      await maybePersistProgress(options, followers, checkpoint, {
        round,
        status: 'no-more',
        containerLabel: result.containerLabel,
        force: true
      });
      break;
    }

    const scrolled = await page.evaluate(scrollBestFollowerContainer);
    if (!scrolled) await page.waitForTimeout(1200);

    if (idleRounds >= options.idleRounds) {
      await maybePersistProgress(options, followers, checkpoint, {
        round,
        status: 'idle-limit',
        containerLabel: result.containerLabel,
        force: true
      });
      break;
    }

    await sleep(randomBetween(options.waitMinMs, options.waitMaxMs));
  }

  return [...byKey.values()];
}

function mergeFollowers(byKey, followers) {
  for (const follower of followers) {
    const key = followerKey(follower);
    if (!key) continue;
    const previous = byKey.get(key);
    if (!previous || follower.rawText?.length > previous.rawText?.length) {
      byKey.set(key, follower);
    }
  }
}

function extractFollowersInPage() {
  const ignoredLinePattern = /^(关注|已关注|互相关注|回关|私信|粉丝|获赞|作品|喜欢|收藏|朋友|推荐|登录|扫一扫|查看更多|取消|确定|移除|确认移除)$/;

  function clean(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  function visible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function normalizeUrl(href) {
    try {
      const url = new URL(href, location.href);
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      return '';
    }
  }

  function userIdFromUrl(url) {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\/user\/([^/?#]+)/);
      if (!match) return '';
      return decodeURIComponent(match[1]);
    } catch {
      return '';
    }
  }

  function scoreContainer(element, index) {
    const rect = element.getBoundingClientRect();
    if (!visible(element) || rect.width < 220 || rect.height < 180) return null;

    const text = element.innerText || '';
    const userLinks = [...element.querySelectorAll('a[href*="/user/"]')].filter(visible).length;
    const style = getComputedStyle(element);
    const zIndex = Number.parseInt(style.zIndex, 10) || 0;
    const isScrollable = element.scrollHeight > element.clientHeight + 20;
    const isDialogish = element.getAttribute('role') === 'dialog' || /dialog|modal|popover|drawer/i.test(element.className || '');
    const hasFollowerSignal = /粉丝|关注/.test(text.slice(0, 800));

    if (userLinks === 0) return null;

    let score = userLinks * 30;
    if (isScrollable) score += 100;
    if (isDialogish) score += 120;
    if (hasFollowerSignal) score += 60;
    if (style.position === 'fixed') score += 50;
    score += Math.min(zIndex, 1000) / 10;

    return {
      element,
      index,
      score,
      userLinks,
      label: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.className ? `.${String(element.className).split(/\s+/).slice(0, 2).join('.')}` : ''}`
    };
  }

  function bestContainer() {
    const roots = [
      ...document.querySelectorAll('[role="dialog"], [class*="dialog" i], [class*="modal" i], [class*="drawer" i], main, section, div'),
      document.body
    ];

    const scored = roots
      .map((element, index) => scoreContainer(element, index))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    return scored[0] || { element: document.body, label: 'body', userLinks: 0 };
  }

  function cardForAnchor(anchor, root) {
    let current = anchor;
    for (let depth = 0; depth < 6 && current && current !== root.parentElement; depth += 1) {
      const lines = clean(current.innerText).split('\n').map(clean).filter(Boolean);
      const hasUserLink = current.querySelectorAll?.('a[href*="/user/"]').length > 0 || current.matches?.('a[href*="/user/"]');
      const hasActionText = lines.some((line) => /关注|私信|粉丝/.test(line));
      if (hasUserLink && (lines.length >= 2 || hasActionText)) return current;
      current = current.parentElement;
    }
    return anchor;
  }

  function pickNickname(anchor, lines) {
    const anchorText = clean(anchor.innerText || anchor.getAttribute('aria-label') || anchor.getAttribute('title'));
    if (anchorText && !ignoredLinePattern.test(anchorText)) return anchorText.split('\n').map(clean).find(Boolean) || '';

    return lines.find((line) => {
      if (!line || ignoredLinePattern.test(line)) return false;
      if (/^(抖音号|IP属地|年龄|地区|粉丝|获赞)[:：]/.test(line)) return false;
      if (/^\d+(\.\d+)?([wWkK万亿])?$/.test(line)) return false;
      return true;
    }) || '';
  }

  const container = bestContainer();
  const anchors = [...container.element.querySelectorAll('a[href*="/user/"]')].filter(visible);
  const byKey = new Map();

  for (const anchor of anchors) {
    const profileUrl = normalizeUrl(anchor.href);
    const id = userIdFromUrl(profileUrl);
    if (!id || id === 'self') continue;

    const card = cardForAnchor(anchor, container.element);
    const lines = clean(card.innerText).split('\n').map(clean).filter(Boolean);
    const nickname = pickNickname(anchor, lines);
    const douyinIdLine = lines.find((line) => /^抖音号[:：]/.test(line));
    const douyinId = douyinIdLine ? clean(douyinIdLine.replace(/^抖音号[:：]/, '')) : '';
    const rawText = lines.slice(0, 8);
    const key = id || profileUrl || nickname;

    if (!nickname && !profileUrl) continue;

    const follower = {
      id,
      nickname: nickname || id,
      douyinId,
      profileUrl,
      rawText
    };

    const previous = byKey.get(key);
    if (!previous || follower.rawText.length > previous.rawText.length) {
      byKey.set(key, follower);
    }
  }

  return {
    followers: [...byKey.values()],
    containerLabel: `${container.label} (${container.userLinks} user links)`,
    noMore: /暂时没有更多了|没有更多了/.test(`${container.element.innerText || ''}\n${document.body?.innerText || ''}`)
  };
}

function scrollBestFollowerContainer() {
  function visible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function score(element) {
    if (!visible(element)) return -1;
    const userLinks = element.querySelectorAll('a[href*="/user/"]').length;
    const scrollable = element.scrollHeight > element.clientHeight + 20;
    if (!scrollable) return -1;
    let value = userLinks * 30;
    if (scrollable) value += 100;
    if (element.getAttribute('role') === 'dialog' || /dialog|modal|drawer/i.test(element.className || '')) value += 100;
    if (getComputedStyle(element).position === 'fixed') value += 40;
    return value;
  }

  const candidates = [
    ...document.querySelectorAll('[role="dialog"], [class*="dialog" i], [class*="modal" i], [class*="drawer" i], main, section, div'),
    document.scrollingElement,
    document.documentElement,
    document.body
  ].filter(Boolean);

  const target = candidates
    .map((element) => ({ element, score: score(element) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score)[0]?.element;

  if (!target) return false;

  const before = target.scrollTop;
  const amount = Math.max(1200, target.clientHeight * 2);
  const maxScrollTop = Math.max(0, target.scrollHeight - target.clientHeight);
  const next = Math.min(maxScrollTop, before + amount);
  target.scrollTop = next;
  target.dispatchEvent(new Event('scroll', { bubbles: true }));
  target.dispatchEvent(new WheelEvent('wheel', { deltaY: amount, bubbles: true, cancelable: true }));
  return target.scrollTop !== before || target.scrollTop + target.clientHeight < target.scrollHeight - 2;
}

function resetBestFollowerScrollContainer() {
  function visible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function score(element) {
    if (!visible(element)) return -1;
    const userLinks = element.querySelectorAll('a[href*="/user/"]').length;
    const scrollable = element.scrollHeight > element.clientHeight + 20;
    if (!scrollable) return -1;
    let value = userLinks * 30;
    if (scrollable) value += 100;
    if (element.getAttribute('role') === 'dialog' || /dialog|modal|drawer/i.test(element.className || '')) value += 100;
    if (getComputedStyle(element).position === 'fixed') value += 40;
    return value;
  }

  const candidates = [
    ...document.querySelectorAll('[role="dialog"], [class*="dialog" i], [class*="modal" i], [class*="drawer" i], main, section, div'),
    document.scrollingElement,
    document.documentElement,
    document.body
  ].filter(Boolean);

  const target = candidates
    .map((element) => ({ element, score: score(element) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score)[0]?.element;

  if (!target) return false;
  target.scrollTop = 0;
  target.dispatchEvent(new Event('scroll', { bubbles: true }));
  return true;
}

function extractProfileStatsInPage() {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const lines = (document.body?.innerText || '')
    .split('\n')
    .map(clean)
    .filter(Boolean);
  const joined = lines.join(' ');

  const parseCount = (value) => {
    const text = clean(value);
    const match = text.match(/([\d.]+)\s*([万亿]?)/);
    if (!match) return null;
    const number = Number.parseFloat(match[1]);
    if (!Number.isFinite(number)) return null;
    if (match[2] === '万') return Math.round(number * 10_000);
    if (match[2] === '亿') return Math.round(number * 100_000_000);
    return Math.round(number);
  };

  let followingText = '';
  let followersText = '';
  let likesText = '';

  const compactMatch = joined.match(/关注\s*([\d.]+(?:\s*[万亿])?)\s*(?:\d+\s*人正在直播\s*)?粉丝\s*([\d.]+(?:\s*[万亿])?)\s*获赞\s*([\d.]+(?:\s*[万亿])?)/);
  if (compactMatch) {
    followingText = compactMatch[1];
    followersText = compactMatch[2];
    likesText = compactMatch[3];
  }

  for (let i = 0; i < lines.length; i += 1) {
    if (followingText && followersText) break;
    if (lines[i] !== '关注' || parseCount(lines[i + 1]) === null) continue;
    const windowLines = lines.slice(i, i + 12);
    const fanIndex = windowLines.indexOf('粉丝');
    if (fanIndex === -1) continue;

    followingText = lines[i + 1] || '';
    followersText = windowLines[fanIndex + 1] || '';

    const likeLine = windowLines.find((line) => /^获赞\b/.test(line));
    const likeIndex = windowLines.indexOf('获赞');
    likesText = likeLine ? clean(likeLine.replace(/^获赞/, '')) : (likeIndex === -1 ? '' : windowLines[likeIndex + 1] || '');
    break;
  }

  return {
    followingText,
    followersText,
    likesText,
    following: parseCount(followingText),
    followers: parseCount(followersText),
    likes: parseCount(likesText)
  };
}

async function ensureFollowerPanelInBrowserApp(options) {
  await ensureDouyinPageInBrowserApp(options);

  const opened = await options.browserRuntime.evaluateJson(`(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const hasFollowerList = () => {
      const roots = [...document.querySelectorAll('[role="dialog"], [class*="dialog" i], [class*="modal" i], [class*="drawer" i], body')].filter(visible);
      return roots.some((root) => root.querySelectorAll('a[href*="/user/"]').length > 0 && /粉丝/.test(root.innerText || ''));
    };

    if (hasFollowerList()) return { ok: true, opened: true, reason: 'already-open' };

    const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="tab"], div, span')]
      .filter(visible)
      .filter((element) => /粉丝/.test((element.innerText || element.textContent || '').trim()))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (ar.width * ar.height) - (br.width * br.height);
      });

    const target = candidates[0];
    if (!target) return { ok: true, opened: false, reason: 'no-follower-element' };
    target.click();
    return { ok: true, opened: true, reason: 'clicked' };
  })()`);

  if (!opened.ok) throw new Error(opened.error);
  await sleep(1800);

  const selected = await options.browserRuntime.evaluateJson(`(() => {
    const tabs = [...document.querySelectorAll('[role="tab"], button, div, span')]
      .filter((element) => /粉丝/.test((element.innerText || element.textContent || '').trim()));
    const selectedTab = tabs.find((element) => element.getAttribute('aria-selected') === 'true' || /selected|active/i.test(element.className || ''));
    if (selectedTab) selectedTab.click();
    return { ok: true, selected: Boolean(selectedTab), tabs: tabs.length };
  })()`);

  if (!selected.ok) throw new Error(selected.error);
  await options.browserRuntime.evaluateJson(`(${resetBestFollowerScrollContainer.toString()})()`);
  await sleep(1200);
}

async function ensureDouyinPageInBrowserApp(options) {
  const pageInfo = await options.browserRuntime.readPageInfo();

  if (!pageInfo.ok) throw new Error(pageInfo.error);
  if (!/douyin\.com/.test(pageInfo.url)) {
    throw new Error(`当前浏览器活动标签页不是抖音页面: ${pageInfo.url}`);
  }
  return pageInfo;
}

async function readBrowserProfileStats(options) {
  let lastStats = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const stats = await options.browserRuntime.evaluateJson(`(${extractProfileStatsInPage.toString()})()`);
    if (stats?.ok === false) throw new Error(stats.error);
    lastStats = stats;
    if (!profileStatsEmpty(stats)) return stats;
    await sleep(500);
  }
  return lastStats;
}

function extractSelfUserIdentityInPage() {
  const html = document.documentElement.outerHTML || '';
  const safeDecode = (text) => {
    try {
      return decodeURIComponent(text.replace(/%(?![0-9a-fA-F]{2})/g, '%25'));
    } catch {
      return text;
    }
  };

  const candidates = [html, safeDecode(html)];
  for (const text of candidates) {
    const match = text.match(/"uid"\s*:\s*"(\d+)"\s*,\s*"secUid"\s*:\s*"([^"]+)"/);
    if (match) {
      return {
        userId: match[1],
        secUserId: match[2]
      };
    }
  }

  return { userId: '', secUserId: '' };
}

async function readBrowserSelfIdentity(options) {
  const identity = await options.browserRuntime.evaluateJson(`(${extractSelfUserIdentityInPage.toString()})()`);
  if (identity?.ok === false) throw new Error(identity.error);
  if (!identity?.userId || !identity?.secUserId) {
    throw new Error('无法从当前抖音页面读取登录用户 uid/secUid。请确认该 runtime/profile 已登录抖音，并且活动标签页是自己的抖音主页。');
  }
  return identity;
}

function apiFollowerToFollower(user) {
  const id = user.secUid || user.sec_uid || '';
  const uid = user.uid || '';
  const nickname = user.remarkName || user.remark_name || user.nickname || id || uid;
  const desc = user.desc || user.signature || '';
  return {
    id,
    uid,
    nickname,
    douyinId: '',
    profileUrl: id ? `https://www.douyin.com/user/${encodeURIComponent(id)}` : '',
    rawText: [nickname, desc].filter(Boolean)
  };
}

async function callFollowerApiPage(options, identity, cursorMaxTime) {
  const args = {
    user_id: identity.userId,
    sec_user_id: identity.secUserId,
    offset: 0,
    min_time: 0,
    max_time: cursorMaxTime || 0,
    count: 20,
    source_type: options.apiSourceType,
    gps_access: 0,
    address_book_access: 0
  };

  return options.browserRuntime.evaluateMainWorldJson(`(() => {
    if (!window.webpackChunkdouyin_web) throw new Error('Douyin webpack runtime is not available on this page');
    window.webpackChunkdouyin_web.push([[Math.floor(Math.random() * 1e9)], {}, function(req) {
      window.__douyin_follower_require__ = req;
    }]);
    const req = window.__douyin_follower_require__;
    const endpoint = '/aweme/v1/web/user/follower/list/';
    const moduleIds = Object.keys(req.m || {});
    let followerApi = null;

    for (const moduleId of moduleIds) {
      const moduleFactory = String(req.m[moduleId] || '');
      if (!moduleFactory.includes(endpoint)) continue;

      const moduleExports = req(moduleId);
      for (const exportedValue of Object.values(moduleExports || {})) {
        if (typeof exportedValue === 'function' && String(exportedValue).includes(endpoint)) {
          followerApi = exportedValue;
          break;
        }
      }
      if (followerApi) break;
    }

    if (!followerApi) {
      const fallbackModule = req(47069);
      if (fallbackModule && typeof fallbackModule._C === 'function') followerApi = fallbackModule._C;
    }

    if (!followerApi) {
      throw new Error('Douyin follower API module is not available');
    }
    return followerApi(${JSON.stringify(args)});
  })()`, { timeoutMs: 45_000 });
}

async function collectFollowersFromBrowserApi(options) {
  await ensureDouyinPageInBrowserApp(options);
  const identity = await readBrowserSelfIdentity(options);
  const mode = options.effectiveMode || options.mode;
  const maxPages = mode === 'recent' ? options.recentPages : options.maxRounds;
  const knownActiveIds = options.knownActiveIds || new Set();
  const stopWhenKnownIds = mode === 'recent' && knownActiveIds.size > 0;
  options.scanComplete = mode === 'recent';

  const byKey = new Map();
  const checkpoint = { lastCount: 0 };
  let cursorMaxTime = 0;
  let previousCursor = null;
  let consecutiveKnownIds = 0;

  for (let round = 1; round <= options.maxRounds && round <= maxPages; round += 1) {
    const page = await callFollowerApiPage(options, identity, cursorMaxTime);
    options.pagesFetched = round;
    if (page.statusCode && page.statusCode !== 0) {
      throw new Error(`粉丝接口返回异常: ${page.statusCode} ${page.statusMsg || ''}`.trim());
    }

    const pageFollowers = (page.followList || []).map(apiFollowerToFollower);
    for (const follower of pageFollowers) {
      if (knownActiveIds.has(follower.id)) consecutiveKnownIds += 1;
      else consecutiveKnownIds = 0;
    }

    mergeFollowers(byKey, pageFollowers);
    let followers = [...byKey.values()];
    options.currentFollowers = followers;
    if (options.max > 0 && followers.length >= options.max) {
      followers = followers.slice(0, options.max);
      await maybePersistProgress(options, followers, checkpoint, {
        round,
        status: 'api-max-reached',
        containerLabel: 'in-page follower API',
        force: true
      });
      console.log(`已达到 --max=${options.max}，停止分页。`);
      options.scanComplete = false;
      return followers;
    }

    console.log(`API 第 ${round} 页: 本页 ${pageFollowers.length}，累计 ${followers.length}，hasMore=${Boolean(page.hasMore)}`);
    await maybePersistProgress(options, followers, checkpoint, {
      round,
      status: `api-${mode}-collecting`,
      containerLabel: 'in-page follower API'
    });

    if (stopWhenKnownIds && consecutiveKnownIds >= 20) {
      await maybePersistProgress(options, followers, checkpoint, {
        round,
        status: 'api-known-window',
        containerLabel: 'in-page follower API',
        force: true
      });
      options.scanComplete = mode === 'recent';
      break;
    }

    if (!page.hasMore || !page.followList?.length) {
      options.scanComplete = true;
      await maybePersistProgress(options, followers, checkpoint, {
        round,
        status: 'api-no-more',
        containerLabel: 'in-page follower API',
        force: true
      });
      break;
    }

    const nextCursor = Number(page.minTime || page.min_time || 0);
    if (!nextCursor || nextCursor === previousCursor || nextCursor === cursorMaxTime) {
      await maybePersistProgress(options, followers, checkpoint, {
        round,
        status: 'api-cursor-stopped',
        containerLabel: 'in-page follower API',
        force: true
      });
      options.scanComplete = false;
      break;
    }

    previousCursor = cursorMaxTime;
    cursorMaxTime = nextCursor;
    await sleep(randomBetween(options.waitMinMs, options.waitMaxMs));
  }

  if (mode === 'full' && !options.scanComplete) {
    console.warn('本次 full 扫描没有自然到达列表末尾，不会推进疑似/确认取关状态。');
  }

  return [...byKey.values()];
}

async function collectFollowersFromBrowserApp(options) {
  await ensureFollowerPanelInBrowserApp(options);

  const byKey = new Map();
  const checkpoint = { lastCount: 0 };
  let lastCount = 0;
  let idleRounds = 0;

  for (let round = 1; round <= options.maxRounds; round += 1) {
    const result = await options.browserRuntime.evaluateJson(`(() => {
      const extracted = (${extractFollowersInPage.toString()})();
      const scrolled = extracted.noMore ? false : (${scrollBestFollowerContainer.toString()})();
      return { ok: true, ...extracted, scrolled };
    })()`);

    if (!result.ok) throw new Error(result.error);
    mergeFollowers(byKey, result.followers || []);

    let followers = [...byKey.values()];
    options.currentFollowers = followers;
    const reachedMax = options.max > 0 && followers.length >= options.max;
    if (reachedMax) followers = followers.slice(0, options.max);

    if (followers.length > lastCount) {
      console.log(`已采集 ${followers.length} 个粉丝候选，容器: ${result.containerLabel}`);
      lastCount = followers.length;
      idleRounds = 0;
      await maybePersistProgress(options, followers, checkpoint, {
        round,
        status: 'collecting',
        containerLabel: result.containerLabel
      });
    } else {
      idleRounds += 1;
    }

    if (reachedMax) {
      console.log(`已达到 --max=${options.max}，停止滚动。`);
      await maybePersistProgress(options, followers, checkpoint, {
        round,
        status: 'max-reached',
        containerLabel: result.containerLabel,
        force: true
      });
      return followers;
    }

    if (result.noMore) {
      await maybePersistProgress(options, followers, checkpoint, {
        round,
        status: 'no-more',
        containerLabel: result.containerLabel,
        force: true
      });
      break;
    }

    if (!result.scrolled) await sleep(1200);
    if (idleRounds >= options.idleRounds) {
      await maybePersistProgress(options, followers, checkpoint, {
        round,
        status: 'idle-limit',
        containerLabel: result.containerLabel,
        force: true
      });
      break;
    }

    await sleep(randomBetween(options.waitMinMs, options.waitMaxMs));
  }

  return [...byKey.values()];
}

function followerKey(follower) {
  return follower.id || follower.profileUrl || follower.nickname;
}

function diffSnapshots(previousFollowers, currentFollowers) {
  const previous = new Map(previousFollowers.map((follower) => [followerKey(follower), follower]));
  const current = new Map(currentFollowers.map((follower) => [followerKey(follower), follower]));

  const added = [];
  const removed = [];
  const renamed = [];

  for (const [key, follower] of current) {
    if (!previous.has(key)) {
      added.push(follower);
      continue;
    }

    const oldFollower = previous.get(key);
    if (
      oldFollower.nickname &&
      follower.nickname &&
      oldFollower.nickname !== follower.nickname &&
      !isUnstableNickname(oldFollower.nickname) &&
      !isUnstableNickname(follower.nickname)
    ) {
      renamed.push({ before: oldFollower, after: follower });
    }
  }

  for (const [key, follower] of previous) {
    if (!current.has(key)) removed.push(follower);
  }

  return { added, removed, renamed };
}

function isUnstableNickname(value) {
  return /^(关注|已关注|互相关注|回关|私信|粉丝|获赞|作品|喜欢|收藏|朋友|推荐|登录|扫一扫|查看更多|取消|确定|移除|确认移除)$/.test(String(value || '').trim());
}

async function openMonitorDatabase(dbPath) {
  await mkdir(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS followers (
      id TEXT PRIMARY KEY,
      uid TEXT,
      nickname TEXT NOT NULL DEFAULT '',
      profileUrl TEXT NOT NULL DEFAULT '',
      firstSeenAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL,
      lastFullSeenAt TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      suspectedRemovedAt TEXT,
      removedAt TEXT,
      missingFullScans INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS scan_runs (
      runId TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      requestedMode TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      finishedAt TEXT,
      status TEXT NOT NULL,
      profileFollowerCount INTEGER,
      enumerableCount INTEGER,
      pagesFetched INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS follower_events (
      eventId INTEGER PRIMARY KEY AUTOINCREMENT,
      followerId TEXT NOT NULL,
      type TEXT NOT NULL,
      runId TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      payloadJson TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_followers_status ON followers(status);
    CREATE INDEX IF NOT EXISTS idx_scan_runs_mode_status ON scan_runs(mode, status, startedAt);
    CREATE INDEX IF NOT EXISTS idx_follower_events_follower ON follower_events(followerId, createdAt);
  `);
  db.prepare(`
    INSERT INTO meta (key, value)
    VALUES ('schema_version', '1')
    ON CONFLICT(key) DO NOTHING
  `).run();
  return db;
}

function closeMonitorDatabase(db) {
  try {
    db?.close();
  } catch {
    // Best-effort cleanup only.
  }
}

function normalizeDbFollower(row) {
  return {
    id: row.id,
    uid: row.uid || '',
    nickname: row.nickname || row.id,
    douyinId: '',
    profileUrl: row.profileUrl || (row.id ? `https://www.douyin.com/user/${encodeURIComponent(row.id)}` : ''),
    firstSeenAt: row.firstSeenAt || null,
    lastSeenAt: row.lastSeenAt || null,
    lastFullSeenAt: row.lastFullSeenAt || null,
    status: row.status || 'active',
    suspectedRemovedAt: row.suspectedRemovedAt || null,
    removedAt: row.removedAt || null,
    rawText: [row.nickname || row.id].filter(Boolean)
  };
}

function getActiveFollowerIds(db) {
  return new Set(db.prepare("SELECT id FROM followers WHERE status = 'active'").all().map((row) => row.id));
}

function getExportFollowersFromDb(db) {
  return db.prepare(`
    SELECT id, uid, nickname, profileUrl, firstSeenAt, lastSeenAt, lastFullSeenAt, status, suspectedRemovedAt, removedAt
    FROM followers
    WHERE status = 'active'
    ORDER BY lastSeenAt DESC, firstSeenAt DESC
  `).all().map(normalizeDbFollower);
}

function getLastCompletedScan(db) {
  return db.prepare(`
    SELECT *
    FROM scan_runs
    WHERE status = 'completed'
    ORDER BY finishedAt DESC, startedAt DESC
    LIMIT 1
  `).get() || null;
}

function getLastCompletedFullScan(db) {
  return db.prepare(`
    SELECT *
    FROM scan_runs
    WHERE status = 'completed' AND mode = 'full'
    ORDER BY finishedAt DESC, startedAt DESC
    LIMIT 1
  `).get() || null;
}

async function seedDatabaseFromLatestSnapshot(db, options) {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM followers').get();
  if (existing.count > 0) return false;

  const latest = await readJsonIfExists(path.join(options.outDir, 'latest.json'));
  if (!latest?.followers?.length) return false;

  const collectedAt = latest.collectedAt || new Date().toISOString();
  const snapshotMode = latest.mode || 'full';
  const scanComplete = latest.scanComplete !== false;
  const treatAsFullBaseline = snapshotMode === 'full' && scanComplete;
  const insertFollower = db.prepare(`
    INSERT INTO followers (
      id, uid, nickname, profileUrl, firstSeenAt, lastSeenAt, lastFullSeenAt,
      status, suspectedRemovedAt, removedAt, missingFullScans
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, 0)
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const follower of dedupeFollowers(latest.followers).filter((item) => item.id)) {
      insertFollower.run(
        follower.id,
        follower.uid || '',
        follower.nickname || follower.id,
        follower.profileUrl || `https://www.douyin.com/user/${encodeURIComponent(follower.id)}`,
        follower.firstSeenAt || collectedAt,
        follower.lastSeenAt || collectedAt,
        treatAsFullBaseline ? (follower.lastFullSeenAt || collectedAt) : null
      );
    }

    db.prepare(`
      INSERT INTO scan_runs (
        runId, mode, requestedMode, startedAt, finishedAt, status,
        profileFollowerCount, enumerableCount, pagesFetched, reason
      ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, 0, 'seed-latest-json')
    `).run(
      `seed-${nowStamp(new Date(collectedAt))}`,
      treatAsFullBaseline ? 'full' : snapshotMode,
      snapshotMode,
      collectedAt,
      collectedAt,
      latest.profileStats?.followers ?? null,
      latest.followers.length
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  console.log(`已从 ${path.join(options.outDir, 'latest.json')} 初始化 SQLite 基线: ${latest.followers.length}`);
  return true;
}

function decideEffectiveScanMode(db, options, profileStats) {
  if (options.mode !== 'monitor') {
    return { mode: options.mode, reason: `explicit:${options.mode}` };
  }

  if (options.forceFull) {
    return { mode: 'full', reason: 'force-full' };
  }

  const lastFull = getLastCompletedFullScan(db);
  if (!lastFull) {
    return { mode: 'full', reason: 'no-full-baseline' };
  }

  const lastScan = getLastCompletedScan(db);
  const currentProfileFollowers = profileStats?.followers;
  if (
    Number.isFinite(currentProfileFollowers) &&
    Number.isFinite(lastScan?.profileFollowerCount) &&
    currentProfileFollowers < lastScan.profileFollowerCount
  ) {
    return { mode: 'full', reason: 'profile-followers-decreased' };
  }

  const lastFullAt = Date.parse(lastFull.finishedAt || lastFull.startedAt || '');
  const fullIntervalMs = options.fullIntervalHours * 60 * 60 * 1000;
  if (!Number.isFinite(lastFullAt) || Date.now() - lastFullAt >= fullIntervalMs) {
    return { mode: 'full', reason: 'full-interval-elapsed' };
  }

  return { mode: 'recent', reason: 'recent-window' };
}

function startScanRun(db, options) {
  const runId = options.runId || `run-${nowStamp(new Date(options.runStartedAt || new Date()))}`;
  options.runId = runId;
  db.prepare(`
    INSERT OR REPLACE INTO scan_runs (
      runId, mode, requestedMode, startedAt, status, profileFollowerCount, enumerableCount, pagesFetched, reason
    ) VALUES (?, ?, ?, ?, 'running', ?, 0, 0, ?)
  `).run(
    runId,
    options.effectiveMode || options.mode,
    options.mode,
    options.runStartedAt || new Date().toISOString(),
    options.profileStats?.followers ?? null,
    options.modeReason || ''
  );
  return runId;
}

function finishScanRun(db, options, { status = 'completed', enumerableCount = 0, pagesFetched = 0 } = {}) {
  if (!options.runId) return;
  db.prepare(`
    UPDATE scan_runs
    SET finishedAt = ?, status = ?, profileFollowerCount = ?, enumerableCount = ?, pagesFetched = ?, reason = ?
    WHERE runId = ?
  `).run(
    new Date().toISOString(),
    status,
    options.profileStats?.followers ?? null,
    enumerableCount,
    pagesFetched,
    options.modeReason || '',
    options.runId
  );
}

function insertFollowerEvent(db, { followerId, type, runId, createdAt, payload = {} }) {
  db.prepare(`
    INSERT INTO follower_events (followerId, type, runId, createdAt, payloadJson)
    VALUES (?, ?, ?, ?, ?)
  `).run(followerId, type, runId, createdAt, JSON.stringify(payload));
}

function dedupeFollowers(followers) {
  const byKey = new Map();
  mergeFollowers(byKey, followers);
  return [...byKey.values()];
}

function applyScanToDatabase(db, options, scanFollowers) {
  const now = new Date().toISOString();
  const runId = options.runId || `run-${nowStamp(new Date(now))}`;
  const mode = options.effectiveMode || options.mode;
  const isFull = mode === 'full';
  const isCompleteFull = isFull && options.scanComplete !== false;
  const followers = dedupeFollowers(scanFollowers).filter((follower) => follower.id);
  const seenIds = new Set(followers.map((follower) => follower.id));
  const existingRows = db.prepare('SELECT * FROM followers').all();
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const beforeActiveCount = existingRows.filter((row) => row.status === 'active').length;
  const change = {
    mode,
    requestedMode: options.mode,
    reason: options.modeReason || '',
    new: [],
    suspectedRemoved: [],
    removed: [],
    renamed: [],
    reappeared: [],
    seenCount: followers.length
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    const insertFollower = db.prepare(`
      INSERT INTO followers (
        id, uid, nickname, profileUrl, firstSeenAt, lastSeenAt, lastFullSeenAt,
        status, suspectedRemovedAt, removedAt, missingFullScans
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, 0)
    `);
    const updateFollower = db.prepare(`
      UPDATE followers
      SET uid = ?, nickname = ?, profileUrl = ?, lastSeenAt = ?,
          lastFullSeenAt = CASE WHEN ? THEN ? ELSE lastFullSeenAt END,
          status = 'active', suspectedRemovedAt = NULL, removedAt = NULL, missingFullScans = 0
      WHERE id = ?
    `);
    const markSuspected = db.prepare(`
      UPDATE followers
      SET status = 'suspected_removed',
          suspectedRemovedAt = COALESCE(suspectedRemovedAt, ?),
          missingFullScans = ?
      WHERE id = ?
    `);
    const markRemoved = db.prepare(`
      UPDATE followers
      SET status = 'removed',
          removedAt = COALESCE(removedAt, ?),
          missingFullScans = ?
      WHERE id = ?
    `);

    for (const follower of followers) {
      const existing = existingById.get(follower.id);
      const nickname = follower.nickname || follower.id;
      const profileUrl = follower.profileUrl || `https://www.douyin.com/user/${encodeURIComponent(follower.id)}`;

      if (!existing) {
        insertFollower.run(follower.id, follower.uid || '', nickname, profileUrl, now, now, isCompleteFull ? now : null);
        insertFollowerEvent(db, {
          followerId: follower.id,
          type: 'new',
          runId,
          createdAt: now,
          payload: { nickname, profileUrl }
        });
        change.new.push(follower);
        continue;
      }

      if (
        existing.nickname &&
        nickname &&
        existing.nickname !== nickname &&
        !isUnstableNickname(existing.nickname) &&
        !isUnstableNickname(nickname)
      ) {
        const renamed = { before: normalizeDbFollower(existing), after: { ...follower, nickname, profileUrl } };
        change.renamed.push(renamed);
        insertFollowerEvent(db, {
          followerId: follower.id,
          type: 'renamed',
          runId,
          createdAt: now,
          payload: { before: existing.nickname, after: nickname }
        });
      }

      if (existing.status !== 'active') {
        change.reappeared.push({ ...follower, nickname, profileUrl });
        insertFollowerEvent(db, {
          followerId: follower.id,
          type: 'reappeared',
          runId,
          createdAt: now,
          payload: { previousStatus: existing.status }
        });
      }

      updateFollower.run(follower.uid || existing.uid || '', nickname, profileUrl, now, isCompleteFull ? 1 : 0, now, follower.id);
    }

    if (isCompleteFull) {
      for (const row of existingRows) {
        if (seenIds.has(row.id) || row.status === 'removed') continue;

        const missingFullScans = Number(row.missingFullScans || 0) + 1;
        const follower = normalizeDbFollower(row);
        if (row.status === 'active') {
          markSuspected.run(now, missingFullScans, row.id);
          change.suspectedRemoved.push(follower);
          insertFollowerEvent(db, {
            followerId: row.id,
            type: 'suspected_removed',
            runId,
            createdAt: now,
            payload: { missingFullScans }
          });
        } else if (row.status === 'suspected_removed' && missingFullScans >= options.confirmRemoveScans) {
          markRemoved.run(now, missingFullScans, row.id);
          change.removed.push(follower);
          insertFollowerEvent(db, {
            followerId: row.id,
            type: 'removed',
            runId,
            createdAt: now,
            payload: { missingFullScans }
          });
        } else if (row.status === 'suspected_removed') {
          markSuspected.run(row.suspectedRemovedAt || now, missingFullScans, row.id);
        }
      }
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const exportFollowers = getExportFollowersFromDb(db);
  const hiddenOrUnavailableCount = Math.max(0, (options.profileStats?.followers || 0) - exportFollowers.length);
  return {
    exportFollowers,
    change: {
      ...change,
      currentCount: exportFollowers.length,
      previousCount: beforeActiveCount,
      newCount: change.new.length,
      addedCount: change.new.length,
      suspectedRemovedCount: change.suspectedRemoved.length,
      removedCount: change.removed.length,
      renamedCount: change.renamed.length,
      reappearedCount: change.reappeared.length,
      hiddenOrUnavailableCount
    }
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeTextAtomic(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmpPath, contents, 'utf8');
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function toCsv(followers) {
  const rows = [['id', 'uid', 'nickname', 'douyinId', 'profileUrl', 'status', 'firstSeenAt', 'lastSeenAt', 'lastFullSeenAt']];
  for (const follower of followers) {
    rows.push([
      follower.id,
      follower.uid || '',
      follower.nickname,
      follower.douyinId,
      follower.profileUrl,
      follower.status || '',
      follower.firstSeenAt || '',
      follower.lastSeenAt || '',
      follower.lastFullSeenAt || ''
    ]);
  }
  return `${rows.map((row) => row.map(csvEscape).join(',')).join('\n')}\n`;
}

async function persistProgress(options, followers, metadata = {}) {
  const collectedAt = new Date().toISOString();
  const runStartedAt = options.runStartedAt || collectedAt;
  const runStamp = options.runStamp || nowStamp(new Date(runStartedAt));
  const inProgressDir = path.join(options.outDir, 'in-progress');
  const snapshot = {
    collectedAt,
    runStartedAt,
    target: options.target,
    runtime: options.runtime || '',
    runtimeLabel: options.runtimeLabel || '',
    cookieAuth: options.cookieAuth || null,
    mode: options.effectiveMode || options.mode,
    requestedMode: options.mode,
    reason: options.modeReason || '',
    scanComplete: options.scanComplete ?? null,
    profileStats: options.profileStats || null,
    isPartial: true,
    status: metadata.status || 'collecting',
    round: metadata.round || null,
    pagesFetched: options.pagesFetched || metadata.round || 0,
    containerLabel: metadata.containerLabel || '',
    errorCode: metadata.errorCode || null,
    errorMessage: metadata.errorMessage || '',
    count: followers.length,
    followers
  };

  await mkdir(inProgressDir, { recursive: true });
  await writeTextAtomic(path.join(inProgressDir, 'latest.partial.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  await writeTextAtomic(path.join(inProgressDir, 'latest.partial.csv'), toCsv(followers));
  await writeTextAtomic(path.join(inProgressDir, `followers-${runStamp}.partial.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
}

async function persistCollectorError(options, error) {
  const collectedAt = new Date().toISOString();
  const code = classifyCollectorError(error);
  const latestError = {
    collectedAt,
    runId: options.runId || '',
    mode: options.effectiveMode || options.mode || '',
    requestedMode: options.mode || '',
    runtime: options.runtime || '',
    runtimeLabel: options.runtimeLabel || '',
    errorCode: code,
    message: publicErrorMessage(error),
    suggestion: errorSuggestion(code)
  };
  await mkdir(options.outDir, { recursive: true });
  await writeTextAtomic(path.join(options.outDir, 'latest-error.json'), `${JSON.stringify(latestError, null, 2)}\n`);
  await writeTextAtomic(path.join(options.outDir, 'latest-change.json'), `${JSON.stringify({
    ...latestError,
    status: 'failed',
    currentCount: options.currentFollowers?.length || 0,
    newCount: 0,
    addedCount: 0,
    suspectedRemovedCount: 0,
    removedCount: 0,
    renamedCount: 0,
    reappearedCount: 0,
    hiddenOrUnavailableCount: null
  }, null, 2)}\n`);
  await persistProgress(options, options.currentFollowers || [], {
    status: 'failed',
    force: true,
    errorCode: code,
    errorMessage: publicErrorMessage(error)
  });
  return latestError;
}

async function maybePersistProgress(options, followers, state, metadata = {}) {
  if (!followers.length && !metadata.force) return;
  if (options.checkpointEvery === 0 && !metadata.force) return;
  if (!metadata.force && followers.length - state.lastCount < options.checkpointEvery) return;

  await persistProgress(options, followers, metadata);
  state.lastCount = followers.length;
  console.log(`已保存进度: ${followers.length} -> ${path.join(options.outDir, 'in-progress', 'latest.partial.json')}`);
}

async function persistResult(options, followers) {
  const collectedAt = new Date().toISOString();
  const stamp = nowStamp(new Date(collectedAt));
  const snapshotDir = path.join(options.outDir, 'snapshots');
  const changeDir = path.join(options.outDir, 'changes');
  await mkdir(snapshotDir, { recursive: true });
  await mkdir(changeDir, { recursive: true });

  const latestPath = path.join(options.outDir, 'latest.json');
  const previousSnapshot = await readJsonIfExists(latestPath);

  const snapshot = {
    collectedAt,
    runId: options.runId || '',
    target: options.target,
    runtime: options.runtime || '',
    runtimeLabel: options.runtimeLabel || '',
    cookieAuth: options.cookieAuth || null,
    mode: options.effectiveMode || options.mode,
    requestedMode: options.mode,
    reason: options.modeReason || '',
    scanComplete: options.scanComplete ?? null,
    profileStats: options.profileStats || null,
    hiddenOrUnavailableCount: Math.max(0, (options.profileStats?.followers || 0) - followers.length),
    count: followers.length,
    followers
  };

  const snapshotPath = path.join(snapshotDir, `followers-${stamp}.json`);
  await writeTextAtomic(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await writeTextAtomic(latestPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await writeTextAtomic(path.join(options.outDir, 'latest.csv'), toCsv(followers));

  let change;
  if (options.monitorChange) {
    change = {
      collectedAt,
      runId: options.runId || '',
      previousCollectedAt: previousSnapshot?.collectedAt || null,
      mode: options.monitorChange.mode,
      requestedMode: options.mode,
      runtime: options.runtime || '',
      runtimeLabel: options.runtimeLabel || '',
      cookieAuth: options.cookieAuth || null,
      reason: options.monitorChange.reason || options.modeReason || '',
      scanComplete: options.scanComplete ?? null,
      currentCount: options.monitorChange.currentCount,
      previousCount: options.monitorChange.previousCount,
      newCount: options.monitorChange.newCount,
      addedCount: options.monitorChange.addedCount,
      suspectedRemovedCount: options.monitorChange.suspectedRemovedCount,
      removedCount: options.monitorChange.removedCount,
      renamedCount: options.monitorChange.renamedCount,
      reappearedCount: options.monitorChange.reappearedCount,
      hiddenOrUnavailableCount: options.monitorChange.hiddenOrUnavailableCount,
      isInitialSnapshot: !previousSnapshot?.followers,
      added: options.monitorChange.new,
      new: options.monitorChange.new,
      suspectedRemoved: options.monitorChange.suspectedRemoved,
      removed: options.monitorChange.removed,
      renamed: options.monitorChange.renamed,
      reappeared: options.monitorChange.reappeared
    };
  } else {
    const hasPrevious = Boolean(previousSnapshot?.followers);
    const diff = hasPrevious
      ? diffSnapshots(previousSnapshot.followers, followers)
      : { added: [], removed: [], renamed: [] };
    change = {
      collectedAt,
      runId: options.runId || '',
      previousCollectedAt: previousSnapshot?.collectedAt || null,
      mode: options.effectiveMode || options.mode,
      requestedMode: options.mode,
      runtime: options.runtime || '',
      runtimeLabel: options.runtimeLabel || '',
      cookieAuth: options.cookieAuth || null,
      reason: options.modeReason || '',
      scanComplete: options.scanComplete ?? null,
      currentCount: followers.length,
      previousCount: hasPrevious ? previousSnapshot.followers.length : null,
      addedCount: diff.added.length,
      newCount: diff.added.length,
      suspectedRemovedCount: 0,
      removedCount: diff.removed.length,
      renamedCount: diff.renamed.length,
      reappearedCount: 0,
      hiddenOrUnavailableCount: Math.max(0, (options.profileStats?.followers || 0) - followers.length),
      isInitialSnapshot: !hasPrevious,
      ...diff
    };
  }

  if (previousSnapshot?.followers || options.monitorChange) {
    const changePath = path.join(changeDir, `change-${stamp}.json`);
    await writeTextAtomic(changePath, `${JSON.stringify(change, null, 2)}\n`);
  }
  await writeTextAtomic(path.join(options.outDir, 'latest-change.json'), `${JSON.stringify(change, null, 2)}\n`);

  return { snapshotPath, change };
}

function printDiffSummary(change) {
  if (!change || change.isInitialSnapshot) {
    console.log('这是第一次快照，暂无可对比的历史结果。');
    return;
  }

  if (change.mode || change.reason) {
    console.log(`扫描模式: ${change.mode || 'unknown'} (${change.reason || 'no-reason'})`);
  }
  console.log(`新增: ${change.newCount ?? change.addedCount}，疑似取关: ${change.suspectedRemovedCount || 0}，确认取关: ${change.removedCount}，重新出现: ${change.reappearedCount || 0}，改名: ${change.renamedCount}`);
  if (Number.isFinite(change.hiddenOrUnavailableCount)) {
    console.log(`主页粉丝数与可枚举列表差值: ${change.hiddenOrUnavailableCount}`);
  }

  const preview = (label, items) => {
    if (!items.length) return;
    console.log(`${label}:`);
    for (const item of items.slice(0, 10)) {
      const follower = item.after || item;
      console.log(`  - ${follower.nickname} ${follower.profileUrl}`);
    }
    if (items.length > 10) console.log(`  ... 还有 ${items.length - 10} 条`);
  };

  preview('新增粉丝', change.new || change.added || []);
  preview('疑似取关', change.suspectedRemoved || []);
  preview('确认取关', change.removed || []);
  preview('重新出现', change.reappeared || []);
  preview('改名账号', change.renamed);
}

function printProfileCountWarning(profileStats, followers) {
  if (!profileStats?.followers || !followers.length) return;
  if (profileStats.followers === followers.length) return;

  console.warn(`主页粉丝数为 ${profileStats.followers}，本次可枚举粉丝列表为 ${followers.length}。`);
  console.warn('这是抖音隐私设置下的正常现象：关闭“在他人关注和粉丝列表公开出现”的账号会计入总粉丝数，但不会出现在可枚举列表里。');
}

function profileStatsEmpty(profileStats) {
  return !profileStats || (!profileStats.following && !profileStats.followers && !profileStats.likes);
}

function pageLooksLoggedOut(pageInfo) {
  return /扫码登录|验证码登录|密码登录|登录后可/.test(pageInfo?.text || '');
}

function pageNeedsHumanVerification(pageInfo) {
  return /验证码中间页|请完成下列验证|拖动完成|拼图|captcha|verify/i.test(`${pageInfo?.title || ''}\n${pageInfo?.text || ''}`);
}

function emitMonitorEvent(type, payload = {}) {
  console.log(`${MONITOR_EVENT_PREFIX}${JSON.stringify({ type, ...payload })}`);
}

function isTransientPageReadError(error) {
  return /execution context was destroyed|navigation|frame was detached|target closed|cannot find context/i.test(
    String(error?.message || error)
  );
}

async function waitForManualAuthIfNeeded(options, pageInfo) {
  const needsAuth = pageLooksLoggedOut(pageInfo);
  const needsVerification = pageNeedsHumanVerification(pageInfo);
  if (!needsAuth && !needsVerification) return pageInfo;

  const promptText = needsVerification
    ? '浏览器触发了抖音验证码。请在打开的浏览器窗口中手动完成验证，并确认进入自己的抖音主页。'
    : '浏览器里看起来还未登录。请完成登录，并确认打开的是你的个人主页。';
  const challengeKind = needsVerification ? 'captcha' : 'login';

  if (process.stdin.isTTY) {
    await promptEnter(promptText);
    return options.browserRuntime.readPageInfo();
  }

  if (!options.authWaitSeconds) {
    throw new Error(`${promptText} 本次非交互式采集未启用等待，请先完成验证后重试，或通过 dashboard 启动采集。`);
  }

  const startedAt = new Date();
  const deadline = startedAt.getTime() + options.authWaitSeconds * 1000;
  const deadlineAt = new Date(deadline).toISOString();
  emitMonitorEvent('auth_wait_started', {
    kind: challengeKind,
    status: 'waiting',
    startedAt: startedAt.toISOString(),
    deadlineAt,
    message: promptText
  });
  console.log(`${promptText} 正在等待人工处理，最长 ${options.authWaitSeconds} 秒。`);
  const pollMs = options.authPollMs || 2000;
  let loggedNavigationWait = false;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let current;
    try {
      current = await options.browserRuntime.readPageInfo();
    } catch (error) {
      if (isTransientPageReadError(error)) {
        if (!loggedNavigationWait) {
          emitMonitorEvent('auth_wait_transient_navigation', {
            kind: challengeKind,
            status: 'waiting',
            startedAt: startedAt.toISOString(),
            deadlineAt,
            message: '页面正在跳转或验证中，继续等待。'
          });
          console.log('页面正在跳转或验证中，继续等待。');
          loggedNavigationWait = true;
        }
        continue;
      }
      throw error;
    }
    if (!pageLooksLoggedOut(current) && !pageNeedsHumanVerification(current)) {
      emitMonitorEvent('auth_wait_resolved', {
        kind: challengeKind,
        status: 'resolved',
        startedAt: startedAt.toISOString(),
        deadlineAt,
        message: '人工登录/验证已完成，继续采集。'
      });
      console.log('人工登录/验证已完成，继续采集。');
      return current;
    }
  }

  emitMonitorEvent('auth_wait_timeout', {
    kind: challengeKind,
    status: 'timeout',
    startedAt: startedAt.toISOString(),
    deadlineAt,
    message: `等待人工登录/验证码超时: ${options.authWaitSeconds} 秒。`
  });
  throw new Error(`等待人工登录/验证码超时: ${options.authWaitSeconds} 秒。`);
}

function shouldUseBrowserRuntime(options) {
  return Boolean(
    options.api ||
    options.browserApp ||
    options.cdpUrl ||
    options.cookieFile ||
    options.runtime !== 'auto' ||
    process.env.DOUYIN_RUNTIME ||
    process.env.DOUYIN_CDP_URL ||
    process.env.DOUYIN_BROWSER_APP ||
    process.env.DOUYIN_COOKIE_FILE
  );
}

function formatCookieAuthLog(summary) {
  if (!summary?.configured) return '';
  const skipped = summary.skippedReasons?.length
    ? `；跳过原因: ${summary.skippedReasons.map((item) => `${item.reason}=${item.count}`).join(', ')}`
    : '';
  return `Cookie 登录态: 已导入 ${summary.acceptedCount}/${summary.cookieCount}，跳过 ${summary.skippedCount}${skipped}`;
}

async function prepareBrowserRuntime(options) {
  const runtimeConfig = resolveBrowserRuntimeConfig(options);
  options.runtime = runtimeConfig.runtime;
  options.requestedRuntime = runtimeConfig.requestedRuntime;
  options.runtimeLabel = runtimeConfig.runtimeLabel;
  options.browserApp = runtimeConfig.browserApp;
  options.cdpUrl = runtimeConfig.cdpUrl;
  options.profile = runtimeConfig.profile || options.profile;
  options.cookieFile = runtimeConfig.cookieFile || '';
  options.browserRuntime = await createBrowserRuntime(options);

  console.log(`Runtime: ${options.runtimeLabel} (${options.runtime})`);
  const openResult = await options.browserRuntime.openOrFocusTarget(options.target);
  options.cookieAuth = options.browserRuntime.cookieAuthSummary || null;
  const cookieLog = formatCookieAuthLog(options.cookieAuth);
  if (cookieLog) console.log(cookieLog);
  if (openResult === 'found') console.log('已找到可用的抖音页面。');
  else if (openResult === 'opened') console.log('已打开抖音个人页。');

  const pageInfo = await options.browserRuntime.readPageInfo();
  await waitForManualAuthIfNeeded(options, pageInfo);
}

async function notifyCompletion(options, followers, change, status = 'completed') {
  const payload = buildNotificationPayload({ options, followers, change, status });
  try {
    const result = await sendNotification(payload, { notify: options.notify });
    if (result.skipped && result.reason !== 'disabled') console.warn(`通知已跳过: ${result.reason}`);
    else if (!result.skipped) console.log(`通知已发送: ${result.channel}`);
  } catch (error) {
    console.warn(`通知发送失败: ${error.message}`);
  }
}

async function readPageProfileStats(page) {
  let lastStats = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const stats = await page.evaluate(extractProfileStatsInPage);
    lastStats = stats;
    if (!profileStatsEmpty(stats)) return stats;
    await page.waitForTimeout(500);
  }
  return lastStats;
}

function ensureRunMeta(options) {
  if (options.runStartedAt && options.runStamp) return;
  options.runStartedAt = new Date().toISOString();
  options.runStamp = nowStamp(new Date(options.runStartedAt));
  options.currentFollowers = [];
}

function installSignalCheckpointHandler(options) {
  let exiting = false;
  const saveAndExit = (signal) => {
    if (exiting) process.exit(signal === 'SIGINT' ? 130 : 143);
    exiting = true;
    const followers = options.currentFollowers || [];
    if (options.monitorDb && options.runId) {
      try {
        finishScanRun(options.monitorDb, options, {
          status: 'interrupted',
          enumerableCount: followers.length,
          pagesFetched: options.pagesFetched || 0
        });
      } catch (error) {
        console.error(`收到 ${signal}，但更新数据库运行状态失败: ${error.message}`);
      }
    }
    persistProgress(options, followers, { status: `interrupted:${signal}`, force: true })
      .then(() => {
        console.error(`收到 ${signal}，已保存中断进度: ${path.join(options.outDir, 'in-progress', 'latest.partial.json')}`);
      })
      .catch((error) => {
        console.error(`收到 ${signal}，但保存中断进度失败: ${error.message}`);
      })
      .finally(() => {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
  };

  process.once('SIGINT', () => saveAndExit('SIGINT'));
  process.once('SIGTERM', () => saveAndExit('SIGTERM'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  ensureRunMeta(options);
  installSignalCheckpointHandler(options);

  if (shouldUseBrowserRuntime(options)) {
    let followers;
    let db = null;
    try {
      await prepareBrowserRuntime(options);
      options.profileStats = await readBrowserProfileStats(options).catch((error) => {
        console.warn(`读取主页计数失败: ${error.message}`);
        return null;
      });

      if (options.api) {
        db = await openMonitorDatabase(options.db);
        options.monitorDb = db;
        await seedDatabaseFromLatestSnapshot(db, options);
        const decision = decideEffectiveScanMode(db, options, options.profileStats);
        options.effectiveMode = decision.mode;
        options.modeReason = decision.reason;
        options.knownActiveIds = getActiveFollowerIds(db);
        startScanRun(db, options);
        console.log(`扫描模式: ${options.effectiveMode} (${options.modeReason})`);

        const scannedFollowers = await collectFollowersFromBrowserApi(options);
        if (profileStatsEmpty(options.profileStats)) {
          options.profileStats = await readBrowserProfileStats(options).catch((error) => {
            console.warn(`读取主页计数失败: ${error.message}`);
            return null;
          });
        }

        const { exportFollowers, change } = applyScanToDatabase(db, options, scannedFollowers);
        finishScanRun(db, options, {
          status: 'completed',
          enumerableCount: exportFollowers.length,
          pagesFetched: options.pagesFetched || 0
        });
        options.monitorChange = change;
        followers = exportFollowers;
      } else {
        followers = await collectFollowersFromBrowserApp(options);
        if (profileStatsEmpty(options.profileStats)) {
          options.profileStats = await readBrowserProfileStats(options).catch((error) => {
            console.warn(`读取主页计数失败: ${error.message}`);
            return null;
          });
        }
      }
    } catch (error) {
      if (db && options.runId) {
        finishScanRun(db, options, {
          status: 'failed',
          enumerableCount: options.currentFollowers?.length || 0,
          pagesFetched: options.pagesFetched || 0
        });
      }
      await persistCollectorError(options, error).catch((persistError) => {
        console.error(`保存错误摘要失败: ${persistError.message}`);
      });
      await notifyCompletion(options, options.currentFollowers || [], {
        errorCode: classifyCollectorError(error),
        collectedAt: new Date().toISOString()
      }, 'failed');
      throw error;
    } finally {
      options.monitorDb = null;
      closeMonitorDatabase(db);
      await options.browserRuntime?.close().catch(() => {});
    }

    if (!followers.length) {
      console.warn('没有采集到粉丝。请确认当前浏览器活动标签页已打开抖音粉丝列表。');
    }

    await persistProgress(options, followers, { status: 'completed', force: true });
    const { snapshotPath, change } = await persistResult(options, followers);
    console.log(`快照已保存: ${snapshotPath}`);
    console.log(`当前采集数量: ${followers.length}`);
    printProfileCountWarning(options.profileStats, followers);
    printDiffSummary(change);
    await notifyCompletion(options, followers, change, 'completed');
    return;
  }

  const context = await launchBrowser(options);
  const page = context.pages()[0] || await context.newPage();

  try {
    await waitForInitialPage(page, options.target);

    if (await looksLoggedOut(page)) {
      await promptEnter('浏览器里看起来还未登录。请完成登录，并确认打开的是你的个人主页。');
    } else {
      await promptEnter('请确认浏览器里是你的抖音个人主页。若未登录，请先登录。');
    }

    options.profileStats = await readPageProfileStats(page).catch((error) => {
      console.warn(`读取主页计数失败: ${error.message}`);
      return null;
    });

    if (!options.manual) {
      const opened = await tryOpenFollowerList(page);
      if (!opened) {
        await promptEnter('没有自动打开粉丝列表。请在浏览器里手动点击“粉丝”，确认列表/弹窗已打开。');
      }
    } else {
      await promptEnter('请在浏览器里手动打开粉丝列表/弹窗。');
    }

    const followers = await collectFollowers(page, options);
    if (profileStatsEmpty(options.profileStats)) {
      options.profileStats = await readPageProfileStats(page).catch((error) => {
        console.warn(`读取主页计数失败: ${error.message}`);
        return null;
      });
    }
    if (!followers.length) {
      console.warn('没有采集到粉丝。请确认粉丝列表已经打开，并尝试使用 npm run collect:manual。');
    }

    await persistProgress(options, followers, { status: 'completed', force: true });
    const { snapshotPath, change } = await persistResult(options, followers);
    console.log(`快照已保存: ${snapshotPath}`);
    console.log(`当前采集数量: ${followers.length}`);
    printProfileCountWarning(options.profileStats, followers);
    printDiffSummary(change);
    await notifyCompletion(options, followers, change, 'completed');
  } finally {
    await context.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

export {
  applyScanToDatabase,
  closeMonitorDatabase,
  decideEffectiveScanMode,
  getExportFollowersFromDb,
  openMonitorDatabase,
  waitForManualAuthIfNeeded
};
