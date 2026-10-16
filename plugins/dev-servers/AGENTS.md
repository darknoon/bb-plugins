# Dev Servers release settings

The default allocation is `portBase=5910`, `blockSize=10`, `blockCount=9`.
Fieldlabel's R2 CORS allowlist accepts HTTP origins on 5910, 5920, … 5990;
five-port blocks produce bases such as 5925 that break this integration.
Keep app servers on `{port}` and inspectors on an auxiliary slot such as
`{port+4}`.

Keep Vite on its allocated port: use `--strictPort` in wrapper scripts that
the start command cannot identify automatically. Never rely on Vite selecting
the next available port. Use `bb dev-servers stop` or `bb terminal close` to
stop a managed thread server, and `bb dev-servers release` for idle leases.
Automatic starts require `{port}`; hard-coded 59xx command ports require an
explicit `--port`. The plugin manages private base-port Serve rules, audits
unmanaged listeners every two minutes and expires stopped leases after
`idleReleaseMinutes` (default 2). Let it request releases under scarcity;
never kill another thread's process. Do not create Connect/Funnel exposure or
touch VNC's 5900–5909 rules.

Preserve the machine's saved plugin settings during builds, reloads, and
releases. Do not run `bb plugin config dev-servers set` as a release step.
Change saved settings only when the user explicitly requests that change.
