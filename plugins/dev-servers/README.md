# Dev Servers for BB

Manage persistent machine servers and discover HTML development servers in BB
worktrees. The left Dev Servers tab has **Persistent servers** and **Thread dev
servers** sections. Thread rows retain their project, worktree, linked chat,
port, process, terminal association, and preview workflow.

- In a thread's right-hand **Info** tab, **Dev Servers** lists the apps running
  in that environment and its active child threads, including nested children
  in other checkouts/projects. Current-environment apps come first; child apps
  have a muted **child** label in the same compact list. Hover a row to see
  its owning thread, or use **… → Open child thread** to navigate there.
  Shared listeners appear once, and the count is servers.
  Parents without their own checkout can still show their children's apps.
  Rows use bb's native icons, spacing and muted ports. Click a name for its
  preview; **… → Copy URL** copies its secure URL. The menu appears on hover
  or keyboard focus and stays visible on touch devices.
  The native section remembers its collapsed state, refreshes every ten seconds
  while the app is visible, following server and thread-tree changes. It hides
  when neither the environment nor its child threads has a server. Archived,
  deleted and hidden child threads are omitted by bb's subtree lookup.
  A failed scan shows Retry. Servers without a secure URL remain visible with
  preview/copy disabled. Machine-wide persistent servers remain in the left tab.
  Opening a child's app previews it beside the parent, without switching chat.
- **New tab → Open dev server** also lets you pick a running server
  and replace the chooser with a live preview and URL bar in that panel tab.
- On the Dev Servers page, **Open** navigates to the server's linked chat and
  opens that server beside it. The adjacent menu copies the URL or opens it in
  an external browser.

The Info section uses bb's experimental native Info components and requires
bb 0.47 or newer. Preview tabs use `experimental_tab`; the existing New tab
launcher and previously opened preview tabs keep the same ID and parameters.

Agents can start a server in a BB terminal with a stable port block:

```sh
bb dev-servers start --name "icon grader" --command 'pnpm dev --port {port} --host 127.0.0.1'
```

The default ten-port blocks start at 5910, 5920, … 5990. Use `{port}` for the
app and `{port+1}` through `{port+9}` for auxiliary services. Fieldlabel's R2
CORS allowlist accepts app origins only on those `59x0` base ports; a server
on an offset such as 5925 cannot use that allowlist.

Wrangler and Cloudflare Vite need a separate inspector port in that block to
avoid colliding on their shared default. Wrangler supports the flag directly:

```sh
bb dev-servers start --name "icon grader" \
  --command 'pnpm exec wrangler dev --port {port} --ip 127.0.0.1 --inspector-port {port+4}'
```

