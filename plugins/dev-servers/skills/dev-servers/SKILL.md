---
name: dev-servers
description: Start thread dev servers and manage persistent machine servers with health checks, logs, and private tailnet access.
---

# Dev servers

When starting a dev server that the user may keep running, use the Dev Servers plugin instead of a foreground shell command:

**Always pass a short purpose name with `--name`, at most 24 characters**, for
thread starts, adoption and persistent registration. Use labels such as
`--name "icon grader"` so Andrew can see what a server is for in the sidebar.
Spaces are allowed; quote multiword names. Explicit longer names are rejected.

```sh
bb dev-servers start --name "icon grader" --command 'pnpm dev --port {port} --host 127.0.0.1'
```

- By default, an environment gets ten consecutive ports when its first server starts.
  Nine blocks cover 5910–5999, with app bases 5910, 5920, … 5990. This grid
  matches Fieldlabel's R2 CORS allowlist; use `{port}` for its HTTP server,
  since an app on an offset such as 5925 fails that allowlist. Permanent project checkouts
  and idle worktrees hold no block. After the last listener and managed terminal exit,
  the block is released after a two-minute stopped grace (`idleReleaseMinutes`,
  0–1440), checked every 15 seconds and before allocation. `release` bypasses the
  grace for an idle block. Ports can
  change after stopping every server, so always expand the placeholders again.
- The plugin settings `portBase`, `blockSize`, and `blockCount` control the allocation range.
- Vite dev/preview commands and recognized npm/pnpm/yarn/bun scripts that launch
  Vite get `--strictPort` automatically. An occupied port must fail instead of
  drifting to the next port and breaking CORS. Scripts are read from the
  environment's `package.json`. For custom wrappers, dynamic shell commands or
  scripts that do not forward their final arguments to Vite, pass `--strictPort`
  inside the actual Vite invocation. Direct non-Vite commands keep their arguments.
  Disabling `--strictPort` in a detected Vite command is refused.
- Ports below 5910 are unavailable. The hard-coded denylist is 22, 80, 443,
  3389, 5432, **5900–5909**, 6379, 8080, 38886, 38887, and 41641, plus bb's
  actual server and configured host-daemon ports. Screen Sharing was blocked
  for three days by an orphaned Serve rule on 5900; never claim this span even
  if no application answers. Startup rejects an overlapping configured range
  entirely, rather than skipping holes. Explicit ports and offsets, adoption,
  persistent startup and private Serve creation follow the same policy.
- `{port}` is the block's base — use it for the app's dev server. `{port+1}`, `{port+2}` … are the
  other slots in the same block; run a second service in the worktree on one of those rather than
  picking a number. An offset equal to or larger than the configured block size is an error, not a
  silent overrun into the next worktree.
- Automatic allocation requires the literal `{port}` placeholder in `--command`.
  Hard-coded 59xx numbers anywhere in that command are rejected unless `--port`
  is explicit. Use placeholders instead of copying numbers from a previous run.
- Pass `--port <number>` only when the project explicitly requires a fixed port. It bypasses the
  automatic allocation — offsets resolve against it and requested slots have
  terminal leases. It cannot overlap another environment's block, a persistent
  definition, pending terminal or existing listener.
- Use `bb dev-servers list` to inspect servers already running in project worktrees. Servers started another way can still be discovered, but their terminal association may be unavailable.
- Lists include `name`; the side panel and preview chooser show it first, with
  port and thread secondary. When omitted, names default to the thread title
  trimmed to 24 characters, or project/directory plus script, e.g. `fieldlabel dev`.
- Allocation checks **all TCP listeners**, including non-HTML services. A running or
  starting managed terminal holds its block before binding. An inspection failure
  keeps that lease until its state can be checked. Occupied-port errors identify the
  process, PID and linked thread (or say the thread is unknown). Stopped persistent
  definitions still reserve their fixed ports.
- Reconciliation checks every assignment, including fixed ports outside blocks.
  Exited/missing terminals lose their assignments even if a different server now
  listens on the old port. Adopted listeners must still belong to their environment.
  A stale block is released before start selects a free one; another process's
  listener cannot keep that stale block alive. Pending fixed ports and whole blocks
  are protected across environments, not just within the current thread.
- Adopt an existing manually started server from its own project thread:
  `bb dev-servers adopt --name "icon grader" --port 5910 --json`. This records the thread association and
  leases its block without restarting the process or changing its lifetime. The
  process's cwd must belong to that environment, and the block must contain no
  other environment's listeners or persistent reservation. To give it automatic
  startup and crash recovery, use persistent promotion instead.
