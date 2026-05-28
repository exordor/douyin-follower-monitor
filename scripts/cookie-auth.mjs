import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const COOKIE_FORMAT = 'local-cookie-manager-v1';
const DEFAULT_AUTH_DIR_NAME = 'auth';
const DEFAULT_COOKIE_FILE_NAME = 'douyin-cookies.json';
const DOUYIN_DOMAIN = 'douyin.com';

function normalizeCookieDomain(domain) {
  return String(domain || '').trim().replace(/^\./, '').toLowerCase();
}

function normalizePath(value) {
  const cookiePath = String(value || '/');
  return cookiePath.startsWith('/') ? cookiePath : `/${cookiePath}`;
}

function isDouyinDomain(domain) {
  const normalized = normalizeCookieDomain(domain);
  return normalized === DOUYIN_DOMAIN || normalized.endsWith(`.${DOUYIN_DOMAIN}`);
}

function hostFromUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function cookieAppliesToHost(cookie, host) {
  const normalizedHost = String(host || 'www.douyin.com').toLowerCase();
  const normalizedDomain = normalizeCookieDomain(cookie.domain);
  if (cookie.hostOnly) return normalizedDomain === normalizedHost;
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function sameSiteForPlaywright(value) {
  if (value === 'lax') return 'Lax';
  if (value === 'strict') return 'Strict';
  if (value === 'no_restriction') return 'None';
  if (value === 'unspecified' || value == null || value === '') return undefined;
  return null;
}

function validateLosslessExport(value) {
  if (!value || typeof value !== 'object') throw new Error('Cookie 文件必须是 JSON object。');
  if (value.format !== COOKIE_FORMAT) throw new Error(`只支持 cookie-manager ${COOKIE_FORMAT} 无损 JSON。`);
  if (value.redacted) throw new Error('Redacted cookie 导出不包含真实值，不能导入。');
  if (!Array.isArray(value.cookies)) throw new Error('Cookie 文件缺少 cookies 数组。');
  return value;
}

function skip(skipped, reason, count = 1) {
  skipped[reason] = (skipped[reason] || 0) + count;
}

function toPlaywrightCookie(cookie, nowSeconds, skipped, targetHost = 'www.douyin.com') {
  if (!cookie || typeof cookie !== 'object') {
    skip(skipped, 'invalid-cookie');
    return null;
  }
  if (!cookie.name || typeof cookie.name !== 'string') {
    skip(skipped, 'invalid-name');
    return null;
  }
  if (typeof cookie.value !== 'string') {
    skip(skipped, 'invalid-value');
    return null;
  }
  if (!cookie.domain || /\s/.test(String(cookie.domain))) {
    skip(skipped, 'invalid-domain');
    return null;
  }
  if (!isDouyinDomain(cookie.domain)) {
    skip(skipped, 'non-douyin-domain');
    return null;
  }
  if (!cookieAppliesToHost(cookie, targetHost)) {
    skip(skipped, 'non-target-douyin-subdomain');
    return null;
  }
  if (!cookie.path || !String(cookie.path).startsWith('/')) {
    skip(skipped, 'invalid-path');
    return null;
  }
  if (cookie.partitionKey) {
    skip(skipped, 'partition-key-unsupported');
    return null;
  }
  if (!cookie.session) {
    if (typeof cookie.expirationDate !== 'number' || !Number.isFinite(cookie.expirationDate)) {
      skip(skipped, 'invalid-expiration');
      return null;
    }
    if (cookie.expirationDate <= nowSeconds) {
      skip(skipped, 'expired');
      return null;
    }
  }

  const sameSite = sameSiteForPlaywright(cookie.sameSite);
  if (sameSite === null) {
    skip(skipped, 'invalid-same-site');
    return null;
  }

  const normalizedDomain = normalizeCookieDomain(cookie.domain);
  const output = {
    name: cookie.name,
    value: cookie.value,
    path: normalizePath(cookie.path),
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure)
  };

  if (sameSite) output.sameSite = sameSite;
  if (!cookie.session) output.expires = cookie.expirationDate;

  if (cookie.hostOnly) {
    const protocol = output.secure ? 'https' : 'http';
    output.url = `${protocol}://${normalizedDomain}${output.path}`;
  } else {
    output.domain = String(cookie.domain).trim().startsWith('.') ? String(cookie.domain).trim() : `.${normalizedDomain}`;
  }

  return output;
}

function summarizeSkipped(skipped) {
  return Object.entries(skipped)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => ({ reason, count }));
}

