# Claude Keychain guard — prefix-mini only

**Not a permanent auth fix.** This guard missed the stale-copy recurrence; error 36 was simulated, not captured during that outage.

Unreleased candidate: `read-selector.cjs` selects newer file OAuth after account verification; it remains **disabled**, including at compile time in production. Do not enable it without the approval previously requested.

This compatibility shim changes one result: denied reads (exit 36) of Andrew's exact Claude credential item become read failures (exit 1), so Claude's existing strict mutation aborts instead of switching stores and clearing another token.

The delegate passes credential operations through unchanged apart from that exit-code mapping; its logs contain only operation type, PIDs, elapsed time and exit codes. Since September 12 it also invokes `auth-vault checkpoint` before and after writes/deletes, with a 350ms deadline per checkpoint. Backup failure does not block Claude's write.

Installed from `/Users/andrew/Developer/bb-plugins/plugins/claude-keychain-guard` with `allThreads=true`; bb launches use `claude-guarded` on mini only. Runtime logs/state live in `/Users/andrew/.local/state/bb-claude-auth` (directory 0700, files 0600). Existing processes may retain their old PATH until normally released/restarted. SSH shells are **not configured**. No native Claude source or Keychain ACL changes.

`incident-auth-watch.cjs` runs every minute as `auto_3fgwutht3og` in `proj_hn93u3x5mv`, taking an encrypted checkpoint and recording metadata. It alerts once on backup failure/not-ready, or eight hours of harmful divergence. Ordinary expiry and stale-file differences stay silent. It does not refresh, restore, or test model requests.

## Encrypted backup — deployed September 12

`auth-vault.m` retains eight complete records per store in the separate Keychain item `bb-Claude-auth-recovery-v1`; empty records cannot replace that history. Connector fields are included. A private lock serializes backup writers; secrets never enter logs or process arguments. `bin/auth-vault status` prints timestamps only; checkpoint exit 78 means **no credentials captured**, not protection.

Both real stores were already empty at first capture, so no usable backup existed at deployment. A new login must be captured before this protects access. A real dummy-Keychain snapshot/wipe/restore test passed; production restoration is **not automated**. Revoked refresh tokens, Keychain loss/lock, bypassed wrappers, or failed checkpoints remain limitations. Retained backups must never silently reverse logout or an account change.

## Build / test

```sh
clang -Wall -Wextra -Werror security-guard.c -o bin/security
clang -fobjc-arc -fblocks -Wall -Wextra -Werror -Wno-deprecated-declarations -framework Foundation -framework Security auth-vault.m -o bin/auth-vault
bin/auth-vault selftest
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
