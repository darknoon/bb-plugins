# Slack ↔ bb — design

Proposal. Nothing built, nothing created in Slack.
Thread: thr_4zpxseuncs. Origin: @andrew, #papercuts 528.

## Shape

Slack app → Socket Mode → thin bridge plugin → one standing **receptionist**
thread → **connects** an agent to the Slack thread → that agent reads and
answers in Slack directly.

- **Receptionist** is bb-level, one per workspace, never spawned per mention —
  every mention lands in the same conversation, so it sees duplicates, knows
  who already took what, and reads two channels as one situation.
- **Connection** is the primitive: `(slack channel, thread_ts) ↔ thr_…`,
  created by the receptionist. Once connected, that Slack thread bypasses
  triage entirely in both directions. Revocable; the agent can hand back.
- **Roster** is Whatsagent: handles, presence, current work. A directory the
  receptionist reads, not a transport. Nothing routes through the board.

Messages cross intact — no length limit anywhere in the path.

## Slack objects to create

One app, six objects. Andrew or Jeff creates them; no agent touches the
workspace.

| # | Object | Where |
| --- | --- | --- |
| 1 | Slack app | api.slack.com/apps → *From an app manifest* (I supply the YAML) |
| 2 | Bot user | manifest `features.bot_user` — the thing people `@` |
| 3 | Bot token `xoxb-` | *Install to Workspace* |
| 4 | App-level token `xapp-` + `connections:write` | Basic Information → App-Level Tokens; Socket Mode only |
| 5 | Event subscription `app_mention` | no Request URL under Socket Mode |
| 6 | `/invite @bb` in one channel | scoping is by invitation |

Scopes: `app_mentions:read`, `chat:write`, `users:read`, `channels:read`;
`chat:write.customize` to post under each agent's own name.
Not needed: incoming webhook, public URL, signing-secret HMAC.

## Why Socket Mode

Outbound WebSocket, so bb needs no public hostname — decisive on a tailnet with
getbb.app out. Events API would need a reachable Request URL plus HMAC
verification. An incoming webhook can't receive mentions at all.

`bb.background.service` holds the socket with capped backoff on Node 22's global
`WebSocket`. Missing tokens → `bb.status.needsConfiguration`. No backlog: events
during downtime are lost, which is fine for a wake-up path.

## Mechanics

- **Inbound, unbound:** `threads.send` into the receptionist, `mode: "auto"` so
  a mention arriving mid-turn queues instead of racing. Plugin drops 👀 on the
  Slack message immediately, so an ack never waits on a triage turn.
- **Inbound, connected:** `threads.send` straight to the connected thread.
- **Outbound:** auto-relay of `thread.idle`'s `lastAssistantText` for connected
  threads, plus `slack_say(text)` for a deliberate mid-turn reply. No ref
  argument — the connection names the destination. `bb.agents.configure` exposes
  the tool only to connected threads.
- **Attribution:** replies post via `chat:write.customize` as `lighthouse · bb`
  with a context line `handle · model · thr_…`. Avatars don't cross; Slack
  fetches `icon_url` itself and can't reach the tailnet.
- **Open items:** the plugin keeps a table (slack ref, asker, assigned thread,
  status) injected as instructions each turn, so a compacted receptionist still
  starts from ground truth.

## Secrets

Both tokens requested with the `bb-global-skills:secrets` skill into a
gitignored dotenv, never shown to an agent, then held in `secret: true` plugin
settings (0600, never in the db, never sent to the frontend).

## Slices

1. **Inbound only.** Mentions reach the receptionist, it answers on bb. Nothing
   is written into Fieldwork — zero blast radius on Jeff's workspace, while
   Socket Mode, tokens, and triage all get proven.
2. **Connect + answer.** Connections, `slack_say`, replies land in the Slack
   thread under the agent's name.
3. **Polish.** Hand-back, `/bb who`, board mirror of who took what.

## Open

- Which channel bridges first; does Jeff approve the install?
- Can the receptionist spawn a thread when nobody fits, or does it decline?
- Bot display name.
