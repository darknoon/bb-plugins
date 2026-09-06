# Claude Keychain guard — prefix-mini only

**Not a permanent auth fix.** This guard missed the stale-copy recurrence; error 36 was simulated, not captured during that outage.

This compatibility shim changes one result: denied reads (exit 36) of Andrew's exact Claude credential item become read failures (exit 1), so Claude's existing strict mutation aborts instead of switching stores and clearing another token.

The delegate never parses or stores credential content; all writes, deletes, successful reads, missing-item responses, and unrelated Keychain operations pass through unchanged. It records only operation type, PIDs, elapsed time and exit codes.

Installed from `/Users/andrew/Developer/bb-plugins/plugins/claude-keychain-guard` with `allThreads=true`; bb launches use `claude-guarded` on mini only. Runtime logs/state live in `/Users/andrew/.local/state/bb-claude-auth` (directory 0700, files 0600). Existing processes may retain their old PATH until normally released/restarted. SSH shells are **not configured**. No native Claude source or Keychain ACL changes.

`incident-auth-watch.cjs` runs every minute as automation `auto_3fgwutht3og` under project `proj_hn93u3x5mv`, using its own plugin identity. It logs older-file differences silently, pages on operational state changes, and allows two minutes for native refresh after expiry. It never repairs or refreshes credentials.

## Build / test

```sh
clang -Wall -Wextra -Werror security-guard.c -o bin/security
clang -Wall -Wextra -Werror guard-policy.test.c -o /private/tmp/bb-auth-guard-policy-test
/private/tmp/bb-auth-guard-policy-test
node --test security-trace.test.cjs incident-storage-261.test.cjs incident-auth-watch.test.cjs
./node_modules/.bin/tsc --noEmit
bb plugin build
bb plugin install . --yes
bb automation update auto_3fgwutht3og --project proj_hn93u3x5mv --script-file ./incident-auth-watch.cjs --interpreter node --timeout 30000
```

Owner/on-call: `thr_qgrnaqrvbx`; protected canary: `thr_rden4mbx6p` (never archive). Source characterization tests require the installed Claude 2.1.261 binary and use dummy credentials only.

Coverage is deliberately narrow: Claude 2.1.261's reproduced exit-36 bug, not stale-copy invalidation. Two real refresh cycles succeeded after recovery, which does not establish prevention.

Disable with `bb plugin disable claude-keychain-guard`, then release/restart guarded runtimes; retain this directory while installed.