function parseCookieAuthContent(content, { now = new Date(), targetHost = '' } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Cookie 文件不是有效 JSON。');
  }
  const exportFile = validateLosslessExport(parsed);
  const effectiveTargetHost =
    targetHost ||
    hostFromUrl(exportFile.sourceUrl) ||
    hostFromUrl(exportFile.scope?.url) ||
    hostFromUrl(exportFile.scope?.origin) ||
    'www.douyin.com';
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const skipped = {};
  const cookies = [];

  for (const cookie of exportFile.cookies) {
    const playwrightCookie = toPlaywrightCookie(cookie, nowSeconds, skipped, effectiveTargetHost);
    if (playwrightCookie) cookies.push(playwrightCookie);
  }

  return {
    configured: true,
    exportedAt: exportFile.exportedAt || null,
    sourceUrl: exportFile.sourceUrl || '',
    cookieCount: exportFile.cookieCount ?? exportFile.cookies.length,
    acceptedCount: cookies.length,
    skippedCount: exportFile.cookies.length - cookies.length,
    skippedReasons: summarizeSkipped(skipped),
    cookies
  };
}

async function loadCookieAuthFile(cookieFile, options = {}) {
  const content = await readFile(cookieFile, 'utf8');
  const parsed = parseCookieAuthContent(content, options);
  parsed.file = cookieFile;
  return parsed;
}

async function applyCookieAuthToContext(context, cookieFile) {
  if (!cookieFile) {
    return {
      configured: false,
      file: '',
      exportedAt: null,
      sourceUrl: '',
      cookieCount: 0,
      acceptedCount: 0,
      skippedCount: 0,
      skippedReasons: []
    };
  }

  const parsed = await loadCookieAuthFile(cookieFile);
  if (parsed.acceptedCount > 0) await context.addCookies(parsed.cookies);
  return publicCookieAuthSummary(parsed);
}

function publicCookieAuthSummary(summary = {}) {
  return {
    configured: Boolean(summary.configured),
    exportedAt: summary.exportedAt || null,
    sourceUrl: summary.sourceUrl || '',
    cookieCount: Number(summary.cookieCount || 0),
    acceptedCount: Number(summary.acceptedCount || 0),
    skippedCount: Number(summary.skippedCount || 0),
    skippedReasons: Array.isArray(summary.skippedReasons) ? summary.skippedReasons : [],
    updatedAt: summary.updatedAt || null
  };
}

function apiCookieAuthSummary(summary = {}, runtimeSupported = false) {
  const { skippedReasons, ...publicSummary } = publicCookieAuthSummary(summary);
  return {
    ...publicSummary,
    runtimeSupported
  };
}

function defaultCookieFile(outDir) {
  return path.join(outDir, DEFAULT_AUTH_DIR_NAME, DEFAULT_COOKIE_FILE_NAME);
}

async function getCookieAuthStatus({ cookieFile, runtime = 'auto' }) {
  const runtimeSupported = runtime === 'playwright' || runtime === 'cdp' || runtime === 'auto';
  try {
    const fileStat = await stat(cookieFile);
    const parsed = await loadCookieAuthFile(cookieFile);
      return apiCookieAuthSummary({
          ...parsed,
          updatedAt: fileStat.mtime.toISOString()
        }, runtimeSupported);
    } catch (error) {
    if (error.code !== 'ENOENT') {
      return {
        ...apiCookieAuthSummary({ configured: true, file: cookieFile }, runtimeSupported),
        runtimeSupported,
        error: error.message
      };
    }
    return apiCookieAuthSummary({ configured: false, file: cookieFile }, runtimeSupported);
  }
}

async function saveCookieAuthFile({ cookieFile, content }) {
  const parsed = parseCookieAuthContent(content);
  await mkdir(path.dirname(cookieFile), { recursive: true });
  await writeFile(cookieFile, `${JSON.stringify(JSON.parse(content), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  await chmod(cookieFile, 0o600).catch(() => {});
  const fileStat = await stat(cookieFile);
  return apiCookieAuthSummary({
      ...parsed,
      file: cookieFile,
      updatedAt: fileStat.mtime.toISOString()
    }, true);
}

async function removeCookieAuthFile(cookieFile) {
  await rm(cookieFile, { force: true });
  return apiCookieAuthSummary({ configured: false, file: cookieFile }, true);
}

export {
  DEFAULT_AUTH_DIR_NAME,
  DEFAULT_COOKIE_FILE_NAME,
  applyCookieAuthToContext,
  defaultCookieFile,
  getCookieAuthStatus,
  loadCookieAuthFile,
  parseCookieAuthContent,
  publicCookieAuthSummary,
  removeCookieAuthFile,
  saveCookieAuthFile
};
