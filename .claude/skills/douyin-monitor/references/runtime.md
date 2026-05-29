# Runtime Reference

Prefer stable, local-first runtime paths:

1. `cdp`: best for open-source users who already have a logged-in Chrome/Edge/Chromium session. Requires `DOUYIN_CDP_URL`.
2. `playwright`: cross-platform default. Uses a persistent project profile and can import cookie-manager lossless JSON.
3. `apple-events`: macOS convenience path for reusing a logged-in browser such as Doubao. Not cross-platform.

Useful commands:

```bash
npm run doctor
DOUYIN_CDP_URL=http://127.0.0.1:9222 npm run monitor
npm run monitor
npm run monitor:doubao
```

Use `npm run skills:inspect -- --no-doctor` for a quick sanitized status snapshot. Use `npm run doctor` when the user asks for environment validation.
