#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT_DIR = path.resolve(new URL('..', import.meta.url).pathname);
const PUBLIC_DIR = path.join(ROOT_DIR, 'web', 'public');
const DIAGRAM_DIR = path.join(ROOT_DIR, 'docs', 'diagrams');
const DRAWIO = '/Applications/draw.io.app/Contents/MacOS/draw.io';

function assetCss() {
  return `
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #161a22;
      background: #f4f7fa;
    }
    .stage {
      width: 100vw;
      height: 100vh;
      padding: 54px;
      background:
        linear-gradient(135deg, rgba(20,184,166,.13), rgba(244,247,250,0) 38%),
        linear-gradient(315deg, rgba(244,63,94,.10), rgba(244,247,250,0) 42%),
        #f4f7fa;
    }
    .shell {
      display: grid;
      grid-template-columns: 250px 1fr;
      width: 100%;
      height: 100%;
      overflow: hidden;
      border: 1px solid #dde6ef;
      border-radius: 18px;
      background: #fff;
      box-shadow: 0 28px 90px rgba(20, 26, 36, .18);
    }
    .side {
      padding: 26px;
      color: #fff;
      background: #17191f;
    }
    .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 36px; }
    .logo {
      display: grid; place-items: center;
      width: 46px; height: 46px; border-radius: 12px;
      color: #101318; font-weight: 900;
      background: linear-gradient(135deg, #5eead4, #fb7185);
    }
    .brand strong { display: block; font-size: 16px; }
    .brand span { display: block; margin-top: 3px; color: #a8b0bd; font-size: 12px; }
    .nav { display: grid; gap: 10px; }
    .nav div { height: 42px; display: flex; align-items: center; padding: 0 14px; border-radius: 9px; color: #c9d1dc; background: rgba(255,255,255,.06); }
    .main { padding: 34px; overflow: hidden; }
    h1 { margin: 0; font-size: 48px; line-height: 1.02; letter-spacing: 0; }
    .sub { margin: 12px 0 24px; color: #687486; font-size: 18px; }
    .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 18px; }
    .metric { padding: 18px; min-height: 126px; border: 1px solid #e3e9f0; border-radius: 12px; background: #fff; }
    .metric span { color: #687486; font-size: 14px; }
    .metric strong { display: block; margin-top: 9px; font-size: 36px; line-height: 1; }
    .metric small { display: block; margin-top: 12px; color: #8390a0; font-size: 12px; }
    .grid { display: grid; grid-template-columns: 1.7fr .9fr; gap: 16px; }
    .panel { padding: 18px; border: 1px solid #e3e9f0; border-radius: 12px; background: #fff; }
    .panel h2 { margin: 0 0 4px; font-size: 18px; }
    .panel p { margin: 0 0 14px; color: #687486; font-size: 13px; }
    .chart { height: 245px; border-radius: 12px; background:
      linear-gradient(#edf2f6 1px, transparent 1px) 0 0 / 100% 25%,
      linear-gradient(90deg, #edf2f6 1px, transparent 1px) 0 0 / 16.6% 100%;
      position: relative;
      overflow: hidden;
    }
    .chart svg { position: absolute; inset: 0; width: 100%; height: 100%; }
    .table { display: grid; gap: 10px; margin-top: 16px; }
    .row { display: grid; grid-template-columns: 90px 1fr 80px; align-items: center; gap: 10px; padding: 11px 12px; border-radius: 9px; background: #f8fafc; font-size: 13px; }
    .pill { display: inline-flex; justify-content: center; padding: 4px 8px; border-radius: 999px; font-weight: 700; font-size: 12px; }
    .teal { color: #0f766e; background: #ccfbf1; }
    .rose { color: #be123c; background: #ffe4e6; }
    .amber { color: #92400e; background: #fef3c7; }
    .green { color: #166534; background: #dcfce7; }
    .notice { display: inline-flex; align-items: center; margin-top: 18px; padding: 10px 12px; border-radius: 9px; color: #29544f; background: #effaf7; font-size: 13px; }
    .social { display: grid; grid-template-columns: 1.05fr .95fr; align-items: center; gap: 28px; height: 100%; }
    .social h1 { font-size: 58px; }
    .mini { padding: 20px; border-radius: 18px; background: #17191f; color: #f8fafc; box-shadow: 0 28px 80px rgba(20,26,36,.2); }
    .mini .bar { height: 12px; border-radius: 99px; margin: 14px 0; background: linear-gradient(90deg, #14b8a6 64%, #f43f5e 64%); }
    .terminal {
      width: 960px; height: 540px; padding: 26px;
      color: #d8fff8; background: #101318;
      font: 18px/1.55 "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
    }
    .terminal .top { display: flex; gap: 8px; margin-bottom: 24px; }
    .terminal .dot { width: 12px; height: 12px; border-radius: 50%; background: #f43f5e; }
    .terminal .dot:nth-child(2) { background: #d97706; }
    .terminal .dot:nth-child(3) { background: #14b8a6; }
    .terminal b { color: #5eead4; }
    .terminal em { color: #fb7185; font-style: normal; }
  `;
}

function readmeHeroHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${assetCss()}</style></head><body>
    <div class="stage">
      <div class="shell">
        <aside class="side">
          <div class="brand"><div class="logo">DF</div><div><strong>Douyin Monitor</strong><span>Local-first ledger</span></div></div>
          <div class="nav"><div>总览</div><div>事件</div><div>粉丝</div><div>扫描</div></div>
        </aside>
        <main class="main">
          <h1>发现谁取关了你</h1>
          <div class="sub">本地留存可枚举粉丝变化账本，不上传数据，不绕过隐私限制。</div>
          <div class="metrics">
            <div class="metric"><span>可枚举粉丝</span><strong>12,480</strong><small>主页显示 12,606</small></div>
            <div class="metric"><span>新增</span><strong>37</strong><small>最近一次变化</small></div>
            <div class="metric"><span>疑似取关</span><strong>8</strong><small>等待 full 确认</small></div>
            <div class="metric"><span>隐藏/不可用</span><strong>126</strong><small>隐私差值</small></div>
          </div>
          <div class="grid">
            <div class="panel"><h2>粉丝趋势</h2><p>主页粉丝数与可枚举列表同步展示</p><div class="chart">${trendSvg()}</div></div>
            <div class="panel"><h2>事件列表</h2><p>新增、改名、取关状态机</p><div class="table">
              <div class="row"><span class="pill teal">新增</span><strong>晨间剪辑师</strong><span>09:45</span></div>
              <div class="row"><span class="pill amber">疑似</span><strong>算法观察者</strong><span>09:46</span></div>
              <div class="row"><span class="pill rose">确认</span><strong>封面设计工坊</strong><span>09:46</span></div>
              <div class="row"><span class="pill green">回归</span><strong>留学影像册</strong><span>09:46</span></div>
            </div></div>
          </div>
          <div class="notice">数据仅来自本机 SQLite，只承认可枚举列表结果。</div>
        </main>
      </div>
    </div>
  </body></html>`;
}

function socialHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${assetCss()}</style></head><body>
    <div class="stage">
      <div class="social">
        <div>
          <div class="brand"><div class="logo">DF</div><div><strong>Douyin Follower Monitor</strong><span>local-first creator analytics</span></div></div>
          <h1>发现谁取关了你</h1>
          <div class="sub">本地 SQLite 账本 + recent/full 监控策略 + 可视化 Web 仪表盘</div>
          <div class="notice">不上传数据，不补全隐藏账号，不仿冒官方平台。</div>
        </div>
        <div class="mini">
          <div class="metrics" style="grid-template-columns: repeat(2, 1fr);">
            <div class="metric"><span>可枚举粉丝</span><strong>12,480</strong></div>
            <div class="metric"><span>疑似取关</span><strong>8</strong></div>
          </div>
          <div class="bar"></div>
          <div class="table">
            <div class="row"><span class="pill teal">new</span><strong>37 creators</strong><span>today</span></div>
            <div class="row"><span class="pill rose">removed</span><strong>2 confirmed</strong><span>full</span></div>
          </div>
        </div>
      </div>
    </div>
  </body></html>`;
}

