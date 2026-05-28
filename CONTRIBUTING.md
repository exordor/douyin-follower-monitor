# Contributing

感谢你愿意改进 Douyin Follower Monitor。

## 开发流程

```bash
npm ci
npm run check
npm run test:state
npm run test:dashboard
```

提交 PR 前请确认：

- 不提交 `data/`、真实粉丝昵称、secUid、SQLite、CSV 或浏览器 profile。
- 新增扫描逻辑必须保留 partial checkpoint，避免中断丢数据。
- 任何取关判断只允许由完整 `full` 扫描推进。
- Web UI 只能读取本地数据，不在 v1 里触发采集命令。

## 代码风格

- Node.js ESM。
- 默认使用标准库和轻量依赖。
- Dashboard 图表使用本地 SVG 组件，避免引入重型 chart 库。
- 文档中文优先，公开展示只使用 synthetic 数据。

## PR 内容

请在 PR 描述中说明：

- 改了什么。
- 为什么改。
- 如何验证。
- 是否影响数据格式、SQLite 表结构或导出文件。
