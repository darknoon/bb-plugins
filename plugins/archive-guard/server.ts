// Archive Guard — keeps long-lived "root agent" threads from being archived by
// accident.
//
// Why this exists: a custodian thread that runs sweeps, watches channels and
// babysits automations looks exactly like a finished side quest to any agent
// that did not spawn it. On 2026-09-05 one such thread was archived on a typed
// prompt ("is there any work from this thread we need? otherwise archive it").
// Nothing was malicious — the archiving thread simply had no way to know that
// thread was infrastructure. The archived thread cannot notice or object, so
// it was caught by chance; and when the thread sits in a managed worktree, the
// archive takes the worktree and branch with it.
//
// What this plugin can and cannot do. The Plugin SDK has exactly one veto hook
// (`message.dispatch`); `thread.archived` is an announcement core makes after
// the fact, so a plugin CANNOT refuse an archive. Auto-unarchiving is also
// wrong: the archive may have been the human's own decision, and silently
// reversing it fights them. So the guard works at the two moments it actually
// can:
//
//   BEFORE — every agent's thread instructions name the protected threads, and
//   `archive_guard_check` / `bb archive-guard check` answer for any thread id.
//   Deliberate removal goes through `bb archive-guard unprotect`, which demands
//   a reason and announces itself.
//
//   AFTER — `thread.archived` on a protected thread posts one line to
//   Whatsagent naming the thread and the one command that restores it. Never
//   silent again.
//
// Andrew is never blocked: nothing here can stop an archive in the first place,
// and every override path is a single documented command.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** bb thread ids are `thr_` + a short lowercase base32-ish tail. */
const THREAD_ID_RE = /^thr_[a-z0-9]+$/;
/** Whatsagent's own default post ceiling; it re-enforces its configured one. */
const MAX_POST_CHARS = 160;
/** The plugin whose board we post to, and where its loopback token lives. */
const BOARD_PLUGIN_ID = "whatsagent";
const BOARD_TOKEN_FILE = ".http-token";
/** `contributeInstructions` output is truncated by the host at 4096. */
const MAX_INSTRUCTIONS_CHARS = 4000;
/** Keep injected instructions bounded when the protected list grows. */
const MAX_LISTED_THREADS = 12;
const MAX_REASON_CHARS = 120;
/** A check this recent before an archive is evidence about who was deciding. */
const LOOKUP_WINDOW_MS = 15 * 60 * 1000;
/** Lookups are only evidence while they are fresh; drop the rest. */
const LOOKUP_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Two archive events for one archive (a cascade, a redelivery) post once. */
const DUPLICATE_EVENT_MS = 30 * 1000;

type ProtectionSource = "setting" | "cli";

interface Protection {
  threadId: string;
  reason: string;
  source: ProtectionSource;
  /** Epoch ms; null for setting-sourced rows, which have no history. */
  protectedAt: number | null;
  /** Thread id of the agent that ran `protect`, or "human" from a shell. */
  protectedBy: string | null;
}

