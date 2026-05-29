#!/usr/bin/env node

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildRuntimeHealth } from './dashboard-runtime-health.mjs';
import { runDoctor } from './doctor.mjs';

const ROOT_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const DEFAULT_OUT_ROOT = path.join(ROOT_DIR, 'debug');
const DEFAULT_DB = path.join(ROOT_DIR, 'data', 'followers.db');
const DEFAULT_ERROR_LOG = path.join(ROOT_DIR, 'data', 'latest-error.json');

const SENSITIVE_KEY_RE = /"?(?:cookie|cookies|sessionid|sid_guard|passport_csrf_token|odin_tt|ttwid|s_v_web_id|followerId|id|uid|secUid|nickname|profileUrl)"?\s*[:=]\s*"[^"\n]*"/gi;
const DOUYIN_USER_URL_RE = /https:\/\/www\.douyin\.com\/user\/[A-Za-z0-9._~%-]+/gi;
const SECUID_RE = /\bMS4w[A-Za-z0-9_-]{8,}\b/g;
const LONG_TOKEN_RE = /\b[A-Za-z0-9._~+/=-]{32,}\b/g;
const POSIX_PATH_RE = /(?:\/Users\/|\/home\/|\/var\/folders\/|\/tmp\/)[^\s"']+/g;
const WINDOWS_PATH_RE = /[A-Z]:\\Users\\[^\s"']+/g;
const COOKIE_NAME_RE = /\b(?:sessionid|sid_guard|passport_csrf_token|odin_tt|ttwid|s_v_web_id)\b/gi;
const SENSITIVE_JSON_KEYS = new Set([
  'cookie',
  'cookies',
  'sessionid',
  'sid_guard',
  'passport_csrf_token',
  'odin_tt',
  'ttwid',
  's_v_web_id',
  'followerId',
  'uid',
  'secUid',
  'nickname',
  'profileUrl'
]);
const SENSITIVE_COLUMN_RE = /^(?:id|uid|secUid|nickname|profileUrl|followerId)$/i;

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function relativeFromRoot(filePath, rootDir = ROOT_DIR) {
  const relative = path.relative(rootDir, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '[outside-project]';
  return relative.split(path.sep).join('/');
}

function sanitizeText(input) {
  return String(input || '')
    .replace(SENSITIVE_KEY_RE, '[redacted-field]')
    .replace(DOUYIN_USER_URL_RE, 'https://www.douyin.com/user/[redacted]')
    .replace(SECUID_RE, '[redacted-douyin-token]')
    .replace(COOKIE_NAME_RE, '[cookie-name]')
    .replace(LONG_TOKEN_RE, '[redacted-token]')
    .replace(POSIX_PATH_RE, '[path]')
    .replace(WINDOWS_PATH_RE, '[path]');
}

function sanitizeJson(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !SENSITIVE_JSON_KEYS.has(key))
      .map(([key, item]) => [key, sanitizeJson(item)]));
  }
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

function safeColumnName(name) {
  return SENSITIVE_COLUMN_RE.test(name) ? '[redacted-sensitive-column]' : name;
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function packageInfo(rootDir = ROOT_DIR) {
  const pkg = await readJsonFile(path.join(rootDir, 'package.json'));
  return {
    name: pkg.name || '',
    version: pkg.version || '',
    private: Boolean(pkg.private),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    dependencies: Object.keys(pkg.dependencies || {}).sort(),
    devDependencies: Object.keys(pkg.devDependencies || {}).sort(),
    scripts: Object.keys(pkg.scripts || {}).sort()
  };
}

async function doctorReport(rootDir = ROOT_DIR) {
  try {
    return sanitizeJson(await runDoctor({
      runtime: process.env.DOUYIN_RUNTIME || 'auto',
      cdpUrl: process.env.DOUYIN_CDP_URL || '',
      browserApp: process.env.DOUYIN_BROWSER_APP || '',
      profile: process.env.DOUYIN_PROFILE || path.join(rootDir, '.douyin-browser'),
      outDir: path.join(rootDir, 'data'),
      cookieFile: process.env.DOUYIN_COOKIE_FILE || path.join(rootDir, 'data', 'auth', 'douyin-cookies.json')
    }));
  } catch (error) {
    return {
      generatedAt: new Date().toISOString(),
      level: 'action',
      error: sanitizeText(error.message || error)
    };
  }
}

async function schemaSummary(dbPath = DEFAULT_DB, rootDir = ROOT_DIR) {
  try {
    await stat(dbPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        database: relativeFromRoot(dbPath, rootDir),
        exists: false,
        tables: []
      };
    }
    throw error;
  }

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON;');
    const tables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all();

    return {
      database: relativeFromRoot(dbPath, rootDir),
      exists: true,
      tables: tables.map((table) => ({
        name: table.name,
        columns: db.prepare(`PRAGMA table_info(${JSON.stringify(table.name)})`).all().map((column) => ({
          name: safeColumnName(column.name),
          type: column.type || '',
          notNull: Boolean(column.notnull),
          primaryKey: Boolean(column.pk)
        }))
      }))
    };
  } finally {
    db.close();
  }
}

