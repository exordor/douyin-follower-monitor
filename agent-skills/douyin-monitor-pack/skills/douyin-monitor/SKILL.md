---
name: douyin-monitor
description: Use for Douyin Follower Monitor diagnostics, runtime setup, troubleshooting, privacy checks, and safe issue preparation. Read-only by default; do not start scans, dashboards, or launchd jobs unless the user explicitly invokes douyin-monitor-control.
---

# Douyin Monitor

Use this skill when working in or around the `douyin-follower-monitor` project.

## First Step

Run the read-only project inspection:

```bash
npm run skills:inspect -- --no-doctor
```

If deeper environment checks are needed, run:

```bash
npm run doctor
```

## Allowed Read-Only Workflows

- Diagnose setup and runtime health.
- Explain `monitor` recent/full decision behavior.
- Help choose `cdp` or `playwright`.
- Review privacy safety before a PR or release.
- Prepare issue guidance from sanitized output.
- Point users to existing dashboard, troubleshooting, debug-bundle, and launchd commands.

## Boundaries

- Do not start a scan, dashboard, launchd job, or debug bundle from this skill.
- For any action with side effects, tell the user to invoke `douyin-monitor-control`.
- Never print cookie names, cookie values, follower ids, uid, secUid, nicknames, profile URLs, or full follower lists.
- Do not automate or bypass captcha. If verification appears, instruct the user to complete it manually.

## References

- Runtime choice and setup: `references/runtime.md`
- Privacy and issue handling: `references/privacy.md`
- Troubleshooting map: `references/troubleshooting-map.md`
