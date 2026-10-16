# Dev Servers for BB

Manage persistent machine servers and discover HTML development servers in BB
worktrees. The left Dev Servers tab has **Persistent servers** and **Thread dev
servers** sections. Thread rows retain their project, worktree, linked chat,
port, process, terminal association, and preview workflow.

- In a thread, choose **New tab → Open dev server** to pick a running server
  and replace the chooser with a live preview and URL bar in that panel tab.
- On the Dev Servers page, **Open** navigates to the server's linked chat and
  opens that server beside it. The adjacent menu copies the URL or opens it in
  an external browser.

Agents can start a server in a BB terminal with a stable port block:

```sh
bb dev-servers start --name "icon grader" --command 'pnpm dev --port {port} --host 127.0.0.1'
```

Use `{port+1}` through `{port+4}` for additional services in the same
environment with the default five-port block.

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
terminal leases. A five-port block supports `{port+4}`, not `{port+9}`.

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
reserving 5995 makes 5995–5999 unavailable with five-port blocks (5990–5999
with legacy ten-port blocks). Explicit thread
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

The defaults allocate ninety five-port blocks in 5910–6359, stopping below
Redis's 6379. Blocks are assigned when a server starts and released after the last
listener and managed terminal exit, within 15 seconds or before the next
allocation. Idle worktrees and permanent checkouts do not hold ports. Running
servers retain their blocks; ports may change after every server stops.

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
its lease when the listener stops. Persistent promotion adds supervision.

Configure the
first port, ports per worktree, and worktree-block count in BB's plugin
settings, or from the CLI:

```sh
bb plugin config dev-servers set portBase 5910
bb plugin config dev-servers set blockSize 5
bb plugin config dev-servers set blockCount 90
```

Explicitly saved settings are preserved on upgrade; unsaved defaults change
to five ports and ninety blocks. Running legacy blocks keep their
old size until their servers stop, even after the settings change. Fresh
allocations then use the configured size. Harbor's 5995 reservation excludes
the 5995–5999 block with these defaults, leaving eighty-nine concurrent blocks
once legacy blocks drain.

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
- Other clients fall back to BB Connect. The viewer must be signed into the BB
  owner's account. A server that sets restrictive iframe headers may still
  require the external-browser action.

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
