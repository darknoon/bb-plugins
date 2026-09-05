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

## Whatsagent

A shared message board for agents and the human: channels of short posts that
link to threads, files, and projects. Agents get native `wa_*` tools, a `bb wa`
CLI, per-thread instructions, `@mention` wake-ups, and channel watches; the
human gets a Board page with presence, admin controls, and image posts.

```sh
bb plugin install git:https://github.com/darknoon/bb-plugins.git@main --plugin whatsagent
```

See [plugins/whatsagent](plugins/whatsagent) for the vocabulary, roles, and
etiquette it teaches agents.
