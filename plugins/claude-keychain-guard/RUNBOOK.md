# Claude OAuth hardening — October 1 review candidate

Status: proposed code, not deployed; no credential changes. Keep claude.ai OAuth
and hosted connectors. Do not substitute setup-token or inference-only auth.

## What this changes

- `claude-guarded` resolves `/Users/andrew/.local/bin/claude` at each launch and
  prepends this plugin's `bin` to PATH. It no longer pins removed 2.1.274.
- Current SDK 0.5.29 contribution returns only name/value/reason for
  `BB_CLAUDE_CODE_EXECUTABLE`; no removed `secret` property. Enable `allThreads`
  only after review. The host restriction remains prefix-mini.
- For **verified native callers**, the filter withholds the exact empty-string
  OAuth cleanup write while primary tokens are populated (also on unknown reads).
  Native's tested 2000ms timeout classifies it as transient. Returning ordinary
  failure is unsafe: the extracted code then empties the file and deletes primary.
- Verified 2.1.285 native-code tests cover cleanup, stale generation, timeout,
  ordinary failure, populated writes, logout and the read-failure sentinel.
- Reads of the exact account/service map exit 36 to 1, time out after 1500ms,
  and back off for 30s after denial/timeout. Logs contain fixed metadata only.
- Unknown versions keep native writes unchanged and emit `unverified-caller`;
  they are **not protected against the cleanup write**. PR #2 consumes this
  metadata and latches an alert. Add extracted-code tests before verifying a
  future version. Do not silently pin an obsolete runtime to extend protection.
- No backup checkpoint executes from the shim. `auth-vault-v2` is retired as a
  background executable; keep existing encrypted items/history untouched.

## Limits that matter

Preserving tokens is not renewing or validating them. A revoked refresh token
can remain on disk but fail every request. A three-hour canary is evidence of
actual request health, not proof that revocation cannot happen. Its timing is a
mitigation hypothesis, not a proven fix for the failed refresh.

PATH does not intercept absolute `/usr/bin/security` calls, native Security
framework accesses, existing workers with an older environment, or SSH sessions.
Bounds/backoff reduce repeated reads but do not make an unauthorized first read
prompt-free. Resolve native-reader permission explicitly before a fresh canary;
do not alter ACLs or start a process merely because `security` can read.

The observer is credential-free. It can immediately report a **withheld attempted
populated-to-empty write**, but cannot observe every native/bypassed store change
without reading credentials. Actual failed requests are its independent signal.

## Review and deployment gate

Only deploy commits merged into main after Andrew's approval. Do not restart
bb-app, rebuild a Keychain-authorized helper, touch ACLs, or run a login.

1. Merge this change and PR #2; preserve unrelated edits in the live checkout.
2. Build from the merged sources:

   ```sh
   clang -Wall -Wextra -Werror -DBB_ENABLE_WRITE_GUARD=1 security-guard.c -o bin/security
   ./node_modules/.bin/tsc --noEmit
   bb plugin build
   ```

3. Install/enable from the stable repository path, then set `allThreads=true`.
   Start the merged credential-free monitor independently of retired capture.
4. After credential repair and the native-reader permission gate, use a **new**
   bb canary runtime without restarting bb-app. Verify its provider environment
   contribution and process executable. Read `ps -E` only into a sanitizer that
   prints PID, executable and PATH's first entry; never print the environment.
   First PATH entry must be the stable plugin's `bin` directory. A dummy launcher
   test is not a substitute for this live check.
5. One fresh canary request must return AUTH_OK with hosted connectors available.
   Check again after real refresh; do not call ordinary access-token success a
   refresh validation. Stop on failure, without retry loops.

Current test commands:

```sh
node --test empty-write.test.cjs native-285.test.cjs security-trace.test.cjs launcher.test.cjs
clang -Wall -Wextra -Werror guard-policy.test.c -o /private/tmp/bb-auth-guard-policy-test
/private/tmp/bb-auth-guard-policy-test
bb plugin build
node --test provider-contract.test.mjs
```

The legacy untracked read-selector suites were also run offline (19 passing);
they are not part of this release and substitution stays compile-time disabled.

## Recovery: account and store boundaries

On this host, use `claude auth login` in **Terminal.app on prefix-mini via Screen
Sharing** when Andrew chooses login. The observed SSH login wrote only
`/Users/andrew/.claude/.credentials.json`; bb still preferred the empty Keychain
record. Do not generalize that every SSH login behaves identically on every Mac.

The reviewed stdin repair script can copy a validated file login's
`claudeAiOauth` into the existing empty primary using `/usr/bin/security -i`.
It preserves connector fields and does not edit the partition list. Re-run its
dry-run and require Andrew's explicit go before `--apply`:

```sh
node /Users/andrew/.bb/personal-workspaces/env_d8q42fpwem/incident-repair-keychain.cjs --dry-run
# ONLY after the explicit repair approval:
node /Users/andrew/.bb/personal-workspaces/env_d8q42fpwem/incident-repair-keychain.cjs --apply
```

Never write `Claude Code-credentials` through an ad-hoc-signed compiled helper.
Never delete the fallback or primary to simplify diagnosis. Saved tokens do not
constitute tested recovery, and expired access does not prove refresh validity.
