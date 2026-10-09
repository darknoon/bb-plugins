---
name: dev-servers
description: Start thread dev servers and manage persistent machine servers with health checks, logs, and private tailnet access.
---

# Dev servers

When starting a dev server that the user may keep running, use the Dev Servers plugin instead of a foreground shell command:

```sh
bb dev-servers start --command 'pnpm dev --port {port} --host 127.0.0.1'
```

- By default, an environment gets five consecutive ports when its first server starts.
  Ninety blocks cover 5910–6359. Permanent project checkouts
  and idle worktrees hold no block. After the last listener and managed terminal exit,
  the block is released within 15 seconds or before the next allocation. Ports can
  change after stopping every server, so always expand the placeholders again.
- The plugin settings `portBase`, `blockSize`, and `blockCount` control the allocation range.
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
- Pass `--port <number>` only when the project explicitly requires a fixed port. It bypasses the
  blocks entirely — offsets resolve against it and nothing is reserved.
- Use `bb dev-servers list` to inspect servers already running in project worktrees. Servers started another way can still be discovered, but their terminal association may be unavailable.
- Allocation checks **all TCP listeners**, including non-HTML services. A running or
  starting managed terminal holds its block before binding. An inspection failure
  keeps that lease until its state can be checked. Occupied-port errors identify the
  process, PID and linked thread (or say the thread is unknown). Stopped persistent
  definitions still reserve their fixed ports.
- Adopt an existing manually started server from its own project thread:
  `bb dev-servers adopt --port 5910 --json`. This records the thread association and
  leases its block without restarting the process or changing its lifetime. The
  process's cwd must belong to that environment, and the block must contain no
  other environment's listeners or persistent reservation. To give it automatic
  startup and crash recovery, use persistent promotion instead.
- Running blocks from the old ten-port configuration keep their full size until
  all their servers stop. New allocations use the current settings. Legacy
  explicitly saved settings are preserved; if still using them, set `blockSize` to `5` and
  `blockCount` to `90`, keeping `portBase` at `5910`.

## Persistent servers

For viewers and tools that should survive the originating thread, register a
foreground command with the machine supervisor:

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

- These commands need no project or thread. They run on the **bb server
  machine**. `--cwd` (`--server-cwd` / `--directory`) always names an absolute
  path on that machine, including when the CLI caller is on an enrolled remote
  machine. Never assume the caller's cwd is the server's cwd.
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
- Use `--stopped` to prepare a definition without starting or claiming a route.
  The UI's unchecked “Start now” option does the same. Treat removal of an
  existing launchd job as a separate human-approved cutover. Harbor's procedure
  is documented in this plugin's `harbor-migration.md`.

Run `bb dev-servers persist add --help` for all options; every command supports
`--json`. JSON list output is an array; add output is a server object. Use
`persist logs NAME --json` for an array of timestamped log records.
