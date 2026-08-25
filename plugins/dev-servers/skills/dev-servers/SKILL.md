---
name: dev-servers
description: Start and inspect project dev servers in BB worktrees while preserving port and terminal associations.
---

# Dev servers

When starting a dev server that the user may keep running, use the Dev Servers plugin instead of a foreground shell command:

```sh
bb dev-servers start --command 'pnpm dev --port {port} --host 127.0.0.1'
```

- By default, each worktree owns a block of 10 consecutive ports, held for as long as the worktree
  exists. Nine blocks start at 5910 (5910-5919, 5920-5929, …, 5990-5999). Port 5900 is excluded.
- The plugin settings `portBase`, `blockSize`, and `blockCount` control the allocation range.
- `{port}` is the block's base — use it for the app's dev server. `{port+1}`, `{port+2}` … are the
  other slots in the same block; run a second service in the worktree on one of those rather than
  picking a number. An offset equal to or larger than the configured block size is an error, not a
  silent overrun into the next worktree.
- Pass `--port <number>` only when the project explicitly requires a fixed port. It bypasses the
  blocks entirely — offsets resolve against it and nothing is reserved.
- Use `bb dev-servers list` to inspect servers already running in project worktrees. Servers started another way can still be discovered, but their terminal association may be unavailable.
