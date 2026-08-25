---
name: startup
description: Manage automatic bb startup on an enrolled macOS host. Use when the user asks whether bb starts after login, wants to enable or disable startup, inspect the LaunchAgent, or hand bb off to launchd supervision.
---

# bb Startup

Use `bb startup status` first. Commands use the primary host unless the user
names a different enrolled host, in which case pass `--host <host-id>`.

The same primary-host status and controls are available under BB Settings →
Extensions → Startup. The page polls only while visible and rechecks when BB
reconnects; it has no manual refresh button or persistent polling service.

- `bb startup enable` installs the LaunchAgent and schedules an immediate
  managed handoff.
- `bb startup enable --no-handoff` stages and loads it without stopping the
  currently running bb.
- `bb startup handoff` schedules the managed restart after a staged enable.
- `bb startup disable` schedules launchd unload and removes only files carrying
  the plugin's ownership marker.

Startup is deliberately login-time rather than pre-login: provider credentials
stored in the macOS login keychain are available after login. The managed
command is always `bb-app@latest`. Report that a FileVault reboot still needs a
disk unlock and a macOS login before this user LaunchAgent can run.