function terminalHtml(lines) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${assetCss()}</style></head><body>
    <div class="terminal">
      <div class="top"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
      ${lines.map((line) => `<div>${line}</div>`).join('')}
    </div>
  </body></html>`;
}

function trendSvg() {
  return `<svg viewBox="0 0 720 245" preserveAspectRatio="none">
    <path d="M18 194 C140 170 194 154 280 142 C396 126 474 98 702 70" fill="none" stroke="#f43f5e" stroke-width="4"/>
    <path d="M18 204 C138 182 208 164 286 150 C404 134 478 108 702 82" fill="none" stroke="#14b8a6" stroke-width="6"/>
    <path d="M18 204 C138 182 208 164 286 150 C404 134 478 108 702 82 L702 245 L18 245 Z" fill="#14b8a6" opacity=".14"/>
  </svg>`;
}

async function screenshotHtml(browser, html, outputPath, viewport) {
  const page = await browser.newPage({ viewport });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.screenshot({ path: outputPath, type: 'png' });
  await page.close();
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

async function renderMarketingAssets() {
  await mkdir(PUBLIC_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    await screenshotHtml(browser, readmeHeroHtml(), path.join(PUBLIC_DIR, 'readme-hero.png'), { width: 1600, height: 900 });
    await screenshotHtml(browser, socialHtml(), path.join(PUBLIC_DIR, 'social-preview.png'), { width: 1280, height: 640 });
    await renderTerminalDemo(browser);
  } finally {
    await browser.close();
  }
}

async function renderTerminalDemo(browser) {
  const framesDir = await mkdtemp(path.join(os.tmpdir(), 'douyin-terminal-frames-'));
  try {
    const lines = [
      '<b>$</b> npm run doctor',
      'Doctor: <b>warning</b> · Node 24 OK · SQLite OK · Playwright OK',
      'Action: configure CDP or import cookie before first scan',
      '<b>$</b> npm run dashboard',
      'Setup: CDP recommended · Playwright + Cookie supported',
      'Runtime health: <b>Playwright profile</b> · cookie configured 66/89',
      '<b>$</b> npm run monitor',
      'phase: <em>waiting_for_verification</em> · manual captcha only',
      'API 第 1 页: 本页 20，累计 20，hasMore=true',
      'partial saved: data/in-progress/latest.partial.json',
      '完成: 新增 0 · 疑似 0 · 确认 0 · 隐藏差值 0',
      '<b>$</b> npm run privacy:check && npm run debug:bundle',
      'privacy passed · debug/douyin-monitor-debug-*.zip sanitized'
    ];
    for (let index = 0; index < lines.length; index += 1) {
      await screenshotHtml(
        browser,
        terminalHtml(lines.slice(0, index + 1)),
        path.join(framesDir, `frame-${String(index).padStart(3, '0')}.png`),
        { width: 960, height: 540 }
      );
    }
    const framePattern = path.join(framesDir, 'frame-%03d.png');
    const palettePath = path.join(framesDir, 'palette.png');
    await run('ffmpeg', [
      '-y',
      '-framerate',
      '2',
      '-i',
      framePattern,
      '-vf',
      'fps=8,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff',
      palettePath
    ]);
    await run('ffmpeg', [
      '-y',
      '-framerate',
      '2',
      '-i',
      framePattern,
      '-i',
      palettePath,
      '-lavfi',
      'fps=8,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5',
      '-loop',
      '0',
      path.join(PUBLIC_DIR, 'terminal-demo.gif')
    ]);
  } finally {
    await rm(framesDir, { recursive: true, force: true });
  }
}

function drawioXml(title, cells) {
  return `<mxfile host="app.diagrams.net" modified="2026-05-28T00:00:00.000Z" agent="Codex" version="24.0.0">
  <diagram name="${title}">
    <mxGraphModel dx="2200" dy="1300" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1800" pageHeight="1000" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        ${cells.join('\n        ')}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
}

function node(id, label, x, y, w, h, fill = '#ffffff') {
  return `<mxCell id="${id}" value="${label}" style="rounded=1;whiteSpace=wrap;html=1;fontSize=26;strokeColor=#334155;fillColor=${fill};arcSize=10;spacing=14;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry" /></mxCell>`;
}

function edge(id, source, target, extraStyle = '', points = []) {
  const waypointXml = points.length
    ? `<Array as="points">${points.map(([x, y]) => `<mxPoint x="${x}" y="${y}" />`).join('')}</Array>`
    : '';
  return `<mxCell id="${id}" value="" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;strokeColor=#334155;strokeWidth=3;fontSize=26;${extraStyle}" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry">${waypointXml}</mxGeometry></mxCell>`;
}