- Every two minutes the plugin audits unmanaged dev-like listeners in 5910–6999,
  outside persistent definitions. Verified app-base listeners and same-owner
  helpers are adopted automatically when their block is available. Ambiguous
  shared checkouts remain untouched. An identifiable owner whose process cannot
  be adopted receives one notice per port until the issue clears; processes are
  never moved or killed. Restart off-grid apps using `{port}` from their owner.
- If all blocks are busy, start reports the holders and idle times and asks the
  longest-idle identified owner to stop/release once per scarcity episode. Wait
  for that owner to release; never kill another thread's process or choose an
  off-grid port to bypass scarcity. A running server is never reclaimed merely
  because its thread is idle.
- Running blocks keep their stored size until all their servers stop. New
  allocations use the current settings. Saved machine settings survive reloads
  and upgrades. **Do not change machine settings during plugin releases** unless
  the user explicitly requests a configuration change. Keep the default grid
  at `portBase=5910`, `blockSize=10`, `blockCount=9` for Fieldlabel's R2 CORS.

## Stop and release thread servers

```sh
bb dev-servers stop --json
bb dev-servers stop --port 5960 --json
bb dev-servers release --json
```

Run these from the owning project thread. `stop` closes that thread's managed
server terminals; `--port` selects one server, including its other assigned
ports and inspector. It preserves other threads' terminals. You can also close
a terminal directly with `bb terminal close <terminalId>`; reconciliation then
clears its stale assignments and starts the stopped-block grace. `release`
reconciles and releases the
environment's idle lease, and refuses live or unverified servers. Another
thread sharing that environment can keep its lease active. No process is
terminated by `release`. Adopted servers have no managed terminal: stop their
process separately, then release; `stop` reports these ports instead of killing
an unverified process. Persistent servers use `persist stop NAME` instead.

## Private thread access

The plugin owns private Tailscale Serve rules for configured app-base ports.
After a verified app returns HTTP 200 with HTML on loopback, its same-port
HTTPS root route is created (or an identical existing private rule adopted).
Stop, loss of the listener and plugin shutdown remove owned routes; reload
restores routes for active apps. Auxiliary/off-grid ports receive no automatic
rule. Open bb through its private `*.ts.net` origin to use the tailnet preview.
No public BB Connect tunnel or Funnel is created. Never set these up by hand.

The two-minute audit removes orphaned simple private loopback rules in
5910–6999, excluding persistent definitions, infrastructure ports, custom
routes/targets and Funnel. **It never touches 5900–5909**, including legacy
metadata. Tailscale itself listening does not prove a backend is alive. Failed
cleanup is retried; externally changed rules are preserved. Tailscale must be
already signed in; the plugin never starts an interactive login.

## Wrangler and Cloudflare Vite inspectors

Always give the inspector a separate port **inside the same block** when starting
Wrangler or Cloudflare Vite. Shared defaults such as 9229–9231 can collide even
when the HTTP ports differ. `{port+N}` expands everywhere in `--command`, and
each referenced port is checked and leased before the terminal starts.

Wrangler accepts an inspector flag directly:

```sh
bb dev-servers start --name "icon grader" \
  --command 'pnpm exec wrangler dev --port {port} --ip 127.0.0.1 --inspector-port {port+4}'
```

Cloudflare's Vite plugin takes `inspectorPort` in `vite.config`, rather than a
Vite CLI flag. Wire the plugin-provided environment variable into that config:

```ts
cloudflare({
  inspectorPort: process.env.BB_DEV_SERVER_INSPECTOR_PORT
    ? Number(process.env.BB_DEV_SERVER_INSPECTOR_PORT)
    : undefined,
})
```

Then start it with the **bb plugin option**, outside `--command`:

```sh
bb dev-servers start --name "icon grader" --inspector-port '{port+4}' \
  --command 'pnpm dev --port {port} --host 127.0.0.1'
```

This option checks and leases the inspector port, exports
`BB_DEV_SERVER_INSPECTOR_PORT` to the command and its descendants, and returns
`inspectorPort` in JSON output. It requires the Vite config bridge above;
Cloudflare does not read that variable automatically. Do not also reference
the same port in `--command`. The inspector must differ from the app's ports.
If running a second server in the same environment, choose unused slots for
both its app and inspector; an existing listener or starting terminal prevents
reusing a slot. The default ten-port block ends at `{port+9}`; the recommended
`{port+4}` inspector fits inside it. For Fieldlabel, keep the HTTP server on
the block base required by its CORS allowlist. An occupied or out-of-block
inspector fails before launch. After starting, verify the app's expected HTTP
response and the inspector's `/json/list` response; an open TCP port alone
does not prove either service works. Existing servers need restarting with
these settings; adoption does not change their inspector configuration.

## Persistent servers

For viewers and tools that should survive the originating thread, register a
foreground command with the machine supervisor:

