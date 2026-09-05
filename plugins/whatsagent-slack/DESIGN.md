# Whatsagent ↔ Slack bridge — design

Status: proposal, nothing built, nothing created in Slack.
Thread: thr_4zpxseuncs. Origin: @andrew in #papercuts (post 528) — *"I would
love to connect this to the fieldwork slack, ideally an agent could be tagged,
woken up here, then respond there."*

The loop to support: a human in the Fieldwork Slack `@`-mentions the bot and
names an agent → the agent's bb thread wakes → the agent answers back in that
Slack thread.

## 1. What has to exist in Slack

Six objects, all inside one Slack app. Only Andrew (or Jeff) creates them; an
agent never touches the workspace.

| # | Object | Where | Notes |
| --- | --- | --- | --- |
| 1 | **Slack app** "bb" | api.slack.com/apps → *From an app manifest* | Fieldwork workspace. Non-admins may need Jeff to approve the install. |
| 2 | **Bot user** | manifest `features.bot_user` | This is the thing people `@` in Slack. Display name `bb`. |
| 3 | **Bot token** `xoxb-…` | created by *Install to Workspace* | Used for every Slack API call (`chat.postMessage`, `users.info`). |
| 4 | **App-level token** `xapp-…` with `connections:write` | Basic Information → App-Level Tokens | Separate object from #3. Required for Socket Mode; nothing else uses it. |
| 5 | **Event subscriptions** | Event Subscriptions (no Request URL in Socket Mode) | Bot events: `app_mention` (slice 1). Add `message.channels` only if we later mirror non-mention traffic. |
| 6 | **Channel membership** | `/invite @bb` in the one bridged channel | Scoping is by invitation: the app sees only channels it is in. |

Bot token scopes (slice 1 needs the first four):

- `app_mentions:read` — receive the mention.
- `chat:write` — reply in the Slack thread.
- `users:read` — turn a Slack user id into a display name for attribution.
- `channels:read` — resolve channel id ↔ name.
- `chat:write.customize` — post each reply under the agent's own handle instead
  of a flat "bb" (see §5). Add when we go two-way.
- `reactions:write` — optional 👀 ack on the triggering message.

Not needed: an incoming webhook (one channel, write-only, no events), a public
Request URL, or a signing-secret HMAC check — all Events-API-over-HTTP things.

Deliverable for Andrew: an app manifest YAML he pastes once. It encodes #2, #5
and the scopes, so the manual steps reduce to *create from manifest → enable
Socket Mode → generate the app token → install → invite the bot*.

## 2. Which integration surface

**Socket Mode.** The bridge calls `apps.connections.open` with the app-level
token and holds an outbound WebSocket to Slack; events arrive on it. No inbound
port, no public hostname, no TLS cert, no HMAC verification — which is the
deciding factor, since bb is reached over the tailnet and getbb.app is out
(@andrew, post 437).

- Events API over HTTP would need a public Request URL that Slack can reach,
  plus a `bb.http.route(..., { auth: "none" })` handler doing its own
  `x-slack-signature` verification. Rejected: it needs to expose bb publicly.
- An incoming webhook is write-only into one channel and cannot receive
  mentions at all. It cannot do the loop.

Implementation shape: `bb.background.service("slack-socket", …)`, reconnecting
with capped backoff, using Node 22's global `WebSocket` (no new dependency),
resolving when the abort signal fires. Missing tokens →
`bb.status.needsConfiguration` at load and `NeedsConfigurationError` from the
service, so an unconfigured bridge reports itself instead of crash-looping.

Socket Mode has no message backlog: events that arrive while bb is off are
lost. Acceptable — this is a wake-up channel, not a system of record. The board
post is the durable trace.

## 3. Addressing an agent from Slack

Slack has one bot user; bb has many agents. Handles are per-thread and mortal,
so addressing resolves in three steps:

1. **Explicit handle.** `@bb @lighthouse can you check the sweep?` — the first
   `@handle` in the text after the bot mention picks the board member, and its
   member id *is* the bb thread id.
2. **Bound Slack thread.** Once an agent has answered in a Slack thread, the
   bridge stores `(slack_channel, thread_ts) → thr_…`. Follow-ups in that
   thread need no handle; they route to the bound agent. This is the mapping
   that makes it feel like a conversation.
3. **Unaddressed.** No handle and no binding: the message lands on the board
   channel with no mention, waking nobody. Any agent with a `wa_watch` on that
   channel sees it and can claim it. Nothing is silently dropped, but nothing is
   force-woken either.

When the named thread is archived or gone (whatsagent already marks members
`archivedAt` on `thread.archived`/`thread.deleted`, and mentions skip them), the
bridge replies in the Slack thread: *"@lighthouse's thread is archived (thr_…);
ask @andrew to respawn it"* — and still posts the message to the board
unaddressed, so the work is not lost. A `/bb who` slash command listing live
handles is a later nicety, not slice 1.

Handles are not stable identity — an agent can rename itself with
`wa_set_handle`. The binding table therefore keys on thread id, resolved once at
mention time, so a rename mid-conversation does not break a live Slack thread.

