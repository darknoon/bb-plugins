# Claude failure monitor (deployment review)

Replacement for paused automation `auto_3fgwutht3og` in `proj_hn93u3x5mv`.

- Reads Lighthouse's bb status and latest failed turn, not any credential store.
- A matching provider authentication or model-version failure posts once as `claude-auth-observer` and dispatches the existing auth canary once; the canary's failure uses bb's normal notification path. Bare HTTP 400/401 tool failures do not qualify.
- Healthy ticks are silent; pending/unknown states do not rearm an alert.
- No backup capture, Keychain API, password prompt, helper rebuild, credential repair, or expiry alarm.
- No direct missing-token reads: an empty Keychain alone is not an outage when Claude uses its file credential. The shim metadata adds immediate (next one-minute tick) alerts for withheld empty writes, denied-read remaps/timeouts, unsupported parsers and unverified callers. These are protection incidents, not proof of an invalid token. It cannot detect bypassed/native writes without reading credentials.
- Temporary bb read/CLI errors are unknown and exit zero, so they cannot trigger the scheduler's three-failure auto-pause. Unknown does not rearm alerts. Delivery or state-write failures still exit nonzero and can pause the automation; inspect those failed runs.
- Detection waits for Lighthouse to attempt a request. The one-minute schedule measures polling after failure, not time from token loss. During idle periods there is no guaranteed detection deadline; the separately managed six-hour catch-up can normally supply a request but is not an availability guarantee.

After human review and merge, replace the existing automation's stored script with this file (node interpreter, 90s timeout, existing one-minute schedule), then resume it. Keep `auth-vault-v2` non-executable. The separately reviewed updated guard may be enabled after its own permission/canary gates. Run `node scripts/claude-auth-failure-monitor.cjs --check` first; this only reads bb and reports a boolean/null, without posting or dispatching the canary.

Shim trace reading starts at EOF on first activation (no historical pages). Each intervention reason alerts once until an operator clears `interventionsSent` after investigation; healthy ticks cannot rearm it. Metadata tails are bounded to 1 MiB/tick. Log read errors mean unknown, not healthy.

## Three-hour freshness canary (also pending review/deployment)

`claude-auth-canary.cjs` sends `Auth alarm verification only: reply AUTH_OK` to the existing protected canary. It never reads credentials, calls Keychain, captures backups, logs in, or repairs. It correlates **new raw turn events** with the prompt and requires a completed exact AUTH_OK message, so an old successful reply cannot pass. A failed, busy, queued, ambiguous, or timed-out check alerts once and **halts** until an operator deliberately rearms it. A crash after dispatch also halts; it never automatically retries the model request. State/locks use 0600 files.

After merge and the explicit native-reader permission gate, install both scripts in `/Users/andrew/Developer/bb-plugins/scripts`. The scheduler copies entry scripts, so use a tiny entrypoint that executes the stable sibling-aware script rather than copying only the canary:

```sh
bb automation create --project proj_hn93u3x5mv --name 'Claude auth freshness canary' --disabled --cron '0 */3 * * *' --timezone America/New_York --host host_5e5sg5gdn4 --interpreter sh --timeout 90s --script 'exec /opt/homebrew/bin/node /Users/andrew/Developer/bb-plugins/scripts/claude-auth-canary.cjs'
```

Inspect and activate once; do not create duplicates. Record the returned automation ID. On failure, inspect the canary's actual error and the `freshness-canary.json` state. Only after a verified recovery may the operator archive the state/lock to rearm. Never rearm automatically on a timer. A three-hour request schedule does not guarantee refresh on every request or eliminate revoked refresh tokens; validate a real rotation separately. A failed canary should produce bb's ordinary thread-error push, subject to notification/read gates, plus the one plugin-identity board alert. No fabricated failed thread is created.

Tests: `node --test scripts/claude-auth-failure-monitor.test.cjs scripts/claude-auth-canary.test.cjs`.
Rollback: pause the same automation; do not resume the old credential-reading/capture script.