```sh
bb dev-servers persist add --name "canvas viewer" \
  --cwd /Users/andrew/Developer/canvas-viewer \
  --command 'npm run dev -- --host 127.0.0.1 --port {port}' \
  --port 6360 --health-body '<title>Canvas</title>' --tailnet
bb dev-servers persist list --json
bb dev-servers persist logs "canvas viewer" --lines 40
bb dev-servers persist restart "canvas viewer"
bb dev-servers persist stop "canvas viewer"
bb dev-servers persist start "canvas viewer"
bb dev-servers persist remove "canvas viewer"
```

- These commands need no project or thread. They run on the **bb server
  machine**. `--cwd` (`--server-cwd` / `--directory`) always names an absolute
  path on that machine, including when the CLI caller is on an enrolled remote
  machine. Never assume the caller's cwd is the server's cwd.
- Always pass the short `--name`. If omitted, a thread context supplies its
  trimmed title; otherwise the directory and script supply a meaningful name.
  Existing persistent identifiers longer than 24 characters remain usable for
  controls; their `displayName` is trimmed for the UI. New names cannot exceed 24.
- Use a durable checkout. Managed worktree paths, including symlinks into
  them, are refused. Review absolute paths in the command as well. The left
  Dev Servers tab's **Promote** form prepares a command with `{port}` and asks
  for a durable directory and a new fixed port. The original thread server
  continues running until explicitly stopped.
- Ports must be 5910–65535 and outside the infrastructure denylist. Prefer
  free ports in 6360–6378, outside the default thread range. Persistent definitions reserve their ports even
  while stopped. The allocator skips an entire block containing a persistent
  port; add refuses a port already assigned to a live worktree. A stopped
  definition may be prepared on an externally occupied port, but Start refuses
  to claim that process. Explicit thread `--port` cannot use reserved ports.
- Old definitions on newly forbidden ports are disabled at startup and their
  exact owned private rules cleaned up. They remain observable and removable;
  Start/Restart refuses them. Register a replacement on an allowed fixed port.
- `{port}` expands to the chosen fixed port. Use a foreground command that
  binds `127.0.0.1`; do not daemonize or use launchd. Commands inherit bb's
  environment, so absolute executable paths are useful for automatic startup.
- Definitions, desired enabled state, last exit, and bounded logs are saved in
  plugin storage. Enabled servers start when bb loads the plugin. **Stop**
  stays stopped across bb restarts; **Start** re-enables automatic startup.
  Plugin reload/disable/shutdown stops process groups. A watchdog closes them
  when bb dies abruptly, allowing its startup supervisor to restart cleanly.
- Health checks require an HTTP response: default `GET /`, status 200 and
  `Content-Type` containing `text/html`. For stronger identity or JSON APIs,
  use `--health-path /health`, `--health-status 200`,
  `--health-content-type application/json`, and `--health-body '"ok":true'`.
  Bodies are searched up to 64 KiB. Checks time out after 3 seconds, run about
  every 5 seconds, allow 30 seconds for startup, and restart after 3 consecutive
  unhealthy checks. A listening TCP port alone never means healthy.
- Process exits (even code 0) and sustained health failures restart with
  exponential backoff, from 1 second to 60 seconds; one minute of healthy
  operation resets the failure count. State, uptime, retry time, last exit,
  health result, and recent logs appear in the left tab. CLI lists are bounded;
  `persist logs` supports 1–80 recent lines, with each line capped at 1024
  characters. At most 32 definitions are supported.
- `--tailnet` owns a Tailscale Serve private HTTPS root proxy on the same port.
  No Connect or Funnel exposure is created for persistent servers. Existing
  rules are refused unless `--adopt-tailnet-rule` explicitly transfers an
  identical private root proxy. Other targets, extra handlers, and public
  Funnel rules are refused. Ownership is saved before mutation, checked again
  periodically, and cleanup affects only that exact rule. Stop/removal and
  plugin shutdown remove owned routes; enabled startup recreates them.
  Failed cleanup retains the ownership record for a retry; externally changed
  rules are left untouched. Tailscale must already be signed in; the plugin
  never starts an interactive login. `TAILSCALE_BIN` can select the executable.
- Owned rule metadata and `tailnetDescription` include the short purpose name.
  Native Tailscale Serve has no per-rule description field, so these labels
  appear in the plugin beside the URL, rather than in `tailscale serve status`.
- Use `--stopped` to prepare a definition without starting or claiming a route.
  The UI's unchecked “Start now” option does the same. Treat removal of an
  existing launchd job as a separate human-approved cutover. Harbor's procedure
  is documented in this plugin's `harbor-migration.md`.

Run `bb dev-servers persist add --help` for all options; every command supports
`--json`. JSON list output is an array; add output is a server object. Use
`persist logs NAME --json` for an array of timestamped log records.
