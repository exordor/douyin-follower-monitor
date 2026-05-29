---
name: douyin-monitor-control
description: Manual control workflow for Douyin Follower Monitor. Use only when the user explicitly asks to start scans, dashboards, debug bundles, or launchd automation.
---

# Douyin Monitor Control

This skill may perform side effects, but only through the project's fixed allowlist.

## Required Flow

1. Run a dry run first:

```bash
npm run skills:control -- <action>
```

2. Execute only if the user explicitly requested that exact action in the current turn:

```bash
npm run skills:control -- <action> --yes
```

3. Report the command result and any next manual step.

## Allowed Actions

- `doctor`
- `privacy-check`
- `debug-bundle`
- `monitor`
- `monitor-doubao`
- `dashboard`
- `dashboard-doubao`
- `launchd-install-hourly`
- `launchd-status`
- `launchd-kickstart`
- `launchd-stop`

## Boundaries

- Do not run arbitrary shell commands through this skill.
- Do not add extra CLI arguments beyond the fixed action.
- Do not print cookie names, cookie values, follower ids, uid, secUid, nicknames, profile URLs, or full follower lists.
- Do not automate captcha or verification. If verification appears, wait for manual completion or explain how to retry.

See `references/actions.md` for action behavior.
