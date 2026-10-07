# Harbor viewer cutover on prefix-mini

The existing viewer is `com.fieldwork.harbor-view`, running on loopback 5995
with a private Tailscale HTTPS rule. Keep this job and its plist until Andrew
explicitly authorizes removing them. Production installation must use merged
code; an open PR is verified with an isolated bb instance instead.

## Prepare after merge

Build/install the merged Dev Servers plugin, preserving its existing storage
and settings. Register Harbor stopped so its existing process is undisturbed:

```sh
bb dev-servers persist add --name harbor \
  --cwd /Users/andrew/Developer/fieldeval-jobs \
  --command '/Users/andrew/.local/bin/harbor view /Users/andrew/Developer/fieldeval-jobs --jobs --host 127.0.0.1 --port {port}' \
  --port 5995 --health-body 'window.__reactRouterContext' \
  --tailnet --adopt-tailnet-rule --stopped
```

Port 5995 must be outside every live worktree allocation. Registering it
reserves that port and excludes the 5990–5999 block from future allocation.
If a live block already owns 5995, resolve that allocation first; do not steal
it or change settings to hide the conflict.

Before cutover, compare a supervised preview on a free 5901–5909 port with
both `http://127.0.0.1:5995/` and
`https://prefix-mini.tail06618c.ts.net:5995/`, including the HTML and at least
one application API response. Exercise Restart, Stop/Start, crash recovery,
and bb shutdown/startup. Use a temporary **owned** rule for preview tailnet
access; remove its definition and verify that only its rule disappears.

Harbor's installed fixed-port probe binds a socket without `SO_REUSEADDR`.
In the live preview, some shutdowns caused short-lived “No available port”
exits before backoff recovered it. Allow up to a minute for a cutover to reach
healthy state; use status and logs to distinguish retrying from a failed
response. Health probes close their own sockets promptly so they do not leave
idle pooled connections behind.

## Only after Andrew authorizes LaunchAgent removal

On prefix-mini:

```sh
launchctl bootout gui/$(id -u)/com.fieldwork.harbor-view
rm ~/Library/LaunchAgents/com.fieldwork.harbor-view.plist
bb dev-servers persist start harbor
bb dev-servers persist list --json
bb dev-servers persist logs harbor --lines 40
curl --fail --max-time 15 https://prefix-mini.tail06618c.ts.net:5995/
```

The new supervisor takes ownership of the identical existing private proxy
after Harbor passes its health check. Verify the running state, matching
viewer HTML/API responses, and recovery after a supervised restart. This is
the point at which 5995 is genuinely served by the persistent server; a
successful request before cutover still belongs to the LaunchAgent.

Preserve the original plist before removal for rollback. If the persistent
viewer fails, stop it, restore the saved plist, bootstrap the LaunchAgent,
and restore its private 5995 proxy if supervisor cleanup removed it. Never
enable public Funnel or BB Connect as a fallback.