function safeRuntimeHealth() {
  const health = buildRuntimeHealth({
    scanStatus: {
      runtime: process.env.DOUYIN_CDP_URL ? 'cdp' : 'playwright',
      runtimeLabel: process.env.DOUYIN_CDP_URL ? 'CDP configured' : 'Playwright fallback',
      phase: 'idle',
      authChallenge: null
    },
    cookieAuth: {
      configured: false,
      cookieCount: 0,
      acceptedCount: 0,
      skippedCount: 0,
      runtimeSupported: true
    }
  });
  return sanitizeJson(health);
}

async function latestErrorText(errorLogPath = DEFAULT_ERROR_LOG) {
  try {
    return sanitizeText(await readFile(errorLogPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return 'No latest-error.json found.\n';
    return sanitizeText(`Could not read latest-error summary: ${error.message}\n`);
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function createZipArchive(sourceDir, now = new Date()) {
  const archivePath = `${sourceDir}.zip`;
  const entries = [];
  const localParts = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime(now);

  for (const entry of (await readdir(sourceDir)).sort()) {
    const filePath = path.join(sourceDir, entry);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) continue;

    const name = Buffer.from(`${path.basename(sourceDir)}/${entry}`);
    const data = await readFile(filePath);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, name, data);
    entries.push({ name, crc, size: data.length, offset });
    offset += local.length + name.length + data.length;
  }

  const centralParts = [];
  let centralSize = 0;
  for (const entry of entries) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.size, 20);
    central.writeUInt32LE(entry.size, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(entry.offset, 42);
    centralParts.push(central, entry.name);
    centralSize += central.length + entry.name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await writeFile(archivePath, Buffer.concat([...localParts, ...centralParts, end]));
  return archivePath;
}

async function generateDebugBundle({
  rootDir = ROOT_DIR,
  outRoot = DEFAULT_OUT_ROOT,
  dbPath = DEFAULT_DB,
  errorLogPath = DEFAULT_ERROR_LOG,
  now = new Date()
} = {}) {
  const bundleDir = path.join(outRoot, `douyin-monitor-debug-${timestampSlug(now)}`);
  await mkdir(bundleDir, { recursive: true });

  await writeJson(path.join(bundleDir, 'package-info.json'), await packageInfo(rootDir));
  await writeJson(path.join(bundleDir, 'runtime-health.json'), safeRuntimeHealth());
  await writeJson(path.join(bundleDir, 'doctor.json'), await doctorReport(rootDir));
  await writeJson(path.join(bundleDir, 'schema.json'), await schemaSummary(dbPath, rootDir));
  await writeFile(path.join(bundleDir, 'latest-error.log'), await latestErrorText(errorLogPath));
  await writeFile(path.join(bundleDir, 'README.txt'), [
    'Douyin Follower Monitor debug bundle',
    '',
    'This bundle intentionally excludes follower rows, account names, profile links, cookie details, and absolute local paths.',
    'Share the directory or archive only after reviewing the files.',
    ''
  ].join('\n'));

  let archivePath = null;
  try {
    archivePath = await createZipArchive(bundleDir, now);
  } catch (error) {
    await writeFile(path.join(bundleDir, 'archive-warning.txt'), sanitizeText(`Archive creation failed: ${error.message}\n`));
  }

  return { bundleDir, archivePath };
}

async function readBundleText(bundleDir) {
  const entries = await readdir(bundleDir);
  const chunks = [];
  for (const entry of entries) {
    const filePath = path.join(bundleDir, entry);
    const fileStat = await stat(filePath);
    if (fileStat.isFile()) chunks.push(await readFile(filePath, 'utf8'));
  }
  return chunks.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await generateDebugBundle();
  console.log(`Debug bundle directory: ${result.bundleDir}`);
  if (result.archivePath) {
    console.log(`Debug bundle archive: ${result.archivePath}`);
  } else {
    console.log('Debug bundle archive: not created; see archive-warning.txt in the bundle directory.');
  }
}

export {
  createZipArchive,
  generateDebugBundle,
  latestErrorText,
  readBundleText,
  sanitizeText,
  schemaSummary
};
