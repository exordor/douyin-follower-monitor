# Agent Skills

This project ships repo-scoped skills for Codex and Claude Code.

## Install

Repo-scoped usage is zero-install:

```bash
git clone https://github.com/exordor/douyin-follower-monitor
cd douyin-follower-monitor
codex
# or: claude
```

Codex discovers `.agents/skills/`. Claude Code discovers `.claude/skills/`.

Optional user-scoped install:

```bash
npm run skills:install:user
```

This copies the project skills to:

- `~/.agents/skills/`
- `~/.claude/skills/`

Uninstall:

```bash
npm run skills:uninstall:user
```

## Skills

- `douyin-monitor`: read-only diagnostics, runtime guidance, privacy review, and troubleshooting.
- `douyin-monitor-control`: manual control for allowlisted actions such as `monitor`, `dashboard`, `debug-bundle`, and `launchd-*`.

Codex invocation:

```text
$douyin-monitor
$douyin-monitor-control
```

Claude Code invocation:

```text
/douyin-monitor
/douyin-monitor-control
```

## Contributing

Edit the canonical source under `agent-skills/douyin-monitor-pack/`, then sync generated targets:

```bash
npm run skills:sync
npm run test:skills
```

Do not edit `.agents/skills/` or `.claude/skills/` by hand unless you are debugging generated output.

## Safety

The default skill is read-only. The control skill only runs fixed allowlist actions through:

```bash
npm run skills:control -- <action>
```

Mutating actions are dry-run by default. They execute only with `--yes`.

The skills must not print cookie names, cookie values, follower ids, uid, secUid, nicknames, profile URLs, or full follower lists. They also do not automate captcha, drag verification, proxy rotation, account pools, or third-party solving services.
