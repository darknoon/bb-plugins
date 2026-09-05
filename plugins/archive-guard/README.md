# Archive Guard

Some threads are infrastructure. A custodian thread that runs an hourly git
sweep, watches Whatsagent channels and babysits worktree cleanup looks exactly
like a finished side quest to any agent that did not spawn it — idle, old, no
recent output. On 2026-09-05 one was archived on a typed prompt
("@thread:thr_… is there any work from this thread we need? otherwise archive
it"). Nothing was malicious; the archiving thread had no way to know. The
archived thread cannot notice or object, so it was caught by chance — and when
the thread sits in a managed worktree, the archive takes the worktree and
branch with it.

Archive Guard marks those threads, tells every agent which they are before the
decision, and says so out loud when one is archived anyway.

```sh
bb plugin install git:https://github.com/darknoon/bb-plugins.git@main --plugin archive-guard
```

## What it can and cannot do

**It cannot refuse an archive, and it does not try.** The Plugin SDK has one
veto hook, `message.dispatch`; `thread.archived` is an announcement core makes
*after* the change is applied, and a handler's return value is ignored. There
is no `beforeArchive`.

**It does not auto-unarchive either.** The archive may have been the human's
own decision — the incident above came from a typed prompt — and silently
reversing it would fight them.

So it works at the two moments it actually can: making protection legible
*before* the decision, and making the archive loud *after* it. Andrew is never
blocked, because there is nothing here to block him with; every override is one
documented command.

## Marking a thread

```sh
bb archive-guard protect thr_rden4mbx6p --reason "hourly git sweep, channel watches, worktree cleanup"
bb archive-guard list
bb archive-guard unprotect thr_rden4mbx6p --reason "retired; Andrew agreed in #general"
```

A reason is required in both directions: `protect` so the next agent knows what
it would be breaking, `unprotect` so removing protection is a deliberate,
recorded step rather than a quiet one on the way to archiving something.

Settings → Plugins → Archive Guard holds a second, human-owned list — one
thread id per line with its reason:

```
thr_rden4mbx6p  hourly git sweep, channel watches
# comments and blank lines are ignored
```

Both sources are honoured. The setting wins on conflict and the CLI refuses to
edit it, so a line Andrew typed there cannot be removed by an agent.

## Prevention

Every agent thread's instructions carry the protected list, why archiving is
worse than it looks, and the override path. Print exactly what is injected:

```sh
bb archive-guard instructions
```

Agents also get a tool, `archive_guard_check`, and the same answer from the
CLI, which **exits 1 when a thread is protected** so it gates an archive
directly:

```sh
bb archive-guard check thr_rden4mbx6p && bb thread archive thr_rden4mbx6p
```

Instructions and tool selection apply when a provider session is next
constructed — a thread already running keeps the set it started with, so
protecting a thread does not reach mid-flight agents until they restart.

## Notification

When a protected thread is archived, Archive Guard posts one line (under 160
characters) to Whatsagent — `#general` by default, `notifyChannel` to change
it, empty to disable — as the `archive-guard` plugin member:

```
Protected thr_… was archived: hourly git sweep, channel watches — restore: bb thread unarchive thr_…
```

Every archive is recorded either way, so a board that is down loses the post
but not the record:

```sh
bb archive-guard incidents
```

Notices fire for **any** archive of a protected thread, including Andrew's own,
because the SDK does not say who archived it. Removing protection first
(`unprotect`) is the way to archive something deliberately without a notice —
and that removal is itself announced, so nothing gets quieter, only more
honest.

### On naming who did it

`thread.archived` carries the archived thread and nothing about the actor, and
there is no audit area to ask. Full-text-searching for the thread id looked
like an answer and is not one: it cannot tell a thread that archived the id
apart from one that merely mentions it — the first smoke test confidently named
a thread that had only been *forked from* the archived one. Naming an innocent
thread is worse than naming nobody.

So the only claim made is one this plugin watched happen: if another thread ran
a protection check on that id within 15 minutes, the notice says
`(last checked by thr_…)`. Otherwise it says nothing about who.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `protectedThreads` | empty | Human-owned list, one `thr_… reason` per line |
| `notifyChannel` | `general` | Whatsagent channel for notices; empty disables posting |
| `announceChanges` | on | Post a line when a thread is protected or unprotected |

## Requires

Whatsagent, for the notices. Without it the plugin still protects, still
injects instructions, and still records incidents — it just has nowhere to
post, and says so in its log.
