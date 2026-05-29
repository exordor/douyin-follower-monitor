# Troubleshooting Map

Use `docs/troubleshooting.md` for detailed symptoms and fixes.

Common routing:

- Captcha or verification page: manual completion only; do not automate drag/recognition.
- Cookie imported but not logged in: run `npm run doctor`, inspect runtime health, and prefer CDP when Playwright repeatedly verifies.
- CDP fails: verify Chrome/Edge/Chromium was launched with `--remote-debugging-port=9222`.
- `Douyin webpack runtime is not available`: confirm the page is loaded, logged in, and not a captcha/error page.
- Follower count mismatch: explain hidden/unavailable followers and `hiddenOrUnavailableCount`.
- Full scan interrupted: partial files are preserved; rerun `monitor` or `scan:full`.
