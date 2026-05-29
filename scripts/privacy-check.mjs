#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT_DIR = path.resolve(new URL('..', import.meta.url).pathname);

const CONTENT_ROOTS = [
  'README.md',
  'docs',
  'agent-skills',
  '.agents',
  '.claude',
  'web',
  '.github',
  'package.json',
  'scripts'
];

const CONTENT_SKIP_PATTERNS = [
  /\.png$/i,
  /\.gif$/i,
  /\.test\.mjs$/i
];

const KNOWN_REAL_UID = ['118', '229', '888'].join('');
const KNOWN_REAL_NICKNAME = ['Dead', 'Man'].join(' ');

const TRACKED_PATH_RULES = [
  { id: 'tracked-data-dir', pattern: /^data(?:\/|$)/, message: 'tracked runtime data directory' },
  { id: 'tracked-debug-dir', pattern: /^debug(?:\/|$)/, message: 'tracked debug bundle output' },
  { id: 'tracked-sqlite', pattern: /(?:^|\/)[^/]+\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i, message: 'tracked SQLite database file' },
  { id: 'tracked-csv', pattern: /(?:^|\/)[^/]+\.csv$/i, message: 'tracked CSV export' },
  { id: 'tracked-archive', pattern: /(?:^|\/)[^/]+\.(?:zip|tgz|tar\.gz)$/i, message: 'tracked runtime archive' },
  { id: 'tracked-partial', pattern: /(?:^|\/)[^/]*\.partial(?:\.|$)/i, message: 'tracked partial export' },
  { id: 'tracked-browser-profile', pattern: /(?:^|\/)(?:Default|Profile \d+|User Data|browser-profile|playwright-profile|chrome-profile|chromium-profile|firefox-profile|Cookies|Network\/Cookies)(?:\/|$)/i, message: 'tracked browser profile path' }
];

const CONTENT_RULES = [
  { id: 'real-douyin-secuid-prefix', pattern: /\bMS4w[A-Za-z0-9_-]{8,}\b/g, message: 'real-looking Douyin secUid token' },
  { id: 'explicit-secuid-value', pattern: /\bsecUid\b\s*[:=]\s*["']?(?!demo-|example-|synthetic-|placeholder)[A-Za-z0-9_-]{12,}/gi, message: 'explicit secUid value' },
  { id: 'known-real-uid', pattern: new RegExp(`\\b${KNOWN_REAL_UID}\\b`, 'g'), message: 'known real Douyin uid' },
  { id: 'known-real-nickname', pattern: new RegExp(`\\b${KNOWN_REAL_NICKNAME}\\b`, 'g'), message: 'known real account nickname' },
  { id: 'long-session-value', pattern: /\b(?:sessionid|sid_guard|passport_csrf_token|odin_tt|ttwid|s_v_web_id)\b\s*[:=]\s*["']?[A-Za-z0-9%._~+/=-]{24,}/gi, message: 'session-like cookie value' },
  { id: 'cookie-header', pattern: /\bCookie:\s*[^;\n=]+=[^;\n]{12,}/gi, message: 'raw cookie header' },
  { id: 'browser-profile-content-path', pattern: /(?:\/Users\/[^/\s]+\/Library\/Application Support\/(?:Google\/Chrome|Chromium)|\/home\/[^/\s]+\/\.config\/(?:google-chrome|chromium)|[A-Z]:\\Users\\[^\\\s]+\\AppData\\Local\\(?:Google\\Chrome|Chromium)|--user-data-dir=(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s]+)/gi, message: 'local browser profile path' }
];

const DEMO_ALLOWED_ID = /^(?:demo-|synthetic-|example-|placeholder|mock-)/i;

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

async function gitTrackedFiles(rootDir = ROOT_DIR) {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
    cwd: rootDir,
    maxBuffer: 10 * 1024 * 1024
  });
  return stdout.split('\0').filter(Boolean).map(normalizePath);
}

function pathIsUnder(filePath, root) {
  return filePath === root || filePath.startsWith(`${root}/`);
}

function shouldScanContent(filePath, contentRoots = CONTENT_ROOTS) {
  if (!contentRoots.some((root) => pathIsUnder(filePath, root))) return false;
  return !CONTENT_SKIP_PATTERNS.some((pattern) => pattern.test(filePath));
}

function checkTrackedPaths(files) {
  const findings = [];
  for (const file of files.map(normalizePath)) {
    for (const rule of TRACKED_PATH_RULES) {
      if (rule.pattern.test(file)) {
        findings.push({ file, rule: rule.id, message: rule.message });
      }
    }
  }
  return findings;
}

function findContentFindings(file, content) {
  const findings = [];
  for (const rule of CONTENT_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of content.matchAll(rule.pattern)) {
      findings.push({
        file,
        rule: rule.id,
        message: rule.message,
        line: lineNumberAt(content, match.index || 0),
        excerpt: compactExcerpt(match[0])
      });
    }
  }
  return findings;
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

function compactExcerpt(value) {
  return String(value).replace(/\s+/g, ' ').slice(0, 96);
}

function validateDemoMockData(content, file = 'web/demo/mock-data.json') {
  const findings = [];
  const parsed = JSON.parse(content);
  const text = JSON.stringify(parsed);
  const urlMatches = text.matchAll(/https:\/\/www\.douyin\.com\/user\/([^"\\\s]+)/g);
  for (const match of urlMatches) {
    const id = decodeURIComponent(match[1]);
    if (!DEMO_ALLOWED_ID.test(id)) {
      findings.push({
        file,
        rule: 'demo-real-profile-url',
        message: 'demo mock data contains a real-looking Douyin profile URL',
        line: lineNumberAt(content, match.index || 0),
        excerpt: compactExcerpt(match[0])
      });
    }
  }
  return findings;
}

async function scanSensitiveContent({ rootDir = ROOT_DIR, files, contentRoots = CONTENT_ROOTS } = {}) {
  const tracked = files || await gitTrackedFiles(rootDir);
  const findings = [];
  for (const file of tracked.filter((item) => shouldScanContent(item, contentRoots))) {
    const absolutePath = path.join(rootDir, file);
    let content;
    try {
      content = await readFile(absolutePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    findings.push(...findContentFindings(file, content));
    if (file === 'web/demo/mock-data.json') {
      findings.push(...validateDemoMockData(content, file));
    }
  }
  return findings;
}

async function runPrivacyCheck({ rootDir = ROOT_DIR } = {}) {
  const files = await gitTrackedFiles(rootDir);
  const findings = [
    ...checkTrackedPaths(files),
    ...await scanSensitiveContent({ rootDir, files })
  ];
  return { ok: findings.length === 0, findings };
}

function printFindings(findings) {
  for (const finding of findings) {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    const excerpt = finding.excerpt ? ` (${finding.excerpt})` : '';
    console.error(`- ${location}: ${finding.message} [${finding.rule}]${excerpt}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runPrivacyCheck();
  if (!result.ok) {
    console.error(`Privacy check failed with ${result.findings.length} finding(s):`);
    printFindings(result.findings);
    process.exitCode = 1;
  } else {
    console.log('privacy check passed');
  }
}

export {
  checkTrackedPaths,
  findContentFindings,
  runPrivacyCheck,
  scanSensitiveContent,
  validateDemoMockData
};
