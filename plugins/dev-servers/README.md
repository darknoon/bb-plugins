# Dev Servers for BB

Discover HTML development servers running in BB worktrees and preview them in
BB. Each row shows the project, worktree, linked chat, port, process, and its
associated BB terminal when one can be identified.

- In a thread, choose **New tab → Open dev server** to pick a running server
  and replace the chooser with a live preview and URL bar in that panel tab.
- On the Dev Servers page, **Open** navigates to the server's linked chat and
  opens that server beside it. The adjacent menu copies the URL or opens it in
  an external browser.

Agents can start a server in a BB terminal with a stable port block:

```sh
bb dev-servers start --command 'pnpm dev --port {port} --host 127.0.0.1'
```

Use `{port+1}` through `{port+9}` for additional services in the same
worktree.

## Port blocks

The defaults allocate nine 10-port blocks starting at 5910. Configure the
first port, ports per worktree, and worktree-block count in BB's plugin
settings, or from the CLI:

```sh
bb plugin config dev-servers set portBase 5910
bb plugin config dev-servers set blockSize 10
bb plugin config dev-servers set blockCount 9
```

Changing the range invalidates saved allocations that no longer match it.

## Current scope

- Discovery runs on the BB server host and currently uses macOS `lsof` and
  `ps`.
- Only listeners serving HTML from known BB project environments are shown.
- When BB is opened through a Tailscale `*.ts.net` origin and Tailscale Serve
  already exposes a server's HTTPS port, previews use that Tailnet URL. This
  avoids a second sign-in and keeps access inside the Tailnet.
- Other clients fall back to BB Connect. The viewer must be signed into the BB
  owner's account. A server that sets restrictive iframe headers may still
  require the external-browser action.

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
