# Control Actions

Actions map to fixed project commands:

- `doctor`: run local diagnostics.
- `privacy-check`: run release privacy self-check.
- `debug-bundle`: generate a sanitized debug bundle.
- `monitor`: run platform-neutral monitor mode.
- `dashboard`: build and serve the local dashboard.
- `launchd-install-hourly`: install user LaunchAgent for hourly Playwright monitor collection.
- `launchd-status`: show sanitized LaunchAgent status.
- `launchd-kickstart`: trigger the LaunchAgent once.
- `launchd-stop`: unload the LaunchAgent.

`launchd-*` actions only work on macOS. The install action uses the current project root, current Node executable, and `data/auth/douyin-cookies.json`; it does not hard-code a user's home directory.