async function renderDiagrams() {
  await mkdir(DIAGRAM_DIR, { recursive: true });
  const workflow = drawioXml('scan-workflow', [
    node('w-title', 'Monitor 扫描决策流程', 620, 40, 520, 80, '#f8fafc'),
    node('w-start', '读取主页计数与 SQLite 基线', 80, 310, 420, 110, '#e0f2fe'),
    node('w-decision', '需要 full?', 580, 310, 300, 110, '#fef3c7'),
    node('w-recent', 'recent: 扫最近 N 页', 960, 150, 400, 100, '#ccfbf1'),
    node('w-recent-db', 'upsert 新增 / 改名 / lastSeenAt', 1400, 150, 440, 100, '#f8fafc'),
    node('w-full', 'full: 扫完整分页', 960, 430, 400, 100, '#fee2e2'),
    node('w-full-db', '推进取关状态机', 1400, 430, 440, 100, '#f8fafc'),
    node('w-export', '导出 latest.json / csv / change', 960, 700, 880, 110, '#dcfce7'),
    edge('we-1', 'w-start', 'w-decision', 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;'),
    edge('we-2', 'w-decision', 'w-recent', 'exitX=1;exitY=0.25;entryX=0;entryY=0.5;', [[920, 338], [920, 200]]),
    edge('we-3', 'w-decision', 'w-full', 'exitX=1;exitY=0.75;entryX=0;entryY=0.5;', [[920, 392], [920, 480]]),
    edge('we-4', 'w-recent', 'w-recent-db', 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;'),
    edge('we-5', 'w-full', 'w-full-db', 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;'),
    edge('we-6', 'w-recent-db', 'w-export', 'exitX=1;exitY=0.5;entryX=0.8;entryY=0;', [[1900, 200], [1900, 650], [1664, 650]]),
    edge('we-7', 'w-full-db', 'w-export', 'exitX=0.5;exitY=1;entryX=0.55;entryY=0;', [[1620, 650]])
  ]);
  const state = drawioXml('removal-state-machine', [
    node('s-title', '取关判断状态机', 610, 50, 430, 80, '#f8fafc'),
    node('s-active', 'active&#xa;扫描中出现', 80, 290, 330, 130, '#ccfbf1'),
    node('s-suspected', 'suspected_removed&#xa;第一次 full 缺失', 610, 290, 390, 130, '#fef3c7'),
    node('s-removed', 'removed&#xa;第二次 full 缺失', 1210, 290, 330, 130, '#ffe4e6'),
    node('s-reappear', 'reappeared 事件&#xa;重新恢复 active', 610, 580, 390, 130, '#dcfce7'),
    edge('se-1', 's-active', 's-suspected', 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;'),
    edge('se-2', 's-suspected', 's-removed', 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;'),
    edge('se-3', 's-suspected', 's-reappear', 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;'),
    edge('se-4', 's-removed', 's-reappear', 'exitX=0.5;exitY=1;entryX=1;entryY=0.5;', [[1375, 645]]),
    edge('se-5', 's-reappear', 's-active', 'exitX=0;exitY=0.5;entryX=0.5;entryY=1;', [[245, 645]])
  ]);
  const workflowPath = path.join(DIAGRAM_DIR, 'scan-workflow.drawio');
  const statePath = path.join(DIAGRAM_DIR, 'removal-state-machine.drawio');
  await writeFile(workflowPath, workflow, 'utf8');
  await writeFile(statePath, state, 'utf8');

  if (existsSync(DRAWIO)) {
    await run(DRAWIO, ['--export', '--format', 'png', '--scale', '2', '--border', '24', '--output', path.join(DIAGRAM_DIR, 'scan-workflow.png'), workflowPath]);
    await run(DRAWIO, ['--export', '--format', 'png', '--scale', '2', '--border', '24', '--output', path.join(DIAGRAM_DIR, 'removal-state-machine.png'), statePath]);
  }
}

if (process.argv.includes('--terminal-only')) {
  await mkdir(PUBLIC_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    await renderTerminalDemo(browser);
  } finally {
    await browser.close();
  }
  console.log('terminal demo rendered');
} else {
  await renderMarketingAssets();
  await renderDiagrams();
  console.log('demo assets rendered');
}
