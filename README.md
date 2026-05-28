# Douyin Follower Monitor

![Douyin Follower Monitor hero](web/public/readme-hero.png)

[![CI](https://github.com/exordor/douyin-follower-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/exordor/douyin-follower-monitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js >=24](https://img.shields.io/badge/Node.js-%3E%3D24-339933.svg)](package.json)
[![Local First](https://img.shields.io/badge/data-local--first-14b8a6.svg)](#隐私边界)

发现谁取关了你。本项目通过你已经登录的本机浏览器读取抖音当前账号可枚举的粉丝列表，用 SQLite 长期记录粉丝变化，并提供本地 Web 仪表盘查看新增、改名、疑似取关、确认取关和重新出现。

> 非官方工具。本项目不属于抖音或字节跳动，不使用官方 logo，不绕过登录、签名或隐私限制。请只用于你有权访问的账号，并遵守平台规则。

## Demo

![Terminal demo](web/public/terminal-demo.gif)

```bash
npm install
npm run monitor
npm run dashboard
```

打开本地仪表盘：

```text
http://127.0.0.1:4573
```

公开演示站使用 mock 数据，不包含真实粉丝信息：

[https://exordor.github.io/douyin-follower-monitor](https://exordor.github.io/douyin-follower-monitor)

## 功能

- `monitor` 自动决策：无基线先 `full`，日常 `recent`，粉丝数下降或 full 过期时自动 full。
- `recent` 轻量扫描：默认只扫最近 5 页，连续命中已知粉丝后提前停止。
- `full` 权威可枚举基线：完整扫分页，并推进疑似/确认取关状态机。
- SQLite 长期状态：`followers`、`scan_runs`、`follower_events` 三张表记录历史。
- 中断保护：采集过程中持续写入 `data/in-progress/latest.partial.*`。
- 本地 Web 仪表盘：趋势图、事件图、状态分布、粉丝/事件/扫描表格。
- Cookie 登录态导入：支持 cookie-manager 无损 JSON，让 Playwright/CDP 在采集前注入 `douyin.com` cookie。
- JSON/CSV 双写导出：保留人工查看和脚本兼容能力。

## 工作原理

![Scan workflow](docs/diagrams/scan-workflow.png)

API 模式不会滚动 DOM，而是在当前抖音页面主执行环境里调用页面已加载的粉丝分页接口。它复用你的浏览器登录态和页面已有请求逻辑，通常比滚动粉丝弹窗快得多。

```bash
npm run monitor
```

常用脚本：

```bash
npm run scan:recent
npm run scan:full
npm run monitor:doubao
npm run collect:doubao:api
npm run dashboard:dev
```

## Browser Runtime

采集层通过 runtime adapter 连接已经登录的浏览器。默认 `auto` 规则是：传入 `--browser-app` 时使用 Apple Events；传入 `--cdp-url` 或 `DOUYIN_CDP_URL` 时使用 CDP；否则使用 Playwright 持久 profile。

| Runtime | 适用场景 | Cookie 导入 | 示例 |
| --- | --- | --- | --- |
| `playwright` | 跨平台默认入口，使用 `.douyin-browser` 持久 profile，首次运行需要登录 | 支持 | `npm run monitor` |
| `cdp` | 连接已开启 remote debugging 的 Chrome/Edge/Chromium | 支持 | `DOUYIN_CDP_URL=http://127.0.0.1:9222 npm run monitor` |
| `apple-events` | macOS 复用已登录豆包/Chrome 类浏览器标签页 | 不支持，直接复用浏览器登录态 | `npm run monitor:doubao` |

CDP 示例：

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/douyin-cdp-profile

DOUYIN_CDP_URL=http://127.0.0.1:9222 npm run monitor
```

豆包浏览器快捷入口：

```bash
npm run monitor:doubao
npm run dashboard:doubao
```

## Cookie 登录态

如果你使用 [Local Cookie Manager](https://github.com/exordor/sunbeam-cookie-jar) 导出了抖音 cookie，可以把无损 JSON 用作平台无关登录态。项目只接受 `format: "local-cookie-manager-v1"`，默认只导入对当前目标站点生效的 cookie，例如 `.douyin.com` 和 `www.douyin.com`；`creator.douyin.com`、`live.douyin.com` 这类无关子域 cookie 会被跳过。不导入 redacted 文件、过期 cookie 或分区 cookie。

CLI 示例：

```bash
node scripts/collect-followers.mjs \
  --runtime playwright \
  --cookie-file ./cookies-douyin.com.json \
  --api \
  --mode monitor

DOUYIN_COOKIE_FILE=./cookies-douyin.com.json npm run monitor
```

Dashboard 也可以在“采集控制”面板上传 cookie-manager 无损 JSON。文件会保存到本机 `data/auth/douyin-cookies.json`，权限设置为 `0600`，并且 `data/` 默认不会入库。上传和状态 API 不返回 cookie 名称或值，只返回导入数量摘要。

Cookie 注入不会主动刷新已打开的抖音页面；新 profile 或空白页会在首次导航前注入 cookie，避免因为页面刷新增加验证码触发概率。

如果抖音在新 profile 中显示“验证码中间页”，dashboard 启动的采集任务会等待人工处理。请在弹出的浏览器窗口里手动完成验证码，任务会继续采集；项目不会自动处理或绕过验证码。

## 取关判断

![Removal state machine](docs/diagrams/removal-state-machine.png)

只有 `full` 扫描能产生取关判断：

- 第一次 full 缺失：`suspected_removed`
- 下一次 full 仍缺失：`removed`
- 之后重新出现：恢复 `active`，记录 `reappeared`

`recent` 只记录新增、昵称变化和最后出现时间，不会因为只扫最近页就误判取关。

## Web 仪表盘

本地仪表盘默认读取：

- `data/followers.db`
- `data/latest.json`
- `data/latest.csv`
- `data/latest-change.json`

启动：

```bash
npm run dashboard
```

开发模式：

```bash
npm run dashboard:dev
```

本地 API：

- `GET /api/summary`
- `GET /api/timeline?days=30`
- `GET /api/event-daily?days=30`
- `GET /api/events?type=&q=&limit=&offset=`
- `GET /api/followers?status=&q=&limit=&offset=`
- `GET /api/runs?limit=100`
- `GET /api/export/latest.json`
- `GET /api/export/latest.csv`
- `GET /api/scan/status`
- `GET /api/scan/events`
- `POST /api/scan/start`
- `POST /api/scan/stop`
- `GET /api/auth/cookies/status`
- `POST /api/auth/cookies/import`
- `DELETE /api/auth/cookies`

自定义路径：

```bash
node --disable-warning=ExperimentalWarning scripts/serve-dashboard.mjs \
  --db data/followers.db \
  --out-dir data \
  --port 4573 \
  --runtime playwright
```

## 输出文件

- `data/followers.db`: SQLite 长期状态库
- `data/latest.json`: 当前 active 可枚举粉丝快照
- `data/latest.csv`: 当前 active 可枚举粉丝 CSV
- `data/latest-change.json`: 最近一次变化摘要
- `data/in-progress/latest.partial.json`: 采集中实时进度
- `data/in-progress/latest.partial.csv`: 采集中实时 CSV
- `data/auth/douyin-cookies.json`: 本地 cookie-manager 无损 JSON 导入文件
- `data/snapshots/*.json`: 历史快照
- `data/changes/*.json`: 历史差异

`data/` 默认被 `.gitignore` 忽略。不要提交真实粉丝数据。

## 隐私边界

抖音账号可以关闭“在他人关注和粉丝列表公开出现”。这类账号可能计入主页粉丝数，但不会出现在可枚举粉丝列表中。

本项目只承认可枚举列表结果：

- 不尝试补全隐藏账号。
- 不绕过登录、风控、签名或隐私限制。
- 不上传 SQLite、JSON、CSV 或浏览器数据。
- 不在日志或 API 响应中输出 cookie 名称和值。
- `hiddenOrUnavailableCount = 主页粉丝数 - 可枚举粉丝数` 仅作为统计差值。

## 开发

```bash
npm ci
npm run check
npm run test:state
npm run dashboard:build
npm run test:dashboard
npm run pages:build
```

重新生成宣传资产和图：

```bash
npm run render:assets
```

## 贡献

欢迎提 issue 和 PR。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。

## License

[MIT](LICENSE)
