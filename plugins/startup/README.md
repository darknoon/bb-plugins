# bb Startup

Portable macOS startup management for bb. The plugin installs a per-user
LaunchAgent on the selected enrolled host and always starts `bb-app@latest`.

```sh
bb startup status
bb startup enable
bb startup disable
```

Commands target bb's primary host by default. Use `--host <host-id>` to manage
another enrolled host. `enable` schedules a handoff from the current process to
launchd; use `--no-handoff` when staging or inspecting the setup first.

When enabled, the plugin also appears under BB Settings → Extensions → Startup.
That page polls the primary host while visible and shows LaunchAgent, current
runtime, login-keychain, Tailscale Serve, and managed-command health. Its
“Start bb at login” switch changes future-login startup without abruptly
stopping the current bb process. If startup is installed but the current bb is
unmanaged, the page offers a separate managed-restart action.

The LaunchAgent runs after the macOS user logs in, so the login keychain is
available to bb's providers. It also reconciles `tailscale serve --bg 38886`
when starting bb, if the Tailscale CLI is installed.
