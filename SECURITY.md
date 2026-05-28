# Security Policy

## Supported Versions

当前只维护 `main` 分支。

## Reporting a Vulnerability

请通过 GitHub Security Advisory 或私下联系仓库维护者报告安全问题。不要在公开 issue 中粘贴：

- 登录态 cookie
- 抖音账号标识
- secUid/uid 映射表
- SQLite 数据库
- JSON/CSV 真实导出
- 浏览器 profile 路径或截图中的私信内容

## Privacy Model

本项目是 local-first 工具：

- 采集运行在你的本机浏览器登录态中。
- 默认数据目录 `data/` 被 git 忽略。
- Dashboard 只绑定 `127.0.0.1`。
- GitHub Pages 只使用 synthetic mock 数据。

任何试图绕过平台隐私设置、登录限制、请求签名或风控机制的改动都不接受。
