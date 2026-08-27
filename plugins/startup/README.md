# bb Startup

Portable macOS startup management for bb. The plugin installs a per-user
LaunchAgent on the selected enrolled host and always starts `bb-app@latest`.

## Clean install

Requirements: macOS, Git, and a supported Node installation that includes
`npm` and `npx` (Node 22.19+, 24, or 26). Log in to providers first. For
GitHub, configure non-interactive credentials with `gh auth login` and
`gh auth setup-git`. For remote access, install and sign in to Tailscale.

In terminal A:

```sh
npx --yes bb-app@latest start
```

Leave it running. In terminal B:

```sh
npx --yes --package=bb-app@latest bb plugin install \
  git:https://github.com/darknoon/bb-plugins.git@main \
  --plugin startup --yes
npx --yes --package=bb-app@latest bb startup enable --no-handoff
npx --yes --package=bb-app@latest bb startup status
```

Confirm startup is enabled and any detected provider credential is accessible.
The LaunchAgent is staged but deliberately not started while the foreground bb
still owns the port.
Then open **Settings → Extensions → Startup** and select **Restart under
launchd**. On a fresh setup with no active turns, the CLI equivalent is:

```sh
npx --yes --package=bb-app@latest bb startup handoff
```

After bb reconnects, `bb startup status` should report
`Current runtime: launchd-managed`. The plugin uses the same Node installation
that bootstrapped bb, including nvm and versioned Homebrew installations. If
that installation is later replaced, startup resolves the new `npx` from the
user's login shell.

Every managed start runs `bb-app@latest`. After a FileVault reboot, someone
must still unlock the disk and log in to this macOS account before the
LaunchAgent and login keychain become available.

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

The first handoff stops the foreground launcher and waits for both port 38886
and its runtime record to be released before loading the LaunchAgent. Managed
restarts use launchd's `KeepAlive`; crash-loop retries are throttled to 30
seconds and launchd allows 30 seconds for a clean exit.
