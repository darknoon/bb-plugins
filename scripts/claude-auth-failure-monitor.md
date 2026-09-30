# Claude failure monitor (deployment review)

Replacement for paused automation `auto_3fgwutht3og` in `proj_hn93u3x5mv`.

- Reads Lighthouse's bb status and latest failed turn, not any credential store.
- A confirmed OAuth failure posts once as `claude-auth-observer` and dispatches the existing auth canary once; the canary's failure uses bb's normal notification path.
- Healthy ticks are silent; pending/unknown states do not rearm an alert.
- No backup capture, Keychain API, password prompt, helper rebuild, credential repair, or expiry alarm.
- Missing-token checks are intentionally absent: an empty Keychain alone is not an outage when Claude successfully uses its file credential.

After human review and merge, replace the existing automation's stored script with this file (node interpreter, 30s timeout, existing one-minute schedule), then resume it. Keep `auth-vault-v2` non-executable and the obsolete guard plugin disabled. Run `node scripts/claude-auth-failure-monitor.cjs --check` first; this only reads bb and reports a boolean/null, without posting or dispatching the canary.

Tests: `node --test scripts/claude-auth-failure-monitor.test.cjs`.
Rollback: pause the same automation; do not resume the old credential-reading/capture script.
