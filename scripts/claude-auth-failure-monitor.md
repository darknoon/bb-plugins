# Claude failure monitor (deployment review)

Replacement for paused automation `auto_3fgwutht3og` in `proj_hn93u3x5mv`.

- Reads Lighthouse's bb status and latest failed turn, not any credential store.
- A matching provider authentication or model-version failure posts once as `claude-auth-observer` and dispatches the existing auth canary once; the canary's failure uses bb's normal notification path. Bare HTTP 400/401 tool failures do not qualify.
- Healthy ticks are silent; pending/unknown states do not rearm an alert.
- No backup capture, Keychain API, password prompt, helper rebuild, credential repair, or expiry alarm.
- Missing-token checks are intentionally absent: an empty Keychain alone is not an outage when Claude successfully uses its file credential.
- Temporary bb read/CLI errors are unknown and exit zero, so they cannot trigger the scheduler's three-failure auto-pause. Unknown does not rearm alerts. Delivery or state-write failures still exit nonzero and can pause the automation; inspect those failed runs.
- Detection waits for Lighthouse to attempt a request. The one-minute schedule measures polling after failure, not time from token loss. During idle periods there is no guaranteed detection deadline; the separately managed six-hour catch-up can normally supply a request but is not an availability guarantee.

After human review and merge, replace the existing automation's stored script with this file (node interpreter, 30s timeout, existing one-minute schedule), then resume it. Keep `auth-vault-v2` non-executable and the obsolete guard plugin disabled. Run `node scripts/claude-auth-failure-monitor.cjs --check` first; this only reads bb and reports a boolean/null, without posting or dispatching the canary.

Tests: `node --test scripts/claude-auth-failure-monitor.test.cjs`.
Rollback: pause the same automation; do not resume the old credential-reading/capture script.