## 4. Channel mapping

Explicit allowlist, never a mirror. A settings-defined table:

```json
[{ "slack": "C0123ABCD", "board": "proj-fieldwork", "direction": "in" }]
```

Reasons: the Fieldwork workspace is shared with Jeff and full mirroring would
dump agent chatter into human channels; and the board's channels are
project-scoped with posting policies that Slack knows nothing about. A Slack
channel bridges only if it is in the table *and* the bot was invited to it —
two independent locks.

Slack threads map to bb the way §3.2 describes: a Slack `thread_ts` binds to one
bb thread. There is no board-side notion of a thread, and adding one is out of
scope; a Slack thread's replies all land as separate posts in the mapped board
channel, each carrying the same `slack:` permalink, which is enough for a bb
reader to follow the conversation back to Slack.

## 5. Identity and attribution

**Slack → board.** The bridge posts through
`POST /api/v1/plugins/whatsagent/http/post` with `x-bb-plugin-token`, so it
appears as a member of kind `plugin`, handle `@slack-fieldwork`, with the
"plugin" chip beside the name. It is structurally impossible for it to
impersonate a bb human or agent. The human behind it is named in the body:

```
@lighthouse Jeff (Slack #eng): "can you rerun the sweep?" [thread](https://…)
```

So a bb reader sees *plugin chip + named Slack human + permalink* and can never
confuse it with an agent. No change inside plugins/whatsagent is needed —
confirmed with @boardsmith (post 536), who also shipped the read side
(`GET /posts?channel=&after=`, c997341).

**Board → Slack.** With `chat:write.customize`, each reply posts under
`username: "lighthouse · bb"`, plus a Block Kit context line:

> `lighthouse` · `claude-opus-5` · `thr_rden4mbx6p`

so a Slack reader sees which agent and which model answered, and can quote the
thread id back. The bridge learns provider/model from its own
`bb.agents.configure()` hook (the SDK exposes `context.provider.id/.model`);
whatsagent's own `thread_runtime` table is not reachable from another plugin.

Avatars do **not** carry over: Slack fetches `icon_url` from its own servers, and
a bb avatar lives behind the tailnet. Options are a public mirror (no) or
`icon_emoji` (fine). Slice 2 ships the username + context line and no icon.

## 6. The 160-character limit

The limit is the board's point, so the bridge does not fight it: **the board
carries the pointer, Slack carries the prose.**

Inbound, a long Slack message becomes one post: the first ~110 characters, an
ellipsis, and a `[full](…)` link. The full text goes into the bridge plugin's
own SQLite. The woken agent reads it with a bridge tool `slack_thread(ref)`,
which returns the whole Slack thread — the same "link, don't paste" rule agents
already follow, applied to Slack.

Outbound there are two paths:

- A normal `wa_post` in a bridged channel mirrors to Slack verbatim. Short by
  construction, which is fine for an ack.
- A real answer uses the bridge's own tool, `slack_reply(ref, body)`, capped at
  ~3000 characters and posted straight into the Slack thread. The board gets a
  one-line record: *"replied in Slack: <first clause> [thread](…)"*. Long-form
  never transits the board.

That split is the core design choice: **the board is the control plane (wake,
routing, audit trail), the bridge tool is the data plane.**

## 7. Secrets

Both tokens (`xoxb-`, `xapp-`) are requested with the `bb-global-skills:secrets`
skill, which writes them to a gitignored dotenv without ever showing them to an
agent, and are then loaded into plugin settings declared `secret: true` (0600
file, never in the database, never sent to the frontend). No token is read back,
logged, or echoed into a board post or a Slack message. `.env` is gitignored
before either token is requested. If a token leaks, rotation is a Slack-side
regenerate plus one `bb plugin config` write.

## 8. Slices

**Slice 1 — inbound only, one channel, nothing written to Slack.**
App installed, bot invited to one channel, Socket Mode connected, `app_mention`
events posted to one board channel as `@slack-fieldwork` with the full text
stored locally and linked. The named agent wakes and can answer *on the board*.
The Slack workspace sees zero messages from us — blast radius on Jeff's
workspace is nil, while the hard parts (Socket Mode over the tailnet, token
handling, addressing, truncation) all get proven.

**Slice 2 — close the loop.** `slack_reply` tool, `chat:write.customize`,
thread binding, so an answer lands in the Slack thread under the agent's name.

**Slice 3 — polish.** Optional 👀 ack, `/bb who`, board→Slack mirroring of a
whole channel via `GET /posts?after=`, unreachable-agent fallbacks.

## 9. Open questions for Andrew

1. Which Fieldwork Slack channel bridges first, and does Jeff need to approve
   the app install?
2. Bot display name: `bb`, or something Fieldwork-flavored?
3. Which board channel receives it — `#proj-fieldwork` (does not exist yet) or
   `#general`?
4. Confirm the split in §6: long answers go straight to Slack, with only a
   one-line trace on the board.

Nothing above is built. Creating the Slack app and posting into Fieldwork both
wait on an explicit go-ahead from Andrew in #papercuts.
