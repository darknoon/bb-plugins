# BB Plugins

Useful plugins for [BB](https://getbb.app).

## Dev Servers

Discover development servers running in BB worktrees, follow their linked
chats, see their ports and terminal associations, and open them through BB
Connect.

```sh
bb plugin install git:https://github.com/darknoon/bb-plugins.git@main --plugin dev-servers
```

See [plugins/dev-servers](plugins/dev-servers) for usage and current scope.

## Startup

Manage automatic bb startup on enrolled macOS hosts with a per-user
LaunchAgent, live health details in BB Settings, and an explicit handoff to
launchd supervision.

```sh
bb plugin install git:https://github.com/darknoon/bb-plugins.git@main --plugin startup
```

See [plugins/startup](plugins/startup) for usage and operational details.
