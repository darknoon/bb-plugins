# Claude Keychain guard — prefix-mini only

**October 1 review candidate — not deployed.** The current instructions and limitations are in [RUNBOOK.md](RUNBOOK.md). It replaces the removed `.274` pin with a per-launch resolution of the current Claude symlink, verifies `.285`'s native cleanup/read paths, bounds reads with a 30-second failure backoff, and retires backup checkpoints. The SDK is now 0.5.29. Read selection remains disabled. Merge/review and a no-prompt live canary are required before claiming protection.

Everything below is a **historical incident journal**, not current configuration or deployment instructions. In particular, do not run the old backup/install commands below.

**September 18:** single failed backup captures no longer page; three failures spanning at least two minutes alert once until a successful capture. Empty initial backups and confirmed Lighthouse auth failures still alert immediately. Current snapshots are readable and include the 21:32 refresh. Capture retries succeeded, but exit 74 does not identify the underlying intermittent failure. No vault executable or primary credential changes in this alert-policy fix; automatic restoration remains absent.

**September 17: outage still open.** bb rejected the plugin's removed `secret` field, so Claude ran without the wrapper; both live stores are now empty. Removed that field, updated SDK types to 0.4.87, reloaded, and verified a fresh probe executes guarded reads (authentication still fails). No verified attribution of the clearing process.

bb now uses tested 2.1.274 directly, not the auto-updating symlink; 2.1.273/274 native cleanup regressions pass. The observer pages once on Lighthouse's actual auth failure or two minutes of missing primary tokens, independently of backup errors; ordinary expiry stays silent.

Created **`bb-Claude-auth-recovery-v2`**, account `andrew`, using immutable `bin/auth-vault-v2`; initialization/readback and a dummy encrypted wipe/restore passed, but there are **zero real snapshots** until credentials return. The minute observer and guard checkpoints now use v2. Existing v1 and Claude items were not changed. Never rebuild/replace a vault executable after granting access; use a new explicitly approved labeled item/helper for future revisions. Old v1 recovery still requires macOS consent; no automatic restoration is enabled.

**Not a permanent auth fix.** This guard missed the stale-copy recurrence; error 36 was simulated, not captured during that outage.

**September 14, second mitigation deployed:** verified Claude 2.1.261/270 callers cannot overwrite populated OAuth tokens with the empty-string cleanup record. The filter withholds that exact write until Claude's 2s timeout marks it transient; ordinary exit-1 would instead wipe the file and delete Keychain. Unknown callers/versions, normal refresh writes, OAuth removal, and logout pass through. This preserves records, **not revoked-token validity**. Lighthouse authenticated after deployment with Figma/Notion visible; 51 focused tests passed.

Three blocked writes within 30 minutes trigger one real request on protected visible alarm thread `thr_bn2xraubgc`; its genuine auth failure uses bb's existing mobile push path. This is not a general direct-push API, and phone delivery is still subject to bb's read/coalescing rules. A quiet 30-minute interval rearms the alarm. No test failure was injected into production.

**September 14: access restored; backup capture broken.** Copied the validated new file login into the empty Keychain; lighthouse returned `AUTH_OK` and annex thread `thr_5wv4ecfhj8` completed its retry. Lighthouse watches remain off.

The vault captured the new file token, but native reads of Claude's item returned `-25293` even with the login Keychain explicitly selected. The bounded `/usr/bin/security` reader candidate passes five tests. Replacing the helper then made its existing backup item unreadable (exit 74); rebuilding the prior source did not restore access. Neither backup item nor ACL was changed. **Do not rely on capture or overwrite/delete that backup.** Candidate: `auth-vault-primary-candidate.m`; fix stable helper identity/access before deploying again. These changes are uncommitted and unpushed.

Unreleased candidate: `read-selector.cjs` selects newer file OAuth after account verification; it remains **disabled**, including at compile time in production. Do not enable it without the approval previously requested.

This compatibility shim changes one result: denied reads (exit 36) of Andrew's exact Claude credential item become read failures (exit 1), so Claude's existing strict mutation aborts instead of switching stores and clearing another token.

The delegate also logs fixed write-policy decisions and token-presence booleans, never payloads. Since September 12 it invokes `auth-vault checkpoint` before and after writes/deletes, with a 350ms deadline per checkpoint. Backup failure does not block Claude's write.

Installed from `/Users/andrew/Developer/bb-plugins/plugins/claude-keychain-guard` with `allThreads=true`; bb launches use `claude-guarded` on mini only. Runtime logs/state live in `/Users/andrew/.local/state/bb-claude-auth` (directory 0700, files 0600). Existing processes may retain their old PATH until normally released/restarted. SSH shells are **not configured**. No native Claude source or Keychain ACL changes.

`incident-auth-watch.cjs` runs every minute as `auto_3fgwutht3og` in `proj_hn93u3x5mv`, taking an encrypted checkpoint and recording metadata. It alerts once on backup failure/not-ready, or eight hours of harmful divergence. Ordinary expiry and stale-file differences stay silent. It does not refresh, restore, or test model requests.

## Encrypted backup — deployed September 12

`auth-vault.m` retains eight complete records per store in the separate Keychain item `bb-Claude-auth-recovery-v1`; empty records cannot replace that history. Connector fields are included. A private lock serializes backup writers; secrets never enter logs or process arguments. `bin/auth-vault status` prints timestamps only; checkpoint exit 78 means **no credentials captured**, not protection.

Both real stores were already empty at first capture, so no usable backup existed at deployment. A new login must be captured before this protects access. A real dummy-Keychain snapshot/wipe/restore test passed; production restoration is **not automated**. Revoked refresh tokens, Keychain loss/lock, bypassed wrappers, or failed checkpoints remain limitations. Retained backups must never silently reverse logout or an account change.

## Build / test

```sh
clang -Wall -Wextra -Werror -DBB_ENABLE_WRITE_GUARD=1 security-guard.c -o bin/security
clang -fobjc-arc -fblocks -Wall -Wextra -Werror -Wno-deprecated-declarations -framework Foundation -framework Security auth-vault.m -o bin/auth-vault
bin/auth-vault selftest
clang -Wall -Wextra -Werror guard-policy.test.c -o /private/tmp/bb-auth-guard-policy-test
/private/tmp/bb-auth-guard-policy-test
node --test empty-write.test.cjs block-alert.test.cjs security-trace.test.cjs incident-storage-261.test.cjs incident-auth-watch.test.cjs
./node_modules/.bin/tsc --noEmit
bb plugin build
bb plugin install . --yes
bb automation update auto_3fgwutht3og --project proj_hn93u3x5mv --script-file ./incident-auth-watch.cjs --interpreter node --timeout 30000
```

Owner/on-call: `thr_qgrnaqrvbx`; protected canary: `thr_rden4mbx6p` (never archive). Source characterization tests require the installed Claude 2.1.261 binary and use dummy credentials only.

Coverage remains narrow: empty-token record preservation cannot make a revoked refresh token valid. `auth-vault-primary-candidate.m authorize-backup` is prepared but not installed: only explicit human approval may open its macOS prompt for `bb-Claude-auth-recovery-v1`; background operations must never prompt. Retain old encrypted backup history. Never use `-A` or relax Claude's own item permissions.

Disable with `bb plugin disable claude-keychain-guard`, then release/restart guarded runtimes; retain this directory while installed.