For Cloudflare Vite, use `--inspector-port '{port+4}'` on **bb's start command**
and set `cloudflare({ inspectorPort: process.env.BB_DEV_SERVER_INSPECTOR_PORT
? Number(process.env.BB_DEV_SERVER_INSPECTOR_PORT) : undefined })` in the Vite
config. The option reserves that slot and exports the variable; Vite must read
it explicitly. Cloudflare documents its
[Vite inspector configuration](https://developers.cloudflare.com/workers/vite-plugin/reference/debugging/).
See the [agent skill](skills/dev-servers/SKILL.md#wrangler-and-cloudflare-vite-inspectors)
for full examples and verification. Every command placeholder and the optional
inspector slot are checked for listeners, persistent reservations, and pending
terminal leases. `{port+4}` fits the default ten-port block; offsets must stay
below the configured block size.

Always pass a short purpose label with `--name`, including for adoption and
persistent registration. Names allow spaces and are capped at 24 characters;
longer explicit names are rejected with an error. The side panel, chooser and
preview tabs show the name first, with port and thread as secondary context.
`bb dev-servers list` includes `name`. Without one, the plugin uses the trimmed
thread title, or a project/directory plus script label such as `fieldlabel dev`.
The plugin also supplies this naming instruction to agents.

## Persistent servers

Persistent servers belong to this bb server machine. Their definitions and
enabled state survive thread archival, worktree deletion, plugin reload, and
bb restarts. bb's plugin background service starts enabled definitions,
restarts failed processes with capped exponential backoff, and monitors the
expected HTTP response. There is no per-server LaunchAgent.

```sh
bb dev-servers persist add --name canvas \
  --cwd /Users/andrew/Developer/canvas-viewer \
  --command 'npm run dev -- --host 127.0.0.1 --port {port}' \
  --port 6360 --health-body '<title>Canvas</title>' --tailnet
bb dev-servers persist list --json
bb dev-servers persist logs canvas --lines 40
bb dev-servers persist restart canvas
bb dev-servers persist stop canvas
bb dev-servers persist start canvas
bb dev-servers persist remove canvas
```

The UI displays running/starting/crashed/restarting/stopped status, uptime,
health, last exit, retry time, recent stdout/stderr, and Start/Stop/Restart.
**Promote** on a thread row prepares the command for a persistent definition;
review it, choose a durable directory, and select a free fixed port. Managed
worktree directories are refused, and the original thread server continues
running. **Add** registers a new definition directly.

Prefer free ports in 6360–6378, outside the default thread range. Persistent
ports must be 5910–65535, outside active worktree blocks and the infrastructure
denylist below. Even stopped definitions reserve their port;
future block allocation skips the entire overlapping block. For example,
reserving 5995 makes the default 5990–5999 block unavailable. Explicit thread
`--port` also respects persistent reservations. Removing the definition frees
the reservation.

Commands run in `/bin/sh` with bb's environment and the chosen working
directory, on the **server machine**, even for CLI callers on another machine.
Use a foreground process and loopback binding. `{port}` expands to the fixed
port. The watchdog owns its process group and shuts descendants down on Stop,
reload, disable, normal shutdown, or loss of bb's pipe lease after an abrupt
exit. Enabled definitions restart when bb starts; a manual Stop stays stopped.

By default, health expects HTTP 200 and `text/html` from `GET /`; add an
expected `--health-body` to identify the application. Path, status and
Content-Type are configurable, body reads are bounded to 64 KiB, and requests
time out in three seconds. After a 30-second startup grace, three failed
checks restart the process. Exits retry after 1, 2, 4, … seconds up to 60
seconds; a minute of healthy operation resets backoff. A TCP connection alone
does not mark a server healthy.

`--tailnet` creates a private Tailscale Serve HTTPS proxy on the fixed port,
after health passes. The plugin saves its ownership and removes its exact
rule on Stop/removal/shutdown. Startup recreates it. It refuses public Funnel,
other proxy targets and extra handlers; an identical existing private rule
requires explicit `--adopt-tailnet-rule`. Cleanup failures retain ownership
for retries; modified rules are preserved. Persistent servers never use BB
Connect. Tailscale must already be connected and support non-interactive
Serve; `TAILSCALE_BIN` selects its executable.

Use `--stopped` to prepare a cutover without disturbing another process.
See [Harbor cutover](harbor-migration.md) and the full
[agent skill](skills/dev-servers/SKILL.md) for operational constraints and
command options.

## Port blocks

The defaults allocate nine ten-port blocks in 5910–5999. Their app ports stay
on the `59x0` grid required by Fieldlabel's R2 CORS allowlist. Blocks are
assigned when a server starts and released after the last
listener and managed terminal exit, after a two-minute stopped grace period.
`idleReleaseMinutes` configures the grace (0–1440); `release` bypasses it.
Reconciliation runs every 15 seconds and before allocation. Idle worktrees and
permanent checkouts do not hold ports indefinitely. Running
servers retain their blocks; ports may change after every server stops.

Every assignment is reconciled against its terminal or adopted listener,
including fixed ports with no block. A closed terminal's old assignment is
removed even when a different environment now listens on its port. New blocks
skip all occupied ports; a listener appearing on the base during allocation
also refuses launch. Fixed-port starts respect other environments' block and
startup leases.

Vite commands and recognized package scripts get `--strictPort` automatically,
so a collision exits instead of silently moving off the CORS grid. Custom
wrappers must pass the flag inside their Vite invocation. Other server CLIs
retain their arguments. See the agent skill for shell/script detection limits.
Automatic allocation requires `{port}` in `--command`, and refuses literal
59xx numbers anywhere in the command. Use `--port` explicitly only when a fixed
port is required; it still checks reservations, leases and listeners.

To stop this thread's managed server terminals and release idle leases:

```sh
bb dev-servers stop --json
bb dev-servers stop --port 5960 --json
bb dev-servers release --json
```

`stop --port` closes that server's terminal and all its assigned ports. Other
threads' terminals are preserved. `bb terminal close <terminalId>` also works.
`release` never kills processes and refuses live or unverified servers in the
environment. Adopted processes must be stopped separately before release;
`stop` reports those ports. Persistent servers use `persist stop NAME`.

All TCP listeners protect ports, including non-HTML services. Managed terminals
protect the interval before a server binds, and an unavailable terminal status
keeps its lease. Conflict errors name the listening process, PID and linked
thread, and flag unmanaged listeners. To associate a manually started server:

```sh
bb dev-servers adopt --name "icon grader" --port 5910 --json
```

Run adoption from the server's own project thread. It leases the block and
records its thread without restarting or supervising the process. It refuses
other environments' processes and persistent reservations. Adoption releases
its lease after the listener stops and the stopped grace expires. Persistent
promotion adds supervision.

The plugin audits unmanaged dev-like listeners in 5910–6999 every two minutes.
It adopts an app on a configured block base (and helpers in that same owner's
block) only when the process's cwd, thread ID or existing assignment establishes
its owner and no foreign listener/lease conflicts. Ambiguous shared checkouts
remain unassigned. It never moves or kills an external process. If it can
identify the owner but cannot adopt, that thread receives one actionable notice
per port until the issue clears, including across plugin reloads.

If every block is busy, `start` lists the holders, PIDs, and thread/stopped idle
times. It sends the longest-idle identified holder a stop/release request once
per scarcity episode. Thread inactivity is a reason to ask, never authority to
stop or take another thread's running server.

## Private thread Serve rules

For app base ports, the plugin creates and owns a private same-port Tailscale
Serve HTTPS root proxy after the loopback app returns HTTP 200 and HTML. Existing
identical private root proxies are adopted automatically. Stop, loss of the app,
and plugin unload remove the owned route; active apps regain it after reload.
Helpers and explicit off-grid ports get no automatic rule. Tailscale must already
be signed in; a failure is logged, without interactive login or public exposure.

The two-minute audit also removes simple private same-port loopback rules in
5910–6999 with no real application listening. A Tailscale listener alone is not
a backend. Persistent definitions (even stopped), infrastructure ports, Funnel,
custom targets/handlers and **5900–5909** are excluded. The plugin never mutates
VNC rules, even from legacy ownership metadata. An externally changed owned
rule is left untouched. No BB Connect tunnel or public Funnel is created.

Configure the
first port, ports per worktree, and worktree-block count in BB's plugin
settings, or from the CLI:

```sh
bb plugin config dev-servers set portBase 5910
bb plugin config dev-servers set blockSize 10
bb plugin config dev-servers set blockCount 9
```

Saved settings are preserved on upgrade and reload. **Do not change machine
settings during plugin releases** unless the user explicitly requests that
configuration change. Running blocks keep their stored size until all their
servers stop; new allocations then use the configured size. Harbor's 5995
reservation excludes the 5990–5999 block with the defaults, leaving eight
concurrent thread blocks. Idle environments hold no block.

The hard-coded infrastructure denylist is **22, 80, 443, 3389, 5432,
5900–5909, 6379, 8080, 38886, 38887, and 41641**. bb's actual server port
and `BB_HOST_DAEMON_PORT` are protected too when configured differently.
Screen Sharing lost its VNC greeting for three days when an orphaned Serve
rule claimed 5900, so the entire 5900–5909 span is reserved even if idle.
Ports below 5910 are never assigned. At startup and on each allocation the
entire configured range is checked: any overlap fails instead of skipping a
hole. Explicit ports and offsets, adoption, persistent startup and private
Serve creation enforce the same policy. Old forbidden persistent definitions
are disabled, remain removable, and have their exact owned private rule cleaned
up. IPv4/IPv6 and non-HTTP listeners protect ports before a new server starts.

Persistent names follow the same 24-character cap and may contain spaces.
Quote them in control commands, e.g. `bb dev-servers persist restart "icon grader"`.
When no name is supplied, CLI thread context supplies a title; other callers
use the directory and script. Legacy longer identifiers remain valid control
targets, with a bounded `displayName` for the UI.

The plugin records the short name in owned rule metadata and returns it as
`tailnetDescription` alongside a tailnet URL. Tailscale's native
[Serve configuration](https://github.com/tailscale/tailscale/blob/main/ipn/serve.go)
has no per-rule description field, so labels are shown in Dev Servers and its
CLI output; the native proxy target and access scope keep their normal meaning.

## Current scope

- Thread discovery runs on the BB server host and currently uses macOS `lsof` and
  `ps`.
- Thread discovery shows only HTML listeners from known BB project environments.
  Persistent definitions are global and are excluded from thread discovery.
- When BB is opened through a Tailscale `*.ts.net` origin and Tailscale Serve
  already exposes a server's HTTPS port, previews use that Tailnet URL. This
  avoids a second sign-in and keeps access inside the Tailnet.
- Previews otherwise use the loopback URL. For another machine, open bb through
  its private tailnet origin. A server that sets restrictive iframe headers may
  still require the external-browser action.

## Install

From the plugin directory:

```sh
npm install
bb plugin install .
```

## Development

```sh
bb plugin dev
```

Saving a source file rebuilds and reloads the plugin while this command is
running.

```sh
npm run typecheck
npm test
bb plugin build .
```

Tests use the public Plugin SDK backend/frontend harnesses and real loopback
processes. They exercise crash/backoff and cleanup, durable Stop/startup,
health response validation, reservations, rule ownership, CLI contracts, and
the left-tab controls and promotion form. Tests need a free port in 6360–6368.
Work in this repository’s main checkout. Build and reload the plugin in the
running bb to test it; install from commits on main.
