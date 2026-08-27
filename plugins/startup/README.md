# bb Startup

Portable macOS startup management for bb. The plugin installs a per-user
LaunchAgent on the selected enrolled host and always starts `bb-app@latest`.

## Clean macOS installation (bb not installed)

No global bb installation is required. These steps bootstrap bb with `npx`,
install the plugin from GitHub, and then transfer the running server to
launchd.

### 1. Prepare the Mac

- Log in to the macOS user that should own and run bb. The LaunchAgent is
  per-user and does not require `sudo`.
- Install a bb-supported Node.js release: Node 22.19 or newer in the 22.x
  series, Node 24, or Node 26. Confirm that `node`, `npm`, and `npx` work:

  ```sh
  node --version
  npm --version
  npx --version
  ```

- Confirm `git --version` works. On a fresh Mac, install the Xcode Command
  Line Tools if macOS prompts for them.
- Sign in to the agent providers bb will use before handing bb to launchd.
  The Startup page checks whether an existing Claude Code credential can be
  read from the login keychain. If bb will perform GitHub operations, also
  configure non-interactive Git authentication (for example, `gh auth login`
  followed by `gh auth setup-git`) so a background process never waits for a
  username prompt.
- Optional, but recommended for remote access: install Tailscale and sign in
  to the tailnet. The plugin will configure Tailscale Serve for bb's port when
  startup is enabled.

### 2. Bootstrap bb in a foreground terminal

In terminal or SSH session A, start the latest bb release:

```sh
npx --yes bb-app@latest start
```

Leave this command running. bb listens on port `38886`; locally, its UI is
normally available at `http://127.0.0.1:38886`.

### 3. Install and stage the plugin from a second terminal

Open terminal or SSH session B on the same Mac. Use the CLI packaged with the
latest bb release:

```sh
npx --yes --package=bb-app@latest bb status
npx --yes --package=bb-app@latest bb plugin install \
  git:https://github.com/darknoon/bb-plugins.git@main \
  --plugin startup --yes
npx --yes --package=bb-app@latest bb startup enable --no-handoff
npx --yes --package=bb-app@latest bb startup status
```

`--no-handoff` installs and loads the LaunchAgent without stopping the
foreground server. Before continuing, status should report:

- `Startup: enabled (loaded)`
- a managed command ending in `npx --yes bb-app@latest start`
- provider credentials accessible, when a detected credential is present
- Tailscale Serve configured, when Tailscale is installed

It is normal for `Current runtime` to say `not launchd-managed` at this point.

### 4. Hand off to launchd

The safest path is **Settings → Extensions → Startup** in the bb UI. Select
**Restart under launchd**. If any turns are running, the page lists them and
requires an explicit **Restart anyway** confirmation.

On a fresh setup with no active work, the equivalent CLI command is:

```sh
npx --yes --package=bb-app@latest bb startup handoff
```

After the eight-second delay, terminal A exits and launchd starts
`bb-app@latest`. The UI should reconnect after the new process is ready,
typically within several more seconds. Do not manually restart the foreground
command.

### 5. Verify the managed installation

After bb reconnects, run:

```sh
npx --yes --package=bb-app@latest bb startup status
```

Both `Startup: enabled (loaded)` and `Current runtime: launchd-managed` should
now be present. Useful diagnostics are:

```sh
npx --yes --package=bb-app@latest bb plugin logs startup -n 50
launchctl print gui/$(id -u)/app.getbb.startup
tail -n 100 ~/.bb/logs/startup.stderr.log
tailscale serve status
```

When Tailscale is configured, `tailscale serve status` prints the tailnet-only
HTTPS URL to use from another enrolled device.

### Reboots and updates

- This is login-time startup, not pre-login startup. After a FileVault reboot,
  someone must unlock the disk and log in to this macOS account before the
  user's login keychain and LaunchAgent become available.
- Every managed start runs `bb-app@latest`, so restarting bb also updates bb.
- The plugin tracks this repository's `main` branch. Check and apply plugin
  updates with `bb plugin outdated` and `bb plugin update startup` (or the
  equivalent commands through `npx --package=bb-app@latest bb`).

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
unmanaged, the page offers a managed-restart action. When startup is healthy,
the same action restarts and updates bb through `bb-app@latest`. It checks all
visible and hidden threads immediately before scheduling; running threads are
listed and require an explicit **Restart anyway** confirmation.

The LaunchAgent runs after the macOS user logs in, so the login keychain is
available to bb's providers. It also reconciles `tailscale serve --bg 38886`
when starting bb, if the Tailscale CLI is installed.
