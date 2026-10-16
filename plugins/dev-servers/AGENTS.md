# Dev Servers release settings

The default allocation is `portBase=5910`, `blockSize=10`, `blockCount=9`.
Fieldlabel's R2 CORS allowlist accepts HTTP origins on 5910, 5920, … 5990;
five-port blocks produce bases such as 5925 that break this integration.
Keep app servers on `{port}` and inspectors on an auxiliary slot such as
`{port+4}`.

Preserve the machine's saved plugin settings during builds, reloads, and
releases. Do not run `bb plugin config dev-servers set` as a release step.
Change saved settings only when the user explicitly requests that change.