interface Incident {
  id: number;
  threadId: string;
  reason: string;
  /** Thread that checked this id shortly before the archive, when one did. */
  lastCheckedByThreadId: string | null;
  archivedAt: number;
  notified: boolean;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    protectedThreads: {
      type: "string",
      label: "Protected threads",
      description:
        "One per line: a thread id, then the reason it is infrastructure — " +
        "`thr_rden4mbx6p  hourly git sweep, channel watches`. Lines edited " +
        "here are read-only to the CLI; `bb archive-guard protect` writes its " +
        "own list and both are honoured.",
      experimental_multiline: true,
      default: "",
    },
    notifyChannel: {
      type: "string",
      label: "Whatsagent channel for archive notices",
      description:
        "Where a protected thread's archive is reported. Empty disables " +
        "posting; incidents are still recorded for `bb archive-guard incidents`.",
      default: "general",
    },
    announceChanges: {
      type: "boolean",
      label: "Announce protect/unprotect on Whatsagent",
      description:
        "Post one line when a thread is protected or unprotected, so removing " +
        "protection is never a silent step on the way to archiving something.",
      default: true,
    },
  });

  // -------------------------------------------------------------------------
  // Store. The CLI writes here; the setting above is a second, human-owned
  // source that is merged in at read time.
  // -------------------------------------------------------------------------
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE protected_threads (
       thread_id TEXT PRIMARY KEY,
       reason TEXT NOT NULL,
       protected_at INTEGER NOT NULL,
       protected_by TEXT
     )`,
    `CREATE TABLE archive_incidents (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       thread_id TEXT NOT NULL,
       reason TEXT NOT NULL,
       suspect_thread_id TEXT,
       archived_at INTEGER NOT NULL,
       notified INTEGER NOT NULL DEFAULT 0
     )`,
    `CREATE INDEX archive_incidents_archived_at ON archive_incidents (archived_at DESC)`,
    // Who asked whether a thread was protected, and when. The SDK's archive
    // event names no actor, so a check made minutes before an archive is the
    // only evidence this plugin can honestly offer about who was deciding.
    `CREATE TABLE protection_lookups (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       thread_id TEXT NOT NULL,
       by_thread_id TEXT NOT NULL,
       at INTEGER NOT NULL
     )`,
    `CREATE INDEX protection_lookups_thread ON protection_lookups (thread_id, at DESC)`,
  ]);

  type ProtectedRow = {
    thread_id: string;
    reason: string;
    protected_at: number;
    protected_by: string | null;
  };
  type IncidentRow = {
    id: number;
    thread_id: string;
    reason: string;
    suspect_thread_id: string | null;
    archived_at: number;
    notified: number;
  };

  const selectProtected = db.prepare(
    `SELECT thread_id, reason, protected_at, protected_by FROM protected_threads ORDER BY protected_at`,
  );
  const upsertProtected = db.prepare(
    `INSERT INTO protected_threads (thread_id, reason, protected_at, protected_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET reason = excluded.reason`,
  );
  const deleteProtected = db.prepare(`DELETE FROM protected_threads WHERE thread_id = ?`);
  const insertIncident = db.prepare(
    `INSERT INTO archive_incidents (thread_id, reason, suspect_thread_id, archived_at, notified)
     VALUES (?, ?, ?, ?, 0)`,
  );
  const markNotified = db.prepare(`UPDATE archive_incidents SET notified = 1 WHERE id = ?`);
  const selectIncidents = db.prepare(
    `SELECT id, thread_id, reason, suspect_thread_id, archived_at, notified
     FROM archive_incidents ORDER BY archived_at DESC LIMIT ?`,
  );
  const selectRecentIncident = db.prepare(
    `SELECT id FROM archive_incidents WHERE thread_id = ? AND archived_at >= ? LIMIT 1`,
  );
  const insertLookup = db.prepare(
    `INSERT INTO protection_lookups (thread_id, by_thread_id, at) VALUES (?, ?, ?)`,
  );
  const pruneLookups = db.prepare(`DELETE FROM protection_lookups WHERE at < ?`);
  const selectLastLookup = db.prepare(
    `SELECT by_thread_id FROM protection_lookups
     WHERE thread_id = ? AND by_thread_id <> ? AND at >= ?
     ORDER BY at DESC LIMIT 1`,
  );

  /**
   * Record that `byThreadId` asked about `threadId`. Only calls from inside a
   * thread are evidence — a human shell has no id to record and is not the
   * thing this plugin is trying to make visible.
   */
  function recordLookup(threadId: string, byThreadId: string | undefined): void {
    if (!byThreadId) return;
    const now = Date.now();
    insertLookup.run(threadId, byThreadId, now);
    pruneLookups.run(now - LOOKUP_RETENTION_MS);
  }

  // -------------------------------------------------------------------------
  // Snapshot. `contributeInstructions` and the event handler must answer
  // synchronously, so the merged list is cached and refreshed on every write.
  // -------------------------------------------------------------------------
  let settingRows: Protection[] = [];
  let snapshot = new Map<string, Protection>();

  /**
   * Parse the setting's text. Each line is a thread id and an optional reason,
   * separated by whitespace and/or one of `#`, `-`, `:`. Blank lines and full
   * `#` comment lines are skipped; an unparseable line is logged, not fatal —
   * one typo must never drop the rest of the list.
   */
  function parseSetting(text: string): Protection[] {
    const rows: Protection[] = [];
    const seen = new Set<string>();
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      const match = /^(thr_[a-z0-9]+)\s*(?:[#\-:]\s*)?(.*)$/.exec(line);
      if (!match) {
        bb.log.warn(`Ignoring unparseable protectedThreads line: ${line.slice(0, 80)}`);
        continue;
      }
      const threadId = match[1]!;
      if (seen.has(threadId)) continue;
      seen.add(threadId);
      rows.push({
        threadId,
        reason: match[2]!.trim() || "protected in Archive Guard settings",
        source: "setting",
        protectedAt: null,
        protectedBy: null,
      });
    }
    return rows;
  }

  /** Settings win over the CLI list: the human's file is the stronger claim. */
  function rebuild(): void {
    const next = new Map<string, Protection>();
    for (const row of selectProtected.all() as ProtectedRow[]) {
      next.set(row.thread_id, {
        threadId: row.thread_id,
        reason: row.reason,
        source: "cli",
        protectedAt: row.protected_at,
        protectedBy: row.protected_by,
      });
    }
    for (const row of settingRows) next.set(row.threadId, row);
    snapshot = next;
  }

  settingRows = parseSetting((await settings.get()).protectedThreads);
  rebuild();
  settings.onChange((next) => {
    settingRows = parseSetting(next.protectedThreads);
    rebuild();
  });

  const protectionFor = (threadId: string): Protection | undefined => snapshot.get(threadId);
  const listProtections = (): Protection[] =>
    [...snapshot.values()].sort((a, b) => a.threadId.localeCompare(b.threadId));

  // -------------------------------------------------------------------------
  // Whatsagent notifier. Posts as a `plugin` member (handle `archive-guard`)
  // through Whatsagent's token-auth route. Every failure is soft: a board that
  // is missing, disabled or erroring must never break an archive event.
  // -------------------------------------------------------------------------
  let boardToken: string | null = null;

  /**
   * Only a successful read is cached. A miss means Whatsagent is not installed
   * or has not minted its token yet — both of which can become true later, and
   * neither is worth making the user reload this plugin to notice.
   */
  async function readBoardToken(): Promise<string | null> {
    if (boardToken !== null) return boardToken;
    try {
      const path = join(
        bb.server.experimental_dataDir,
        "plugins",
        BOARD_PLUGIN_ID,
        "secrets",
        BOARD_TOKEN_FILE,
      );
      boardToken = (await readFile(path, "utf8")).trim() || null;
    } catch {
      boardToken = null;
    }
    return boardToken;
  }

  /** Returns true when the post landed. Never throws. */
  async function post(body: string): Promise<boolean> {
    const { notifyChannel } = await settings.get();
    const channel = notifyChannel.trim().replace(/^#/, "");
    if (channel === "") return false;
    const token = await readBoardToken();
    if (token === null) {
      bb.log.warn(`No ${BOARD_PLUGIN_ID} token; not posting: ${body}`);
      return false;
    }
    try {
      const response = await fetch(
        `${bb.server.loopbackBaseUrl}/api/v1/plugins/${BOARD_PLUGIN_ID}/http/post`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-bb-plugin-token": token },
          body: JSON.stringify({ plugin: bb.pluginId, channel, body }),
        },
      );
      if (!response.ok) {
        // A rotated token is the likeliest cause; re-read it next time.
        if (response.status === 401 || response.status === 403) boardToken = null;
        bb.log.warn(`Whatsagent post failed (${response.status}): ${await response.text()}`);
        return false;
      }
      return true;
    } catch (cause) {
      bb.log.warn(`Whatsagent post failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return false;
    }
  }

  /**
   * Fit `head + reason + tail` into the post limit by trimming only the reason,
   * so the thread id and the restore command — the parts a reader acts on —
   * always survive.
   */
  function fitPost(head: string, reason: string, tail: string): string {
    const budget = MAX_POST_CHARS - head.length - tail.length;
    if (budget <= 1) return `${head}${tail}`.slice(0, MAX_POST_CHARS);
    const trimmed = reason.length <= budget ? reason : `${reason.slice(0, budget - 1).trimEnd()}…`;
    return `${head}${trimmed}${tail}`;
  }

  // -------------------------------------------------------------------------
  // Attribution. `thread.archived` carries the archived thread and nothing
  // about who archived it, and there is no audit area to ask. Full-text search
  // for the id looked promising and is wrong: it cannot tell a thread that
  // archived the id apart from one that merely *mentions* it — the first
  // smoke test named a thread that had only been forked from the archived one.
  // Naming an innocent thread is worse than naming nobody, so the only claim
  // made here is one this plugin watched happen: a protection check from
  // another thread, minutes before the archive.
  // -------------------------------------------------------------------------
  function lastCheckedBy(threadId: string): string | null {
    const row = selectLastLookup.get(threadId, threadId, Date.now() - LOOKUP_WINDOW_MS) as
      | { by_thread_id: string }
      | undefined;
    return row?.by_thread_id ?? null;
  }

  // -------------------------------------------------------------------------
  // After the fact: report the archive.
  // -------------------------------------------------------------------------
  bb.events.on("thread.archived", ({ thread }) => {
    const protection = protectionFor(thread.id);
    if (!protection) return;
    // One archive, one notice: a cascade or a re-delivered event must not post
    // twice. The window is deliberately short, so a genuine unarchive-then-
    // archive-again still gets its own line.
    const recent = selectRecentIncident.get(thread.id, Date.now() - DUPLICATE_EVENT_MS);
    if (recent) {
      bb.log.info(`Skipping duplicate archive notice for ${thread.id}.`);
      return;
    }
    const checker = lastCheckedBy(thread.id);
    const incidentId = Number(
      insertIncident.run(thread.id, protection.reason, checker, Date.now()).lastInsertRowid,
    );
    bb.log.warn(
      `Protected thread ${thread.id} was archived (${protection.reason})` +
        `${checker ? `; last checked by ${checker}` : ""}. Restore: bb thread unarchive ${thread.id}`,
    );
    const by = checker ? ` (last checked by ${checker})` : "";
    void post(
      fitPost(
        `Protected ${thread.id} was archived${by}: `,
        protection.reason,
        ` — restore: bb thread unarchive ${thread.id}`,
      ),
    )
      .then((posted) => {
        if (posted) markNotified.run(incidentId);
      })
      .catch((cause) => {
        bb.log.error(`Archive notice failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
  });

  // -------------------------------------------------------------------------
  // Before the fact: tell every agent what is protected.
  // -------------------------------------------------------------------------
  const shorten = (reason: string): string =>
    reason.length <= MAX_REASON_CHARS ? reason : `${reason.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…`;

  function instructionsFor(threadId: string): string | null {
    const rows = listProtections();
    if (rows.length === 0) return null;
    const listed = rows.slice(0, MAX_LISTED_THREADS);
    const lines = [
      "## Protected threads (Archive Guard)",
      "",
      "Do NOT archive these bb threads. They are long-lived infrastructure — " +
        "sweeps, watches, and automations that look idle but are not:",
      "",
      ...listed.map((row) => `- ${row.threadId} — ${shorten(row.reason)}`),
    ];
    if (rows.length > listed.length) {
      lines.push(`- …and ${rows.length - listed.length} more; see \`bb archive-guard list\`.`);
    }
    lines.push(
      "",
      "Archiving one can also tear down its managed worktree and branch, and the " +
        "archived thread cannot notice or object — so the mistake is silent " +
        "from its side.",
      "",
      "Before archiving ANY thread, check it: `bb archive-guard check <threadId>` " +
        "(exit 1 means protected).",
      "",
      "If a protected thread genuinely should go, ask the human first, then " +
        "override deliberately:",
      "",
      "```",
      'bb archive-guard unprotect <threadId> --reason "<why, and who agreed>"',
      "bb thread archive <threadId>",
      "```",
      "",
      "Unprotecting is announced on Whatsagent, so a deliberate override is " +
        "visible but never blocked.",
    );
    const self = protectionFor(threadId);
    if (self) {
      lines.push(
        "",
        `This thread (${threadId}) is itself protected: ${shorten(self.reason)}.`,
      );
    }
    return lines.join("\n").slice(0, MAX_INSTRUCTIONS_CHARS);
  }

  bb.agents.contributeInstructions(({ threadId }) => instructionsFor(threadId));

  // -------------------------------------------------------------------------
  // The same answer as a tool, for agents that would rather ask than parse.
  // -------------------------------------------------------------------------
  const checkParams = z.object({
    threadIds: z
      .array(z.string())
      .min(1)
      .max(50)
      .describe("bb thread ids to check, e.g. [\"thr_rden4mbx6p\"]."),
  });

  bb.agents.registerTool({
    name: "archive_guard_check",
    description:
      "Ask whether bb threads are protected from archiving. Call this before " +
      "archiving any thread. A protected thread is long-lived infrastructure: " +
      "do not archive it, ask the human first.",
    instructions:
      "Before you archive a bb thread — with `bb thread archive`, the sidebar, " +
      "or any other path — call archive_guard_check with its id. If it comes " +
      "back protected, do not archive it; say why to whoever asked and let " +
      "them decide.",
    presentation: {
      label: { pending: "Checking archive protection", completed: "Checked archive protection" },
    },
    parameters: checkParams,
    execute({ threadIds }, ctx) {
      const lines = threadIds.map((threadId) => {
        const protection = protectionFor(threadId);
        if (!protection) return `${threadId}: not protected — archiving it is fine.`;
        recordLookup(threadId, ctx.threadId);
        return (
          `${threadId}: PROTECTED — ${protection.reason}. Do not archive it. ` +
          `To override deliberately: bb archive-guard unprotect ${threadId} --reason "<why, and who agreed>".`
        );
      });
      return lines.join("\n");
    },
  });

  bb.agents.configure(() => ({ tools: ["archive_guard_check"], skills: [] }));

  // -------------------------------------------------------------------------
  // CLI
  // -------------------------------------------------------------------------
  const usage = [
    "bb archive-guard — protect long-lived infrastructure threads from being archived",
    "",
    "  bb archive-guard list [--json]",
    "  bb archive-guard check <threadId> [--json]          exit 1 when protected",
    "  bb archive-guard protect <threadId> --reason <text>",
    "  bb archive-guard unprotect <threadId> --reason <text>",
    "  bb archive-guard incidents [--limit N] [--json]",
    "  bb archive-guard instructions [--thread <id>]      what agents are told",
    "",
    "Nothing here can block an archive — the Plugin SDK has no archive veto.",
    "It makes protection visible before the decision and loud after it.",
  ].join("\n");

  function takeFlag(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    const [value] = args.splice(index, 2).slice(1);
    return value;
  }
  function hasFlag(args: string[], flag: string): boolean {
    const index = args.indexOf(flag);
    if (index === -1) return false;
    args.splice(index, 1);
    return true;
  }

  const describe = (row: Protection): string =>
    `${row.threadId}  ${row.reason}  [${row.source === "setting" ? "settings" : "cli"}]`;

  bb.cli.register({
    name: "archive-guard",
    summary: "Protect long-lived infrastructure threads from being archived by accident",
    commands: [
      { name: "list", summary: "List protected threads", usage: "bb archive-guard list [--json]" },
      {
        name: "check",
        summary: "Is a thread protected? Exits 1 when it is, so it gates an archive",
        usage: "bb archive-guard check <threadId> [--json]",
      },
      {
        name: "protect",
        summary: "Mark a thread as infrastructure that must not be archived",
        usage: 'bb archive-guard protect <threadId> --reason "<what it runs>"',
      },
      {
        name: "unprotect",
        summary: "Deliberately remove protection (announced on Whatsagent)",
        usage: 'bb archive-guard unprotect <threadId> --reason "<why, and who agreed>"',
      },
      {
        name: "incidents",
        summary: "Archives of protected threads this guard has seen",
        usage: "bb archive-guard incidents [--limit N] [--json]",
      },
      {
        name: "instructions",
        summary: "Print the block this plugin injects into agent threads",
        usage: "bb archive-guard instructions [--thread <threadId>]",
      },
    ],
    async run(argv, ctx) {
      const args = [...argv];
      const json = hasFlag(args, "--json");
      const [command, ...rest] = args;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });
      const fail = (message: string) => ({ exitCode: 1, stderr: message });
      const actor = ctx.threadId ?? "human";

      function readThreadId(): string | { error: string } {
        const [threadId] = rest;
        if (!threadId) return { error: `Which thread?\n\n${usage}` };
        if (!THREAD_ID_RE.test(threadId)) {
          return { error: `"${threadId}" is not a bb thread id (expected thr_…).` };
        }
        return threadId;
      }

      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };

        case "list": {
          const rows = listProtections();
          return reply(
            rows,
            rows.length === 0
              ? "No protected threads. Protect one with: bb archive-guard protect <threadId> --reason \"…\""
              : rows.map(describe).join("\n"),
          );
        }

        case "check": {
          const threadId = readThreadId();
          if (typeof threadId !== "string") return fail(threadId.error);
          const protection = protectionFor(threadId);
          if (!protection) {
            return reply({ threadId, protected: false }, `${threadId} is not protected.`);
          }
          recordLookup(threadId, ctx.threadId);
          // Exit 1 so `bb archive-guard check X && bb thread archive X` is safe.
          const message =
            `${threadId} is PROTECTED: ${protection.reason}\n` +
            "Do not archive it. Archiving can also tear down its managed worktree and branch.\n" +
            "Ask the human first. To override deliberately:\n" +
            `  bb archive-guard unprotect ${threadId} --reason "<why, and who agreed>"`;
          return json
            ? { exitCode: 1, stdout: JSON.stringify({ threadId, protected: true, reason: protection.reason }) }
            : { exitCode: 1, stderr: message };
        }

        case "protect": {
          const threadId = readThreadId();
          if (typeof threadId !== "string") return fail(threadId.error);
          const reason = (takeFlag(rest, "--reason") ?? "").trim();
          if (reason === "") {
            return fail(
              "A reason is required, so the next agent knows what it would be breaking:\n" +
                `  bb archive-guard protect ${threadId} --reason "hourly git sweep, channel watches"`,
            );
          }
          const existing = protectionFor(threadId);
          if (existing?.source === "setting") {
            return fail(
              `${threadId} is already protected by the Archive Guard setting. Edit it in ` +
                "Settings → Plugins → Archive Guard instead.",
            );
          }
          upsertProtected.run(threadId, reason, Date.now(), actor);
          rebuild();
          const { announceChanges } = await settings.get();
          if (announceChanges) {
            void post(fitPost(`Protected ${threadId} from archiving: `, reason, "")).catch(() => {});
          }
          return reply(
            { threadId, protected: true, reason },
            `${threadId} is now protected: ${reason}\n` +
              "Every agent thread started from now on is told not to archive it.",
          );
        }

        case "unprotect": {
          const threadId = readThreadId();
          if (typeof threadId !== "string") return fail(threadId.error);
          const reason = (takeFlag(rest, "--reason") ?? "").trim();
          const protection = protectionFor(threadId);
          if (!protection) return fail(`${threadId} is not protected.`);
          if (reason === "") {
            return fail(
              `${threadId} is protected: ${protection.reason}\n` +
                "Removing protection needs a reason, and is announced on Whatsagent:\n" +
                `  bb archive-guard unprotect ${threadId} --reason "<why, and who agreed>"`,
            );
          }
          if (protection.source === "setting") {
            return fail(
              `${threadId} is protected by the Archive Guard setting, which this command ` +
                "cannot edit. Remove its line in Settings → Plugins → Archive Guard.",
            );
          }
          deleteProtected.run(threadId);
          rebuild();
          const { announceChanges } = await settings.get();
          if (announceChanges) {
            void post(
              fitPost(`Protection removed from ${threadId} by ${actor}: `, reason, ""),
            ).catch(() => {});
          }
          return reply(
            { threadId, protected: false, reason },
            `${threadId} is no longer protected (${reason}).\n` +
              `It can be archived now: bb thread archive ${threadId}`,
          );
        }

        case "incidents": {
          const limitRaw = takeFlag(rest, "--limit");
          const parsed = Number.parseInt(limitRaw ?? "20", 10);
          const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 20;
          const rows = (selectIncidents.all(limit) as IncidentRow[]).map(
            (row): Incident => ({
              id: row.id,
              threadId: row.thread_id,
              reason: row.reason,
              lastCheckedByThreadId: row.suspect_thread_id,
              archivedAt: row.archived_at,
              notified: row.notified === 1,
            }),
          );
          return reply(
            rows,
            rows.length === 0
              ? "No protected thread has been archived."
              : rows
                  .map(
                    (row) =>
                      `${new Date(row.archivedAt).toISOString()}  ${row.threadId}` +
                      `${row.lastCheckedByThreadId ? `  last checked by ${row.lastCheckedByThreadId}` : ""}` +
                      `${row.notified ? "" : "  (not announced)"}`,
                  )
                  .join("\n"),
          );
        }

        case "instructions": {
          // Prevention is the whole product here, so what agents actually get
          // told has to be inspectable without starting a thread to read it.
          const target = takeFlag(rest, "--thread") ?? ctx.threadId ?? "";
          const text = instructionsFor(target);
          return reply(
            { threadId: target || null, instructions: text },
            text ??
              "Nothing is injected: no threads are protected yet. Protect one with:\n" +
                '  bb archive-guard protect <threadId> --reason "…"',
          );
        }

        default:
          return fail(`Unknown command "${command}".\n\n${usage}`);
      }
    },
  });
}
