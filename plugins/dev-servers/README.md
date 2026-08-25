# Dev Servers for BB

Discover HTML development servers running in BB worktrees and open them from
BB's left sidebar. Each row shows the project, branch, port, process, and its
associated BB terminal when one can be identified.

Agents can start a server in a BB terminal with a stable port block:

```sh
bb dev-servers start --command 'pnpm dev --port {port} --host 127.0.0.1'
```

Use `{port+1}` through `{port+9}` for additional services in the same
worktree.

## Current scope

- Discovery runs on the BB server host and currently uses macOS `lsof` and
  `ps`.
- Only listeners serving HTML from known BB project environments are shown.
- Open links use BB Connect. The viewer must be signed into the BB owner's
  account.

## Install

From the plugin directory:

```sh
npm install
bb plugin install .
```

## Development

```sh
bb plugin dev
```

Saving a source file rebuilds and reloads the plugin while this command is
running.
