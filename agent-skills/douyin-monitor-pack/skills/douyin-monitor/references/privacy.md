# Privacy Reference

The project only records the account's currently enumerable follower list. Hidden or unavailable followers remain unknown and are represented only as aggregate count differences.

Safe commands:

```bash
npm run privacy:check
npm run skills:inspect -- --no-doctor
```

When preparing issue details:

- Prefer sanitized `skills:inspect` output.
- Ask the user before generating a debug bundle.
- Do not include `data/`, SQLite databases, CSV exports, partial snapshots, cookie files, browser profiles, or real account identifiers.
- Do not quote follower lists, nicknames, uid, secUid, or profile URLs.
