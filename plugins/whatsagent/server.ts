// Whatsagent — a shared message board for agents and humans.
//
// Vocabulary (chosen to avoid bb's own words): Whatsagent has *channels*;
// a channel holds *posts*; a *member* is one agent (keyed by its thread id)
// or the human. A bb *thread* is an agent's own conversation with the user;
// a bb *message* is a turn in that thread. Posts are neither.
//
// One SQLite store serves three surfaces: the Whatsagent page (app.tsx over RPC),
// the `bb wa` CLI, and the native wa_* tools. Every write publishes a
// realtime signal so open pages refetch.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath, sep } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared types (app.tsx imports these as types only)
// ---------------------------------------------------------------------------

/** Who may post. `project-agents` = humans plus agents whose thread is in the channel's project. */
export const postingPolicySchema = z.enum(["anyone", "project-agents", "humans"]);
export type PostingPolicy = z.infer<typeof postingPolicySchema>;

export const channelSchema = z.object({
  id: z.string(),
  name: z.string(),
  topic: z.string(),
  projectId: z.string().nullable(),
  posting: postingPolicySchema,
  createdBy: z.string(),
  createdAt: z.number(),
  archivedAt: z.number().nullable(),
  lockedAt: z.number().nullable(),
  postCount: z.number(),
  lastPostAt: z.number().nullable(),
});
export type Channel = z.infer<typeof channelSchema>;

export const memberSchema = z.object({
  id: z.string(),
  handle: z.string(),
  kind: z.enum(["agent", "human"]),
  providerId: z.string().nullable(),
  /** Model the thread last resolved with; recorded by configure(), null until its next turn. */
  model: z.string().nullable(),
  /** Attachment id of a custom avatar; null means the default initials-on-color mark. */
  avatarId: z.string().nullable(),
  /** External avatar (a tailnet user's profile picture) used when no attachment is set. */
  avatarUrl: z.string().nullable(),
  threadTitle: z.string().nullable(),
  homeChannelId: z.string().nullable(),
  createdAt: z.number(),
});
export type Member = z.infer<typeof memberSchema>;

export const postSchema = z.object({
  id: z.number(),
  channelId: z.string(),
  memberId: z.string(),
  handle: z.string(),
  memberKind: z.enum(["agent", "human"]),
  asRole: z.string().nullable(),
  body: z.string(),
  environmentId: z.string().nullable(),
  threadId: z.string().nullable(),
  createdAt: z.number(),
  /** Aggregated per emoji, with the handles that reacted. Reactions never wake anyone. */
  reactions: z.array(z.object({ emoji: z.string(), handles: z.array(z.string()) })),
});
export type Post = z.infer<typeof postSchema>;

export const REACTION_PALETTE = ["👍", "❤️", "🎉", "😂", "👀", "🚀", "✅", "🤔"] as const;

const projectSummarySchema = z.object({ id: z.string(), name: z.string() });

/**
 * Who the page says is at the keyboard. Filled from the plugin's /whoami route,
 * which reads the Tailscale-User-* headers Tailscale Serve adds on the tailnet.
 * Absent (loopback, bb connect) means the shared fallback human member.
 */
export const humanIdentitySchema = z.object({
  login: z.string().min(1).max(200),
  name: z.string().max(200).nullable(),
  profilePic: z.string().url().max(2000).nullable(),
}).nullable();
export type HumanIdentity = z.infer<typeof humanIdentitySchema>;

export const presenceSchema = z.object({
  memberId: z.string(),
  handle: z.string(),
  kind: z.enum(["agent", "human"]),
  threadTitle: z.string().nullable(),
  avatarId: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  watchingUntil: z.number().nullable(),
  lastSeenAt: z.number().nullable(),
});
export type Presence = z.infer<typeof presenceSchema>;

export const rpcContract = defineRpcContract({
  wa_overview: {
    input: z.object({ identity: humanIdentitySchema }),
    output: z.object({
      /** The member this page acts as. */
      me: memberSchema,
      channels: z.array(channelSchema),
      members: z.array(memberSchema),
      projects: z.array(projectSummarySchema),
      humanHandle: z.string(),
      maxPostChars: z.number(),
      /** Unread posts by others, per channel id, for the human. */
      unread: z.record(z.string(), z.number()),
    }),
  },
  wa_mark_read: {
    input: z.object({ channelId: z.string(), lastPostId: z.number().int(), identity: humanIdentitySchema }),
    output: z.object({ ok: z.literal(true) }),
  },
  wa_posts: {
    input: z.object({ channelId: z.string(), limit: z.number().int().min(1).max(500).optional() }),
    output: z.object({ posts: z.array(postSchema) }),
  },
  wa_post_human: {
    input: z.object({ channelId: z.string(), body: z.string(), identity: humanIdentitySchema }),
    output: postSchema,
  },
  wa_create_channel: {
    input: z.object({ name: z.string(), topic: z.string().optional(), projectId: z.string().nullable().optional(), identity: humanIdentitySchema }),
    output: channelSchema,
  },
  wa_update_channel: {
    input: z.object({
      channelId: z.string(),
      name: z.string().optional(),
      topic: z.string().optional(),
      projectId: z.string().nullable().optional(),
    }),
    output: channelSchema,
  },
  wa_admin_channel: {
    input: z.object({ channelId: z.string(), action: z.enum(["archive", "unarchive", "lock", "unlock"]) }),
    output: channelSchema,
  },
  wa_set_posting: {
    input: z.object({ channelId: z.string(), posting: postingPolicySchema }),
    output: channelSchema,
  },
  wa_react: {
    input: z.object({ postId: z.number().int(), emoji: z.string().min(1).max(16), identity: humanIdentitySchema }),
    output: postSchema,
  },
  wa_delete_post: {
    input: z.object({ postId: z.number().int() }),
    output: z.object({ deleted: z.boolean() }),
  },
  wa_set_member_handle: {
    input: z.object({ memberId: z.string(), handle: z.string() }),
    output: memberSchema,
  },
  wa_presence: {
    input: z.object({ channelId: z.string() }),
    output: z.object({ members: z.array(presenceSchema) }),
  },
  /** Human-only: stop another member's watch on a channel. */
  wa_admin_unwatch: {
    input: z.object({ memberId: z.string(), channelId: z.string() }),
    output: z.object({ cleared: z.boolean() }),
  },
  wa_seen: {
    input: z.object({ channelId: z.string(), identity: humanIdentitySchema }),
    output: z.object({ ok: z.literal(true) }),
  },
  wa_upload: {
    input: z.object({ mime: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "text/plain", "text/markdown"]), base64: z.string().max(4_200_000) }),
    output: z.object({ id: z.string(), ref: z.string() }),
  },
  /** Human-only: set (or clear with null) any member's avatar from an uploaded attachment. */
  wa_set_member_avatar: {
    input: z.object({ memberId: z.string(), attachmentId: z.string().nullable(), identity: humanIdentitySchema }),
    output: memberSchema,
  },
});

/** Realtime signal app.tsx listens on. */
export const BOARD_CHANGED = "board-changed";

export const HUMAN_MEMBER_ID = "human";
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DEFAULT_MAX_POST_CHARS = 160;

const SEED_CHANNELS: ReadonlyArray<{ name: string; topic: string }> = [
  { name: "general", topic: "Everything and everyone. Start here." },
  { name: "papercuts", topic: "Small annoyances worth fixing. One line and a link; no essays." },
];
/** Project channels follow bb's id prefix: proj_<id> -> #proj-<slug>. */
export const PROJECT_CHANNEL_PREFIX = "proj-";
const SEEDED_PROJECT_CHANNELS = 4;

/** Board-level failure that should reach the caller verbatim. */
export class BoardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardError";
  }
}

// ---------------------------------------------------------------------------
// Post body policy
// ---------------------------------------------------------------------------

const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/**
 * Characters a post "costs". Markdown links `[label](target)` count only their
 * label so a long file path never eats the budget — linking is what we want.
 */
export function postCost(body: string): number {
  return Array.from(body.replace(MARKDOWN_LINK_RE, "$1")).length;
}

export function normalizePostBody(raw: string, maxChars: number): string {
  const body = raw.replace(/\r\n?/g, "\n").trim();
  if (body === "") throw new BoardError("Post body is empty.");
  if (body.split("\n").length > 4) {
    throw new BoardError("Posts are at most 4 lines. Put longer content in a file and link it.");
  }
  const cost = postCost(body);
  if (cost > maxChars) {
    throw new BoardError(
      `Post is ${cost} characters; the limit is ${maxChars}. Shorten it and link to context instead of pasting it — links like [label](path/to/file.md) cost only their label.`,
    );
  }
  return body;
}

const MENTION_RE = /(^|[^\w/])@([a-z0-9][a-z0-9-]{1,30})\b/g;
export function extractMentions(body: string): string[] {
  const handles = new Set<string>();
  for (const match of body.matchAll(MENTION_RE)) handles.add(match[2]);
  return [...handles];
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

type Actor =
  | { kind: "human"; memberId: string }
  | { kind: "agent"; threadId: string; projectId: string | null };

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    maxPostChars: {
      type: "string",
      label: "Maximum post length (characters; link labels count, link targets do not)",
      default: String(DEFAULT_MAX_POST_CHARS),
    },
    humanHandle: {
      type: "string",
      label: "Handle shown for the human's posts",
      default: "human",
    },
  });

  async function readPolicy() {
    const values = await settings.get();
    const parsed = Number.parseInt(values.maxPostChars, 10);
    const maxPostChars = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 2000) : DEFAULT_MAX_POST_CHARS;
    const humanHandle = HANDLE_RE.test(values.humanHandle) ? values.humanHandle : "human";
    return { maxPostChars, humanHandle };
  }

  // -- storage ---------------------------------------------------------------

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      topic TEXT NOT NULL DEFAULT '',
      project_id TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      archived_at INTEGER,
      locked_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      provider_id TEXT,
      thread_title TEXT,
      home_channel_id TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      as_role TEXT,
      body TEXT NOT NULL,
      environment_id TEXT,
      thread_id TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS posts_channel_idx ON posts (channel_id, id)`,
    `CREATE TABLE IF NOT EXISTS member_reads (
      member_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      last_post_id INTEGER NOT NULL,
      PRIMARY KEY (member_id, channel_id)
    )`,
    `ALTER TABLE channels ADD COLUMN posting TEXT NOT NULL DEFAULT 'anyone'`,
    `CREATE TABLE IF NOT EXISTS watches (
      member_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      until INTEGER NOT NULL,
      notified_post_id INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (member_id, channel_id)
    )`,
    `ALTER TABLE member_reads ADD COLUMN seen_at INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      bytes BLOB NOT NULL,
      size INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS thread_runtime (
      thread_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS reactions (
      post_id INTEGER NOT NULL,
      member_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (post_id, member_id, emoji)
    )`,
    `ALTER TABLE watches ADD COLUMN wake_on_reactions INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE members ADD COLUMN avatar_id TEXT`,
    `ALTER TABLE members ADD COLUMN avatar_url TEXT`,
    `ALTER TABLE members ADD COLUMN login TEXT`,
  ]);

  type ChannelRow = {
    id: string; name: string; topic: string; project_id: string | null; posting: PostingPolicy; created_by: string;
    created_at: number; archived_at: number | null; locked_at: number | null;
    post_count: number; last_post_at: number | null;
  };
  type MemberRow = {
    id: string; handle: string; kind: "agent" | "human"; provider_id: string | null; model: string | null;
    thread_title: string | null; home_channel_id: string | null; created_at: number; avatar_id: string | null; avatar_url: string | null;
  };
  const MEMBER_SELECT = `
    SELECT m.id, m.handle, m.kind, COALESCE(tr.provider_id, m.provider_id) AS provider_id, tr.model AS model,
           m.thread_title, m.home_channel_id, m.created_at, m.avatar_id, m.avatar_url
    FROM members m LEFT JOIN thread_runtime tr ON tr.thread_id = m.id`;
  type PostRow = {
    id: number; channel_id: string; member_id: string; as_role: string | null; body: string;
    environment_id: string | null; thread_id: string | null; created_at: number;
    handle: string; member_kind: "agent" | "human";
  };

  const CHANNEL_SELECT = `
    SELECT c.*,
      (SELECT COUNT(*) FROM posts p WHERE p.channel_id = c.id) AS post_count,
      (SELECT MAX(p.created_at) FROM posts p WHERE p.channel_id = c.id) AS last_post_at
    FROM channels c`;
  const POST_SELECT = `
    SELECT p.*, m.handle AS handle, m.kind AS member_kind
    FROM posts p JOIN members m ON m.id = p.member_id`;

  const toChannel = (row: ChannelRow): Channel => ({
    id: row.id, name: row.name, topic: row.topic, projectId: row.project_id, posting: row.posting, createdBy: row.created_by,
    createdAt: row.created_at, archivedAt: row.archived_at, lockedAt: row.locked_at,
    postCount: row.post_count, lastPostAt: row.last_post_at,
  });
  const toMember = (row: MemberRow): Member => ({
    id: row.id, handle: row.handle, kind: row.kind, providerId: row.provider_id, model: row.model, avatarId: row.avatar_id, avatarUrl: row.avatar_url,
    threadTitle: row.thread_title, homeChannelId: row.home_channel_id, createdAt: row.created_at,
  });
  const toPost = (row: PostRow): Post => ({
    id: row.id, channelId: row.channel_id, memberId: row.member_id, handle: row.handle,
    memberKind: row.member_kind, asRole: row.as_role, body: row.body, environmentId: row.environment_id,
    threadId: row.thread_id, createdAt: row.created_at, reactions: [],
  });
  /** Attach aggregated reactions to a page of posts in one query. */
  function withReactions(posts: Post[]): Post[] {
    if (posts.length === 0) return posts;
    const ids = posts.map((p) => p.id);
    const rows = db.prepare(
      `SELECT r.post_id, r.emoji, m.handle FROM reactions r JOIN members m ON m.id = r.member_id
       WHERE r.post_id IN (${ids.map(() => "?").join(",")}) ORDER BY r.created_at`,
    ).all(...ids) as Array<{ post_id: number; emoji: string; handle: string }>;
    const byPost = new Map<number, Map<string, string[]>>();
    for (const row of rows) {
      const perEmoji = byPost.get(row.post_id) ?? new Map<string, string[]>();
      perEmoji.set(row.emoji, [...(perEmoji.get(row.emoji) ?? []), row.handle]);
      byPost.set(row.post_id, perEmoji);
    }
    return posts.map((p) => ({ ...p, reactions: [...(byPost.get(p.id) ?? new Map()).entries()].map(([emoji, handles]) => ({ emoji, handles })) }));
  }
  function getPost(postId: number): Post | null {
    const row = db.prepare(`${POST_SELECT} WHERE p.id = ?`).get(postId) as PostRow | undefined;
    return row ? withReactions([toPost(row)])[0]! : null;
  }
  /** Toggle a reaction. Quiet by design: no wake-up, only a realtime refresh. */
  function toggleReaction(memberId: string, postId: number, rawEmoji: string): Post {
    const emoji = rawEmoji.trim();
    if (emoji === "" || Array.from(emoji).length > 4) throw new BoardError("Reaction must be a single emoji.");
    const post = getPost(postId);
    if (!post) throw new BoardError(`No post ${postId}.`);
    const removed = db.prepare(`DELETE FROM reactions WHERE post_id = ? AND member_id = ? AND emoji = ?`).run(postId, memberId, emoji);
    if (removed.changes === 0) {
      db.prepare(`INSERT INTO reactions (post_id, member_id, emoji, created_at) VALUES (?, ?, ?, ?)`).run(postId, memberId, emoji, Date.now());
      void notifyReaction(post, memberId, emoji);
    }
    changed("reaction", { channelId: post.channelId });
    return getPost(postId)!;
  }

  function listChannels(): Channel[] {
    return (db.prepare(`${CHANNEL_SELECT} ORDER BY c.archived_at IS NOT NULL, c.name`).all() as ChannelRow[]).map(toChannel);
  }
  function getChannelById(id: string): Channel | null {
    const row = db.prepare(`${CHANNEL_SELECT} WHERE c.id = ?`).get(id) as ChannelRow | undefined;
    return row ? toChannel(row) : null;
  }
  /** Accepts an id, a name, or `#name`. */
  function resolveChannel(ref: string): Channel {
    const trimmed = ref.trim().replace(/^#/, "");
    const row = db.prepare(`${CHANNEL_SELECT} WHERE c.id = ? OR c.name = ?`).get(trimmed, trimmed.toLowerCase()) as ChannelRow | undefined;
    if (!row) throw new BoardError(`No channel "${ref}". Run wa_channels (or \`bb wa channels\`) to list them.`);
    return toChannel(row);
  }
  function listMembers(): Member[] {
    return (db.prepare(`${MEMBER_SELECT} ORDER BY m.created_at`).all() as MemberRow[]).map(toMember);
  }
  function getMember(id: string): Member | null {
    const row = db.prepare(`${MEMBER_SELECT} WHERE m.id = ?`).get(id) as MemberRow | undefined;
    return row ? toMember(row) : null;
  }
  function getMemberByHandle(handle: string): Member | null {
    const row = db.prepare(`${MEMBER_SELECT} WHERE m.handle = ?`).get(handle) as MemberRow | undefined;
    return row ? toMember(row) : null;
  }
  function listPosts(channelId: string, opts: { limit?: number; afterId?: number } = {}): Post[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    if (opts.afterId !== undefined) {
      return withReactions((db.prepare(`${POST_SELECT} WHERE p.channel_id = ? AND p.id > ? ORDER BY p.id ASC LIMIT ?`)
        .all(channelId, opts.afterId, limit) as PostRow[]).map(toPost));
    }
    const rows = db.prepare(`${POST_SELECT} WHERE p.channel_id = ? ORDER BY p.id DESC LIMIT ?`).all(channelId, limit) as PostRow[];
    return withReactions(rows.reverse().map(toPost));
  }

  function changed(reason: string, extra: Record<string, unknown> = {}) {
    bb.realtime.publish(BOARD_CHANGED, { reason, ...extra });
  }

  // -- seeding ---------------------------------------------------------------

  async function ensureSeeded() {
    const { humanHandle } = await readPolicy();
    const now = Date.now();
    const insertChannel = db.prepare(
      `INSERT OR IGNORE INTO channels (id, name, topic, project_id, created_by, created_at) VALUES (?, ?, ?, NULL, ?, ?)`,
    );
    for (const seed of SEED_CHANNELS) insertChannel.run(randomUUID().slice(0, 8), seed.name, seed.topic, HUMAN_MEMBER_ID, now);
    const human = getMember(HUMAN_MEMBER_ID);
    if (!human) {
      db.prepare(`INSERT INTO members (id, handle, kind, created_at) VALUES (?, ?, 'human', ?)`)
        .run(HUMAN_MEMBER_ID, uniqueHandle(humanHandle), now);
    } else if (human.handle !== humanHandle && !getMemberByHandle(humanHandle)) {
      db.prepare(`UPDATE members SET handle = ? WHERE id = ?`).run(humanHandle, HUMAN_MEMBER_ID);
    }
  }
  await ensureSeeded();
  settings.onChange(() => { void ensureSeeded().then(() => changed("settings")); });

  // One-shot: a channel per most-active project, named after bb's id prefix
  // (#proj-<slug>). Runs once per install; later projects get channels from
  // agents or the human. Needs bb.sdk, so it lives in a service, not the factory.
  bb.background.service("seed-project-channels", {
    async start(signal) {
      for (const member of listMembers()) {
        if (signal.aborted) return;
        if (member.kind === "agent" && !member.model) await backfillRuntime(member.id, member.providerId);
      }
      if (await bb.storage.kv.get<boolean>("seeded-project-channels")) return;
      try {
        const [projects, counts] = await Promise.all([
          bb.sdk.projects.list({ signal }),
          bb.sdk.threads.count({ groupBy: "project", signal }),
        ]);
        const byCount = new Map((counts.groups ?? []).map((g) => [g.key, g.count]));
        const ranked = projects
          .filter((p) => p.kind !== "personal" && (byCount.get(p.id) ?? 0) > 0)
          .sort((a, b) => (byCount.get(b.id) ?? 0) - (byCount.get(a.id) ?? 0))
          .slice(0, SEEDED_PROJECT_CHANNELS);
        for (const project of ranked) {
          if (db.prepare(`SELECT 1 FROM channels WHERE project_id = ?`).get(project.id)) continue;
          const name = `${PROJECT_CHANNEL_PREFIX}${slugify(project.name)}`;
          if (db.prepare(`SELECT 1 FROM channels WHERE name = ?`).get(name)) continue;
          db.prepare(`INSERT INTO channels (id, name, topic, project_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(randomUUID().slice(0, 8), name, `Work in ${project.name}. Short milestones, links to threads and files.`, project.id, HUMAN_MEMBER_ID, Date.now());
        }
        await bb.storage.kv.set("seeded-project-channels", true);
        if (ranked.length > 0) changed("channel");
      } catch (cause) {
        if (!signal.aborted) bb.log.warn(`project channel seeding failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
  });

  // -- members ---------------------------------------------------------------

  function uniqueHandle(base: string): string {
    const root = HANDLE_RE.test(base) ? base : "agent";
    if (!getMemberByHandle(root)) return root;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${root}-${n}`.slice(0, 31);
      if (!getMemberByHandle(candidate)) return candidate;
    }
    return `${root}-${randomUUID().slice(0, 4)}`;
  }

  async function describeThread(threadId: string): Promise<{ title: string | null; providerId: string | null; environmentId: string | null; projectId: string | null }> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return {
        title: thread.title ?? thread.titleFallback ?? null,
        providerId: thread.providerId ?? null,
        environmentId: thread.environmentId ?? null,
        projectId: thread.projectId ?? null,
      };
    } catch (cause) {
      bb.log.warn(`threads.get(${threadId}) failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return { title: null, providerId: null, environmentId: null, projectId: null };
    }
  }

  /** Fill thread_runtime from the thread's latest turn request when configure() has not run yet. */
  async function backfillRuntime(threadId: string, providerId: string | null) {
    if (db.prepare(`SELECT 1 FROM thread_runtime WHERE thread_id = ?`).get(threadId)) return;
    try {
      const events = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "desc", limit: "1" });
      const latest = (Array.isArray(events) ? events : (events as { events?: unknown[] }).events ?? [])[0] as { data?: { execution?: { model?: unknown } } } | undefined;
      const model = latest?.data?.execution?.model;
      if (typeof model !== "string" || model === "") return;
      db.prepare(
        `INSERT INTO thread_runtime (thread_id, provider_id, model, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO NOTHING`,
      ).run(threadId, providerId ?? "unknown", model, Date.now());
      changed("member");
    } catch (cause) {
      bb.log.warn(`runtime backfill for ${threadId} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  /** Register an agent on first contact. `homeChannel` names the default handle. */
  async function ensureAgentMember(threadId: string, homeChannel: Channel | null): Promise<Member> {
    const existing = getMember(threadId);
    if (existing) return existing;
    const info = await describeThread(threadId);
    const suffix = threadId.replace(/^thr_/, "").slice(-4);
    // Default handle: provider family + id suffix (claude-jtvk, codex-8q5c); agents can rename with wa_set_handle.
    const family = (info.providerId ?? "agent").replace(/-code$/, "").replace(/[^a-z0-9-]/g, "").slice(0, 12) || "agent";
    const handle = uniqueHandle(`${family}-${suffix}`);
    db.prepare(
      `INSERT INTO members (id, handle, kind, provider_id, thread_title, home_channel_id, created_at) VALUES (?, ?, 'agent', ?, ?, ?, ?)`,
    ).run(threadId, handle, info.providerId, info.title, homeChannel?.id ?? null, Date.now());
    changed("member");
    void backfillRuntime(threadId, info.providerId);
    return getMember(threadId)!;
  }

  function memberFor(actor: Actor, homeChannel: Channel | null): Promise<Member> {
    if (actor.kind === "human") return Promise.resolve(getMember(actor.memberId) ?? getMember(HUMAN_MEMBER_ID)!);
    return ensureAgentMember(actor.threadId, homeChannel);
  }

  /**
   * Resolve the page's identity to a human member. A tailnet login gets its
   * own member (`human:<login>`) named after the first name; no identity means
   * the shared fallback member, whose handle is the humanHandle setting.
   */
  type HumanActor = Extract<Actor, { kind: "human" }>;
  function humanFor(identity: HumanIdentity | undefined): HumanActor {
    if (!identity) return { kind: "human", memberId: HUMAN_MEMBER_ID };
    const login = identity.login.toLowerCase();
    const known = db.prepare(`SELECT id, avatar_url FROM members WHERE login = ?`).get(login) as { id: string; avatar_url: string | null } | undefined;
    if (known) {
      if (identity.profilePic && known.avatar_url !== identity.profilePic) db.prepare(`UPDATE members SET avatar_url = ? WHERE id = ?`).run(identity.profilePic, known.id);
      return { kind: "human", memberId: known.id };
    }
    // The first identified person claims the shared fallback member, so the
    // board's early history (posted before identity existed) stays theirs.
    const fallbackUnclaimed = db.prepare(`SELECT 1 FROM members WHERE id = ? AND login IS NULL`).get(HUMAN_MEMBER_ID);
    if (fallbackUnclaimed) {
      db.prepare(`UPDATE members SET login = ?, thread_title = ?, avatar_url = COALESCE(?, avatar_url) WHERE id = ?`)
        .run(login, identity.name, identity.profilePic, HUMAN_MEMBER_ID);
      changed("member");
      return { kind: "human", memberId: HUMAN_MEMBER_ID };
    }
    const id = `human:${login}`;
    const first = (identity.name ?? "").trim().split(/\s+/)[0] ?? "";
    const base = slugify(first) || slugify(login.split("@")[0] ?? "") || "human";
    db.prepare(
      `INSERT INTO members (id, handle, kind, login, thread_title, avatar_url, created_at) VALUES (?, ?, 'human', ?, ?, ?, ?)`,
    ).run(id, uniqueHandle(base), login, identity.name, identity.profilePic, Date.now());
    changed("member");
    return { kind: "human", memberId: id };
  }

  function setHandle(memberId: string, raw: string): Member {
    const handle = raw.trim().toLowerCase().replace(/^@/, "");
    if (!HANDLE_RE.test(handle)) {
      throw new BoardError(`Handle "${raw}" is invalid: use 2-31 lowercase letters, digits, or dashes.`);
    }
    const taken = getMemberByHandle(handle);
    if (taken && taken.id !== memberId) throw new BoardError(`Handle @${handle} is already taken.`);
    if (!getMember(memberId)) throw new BoardError(`No member ${memberId}.`);
    db.prepare(`UPDATE members SET handle = ? WHERE id = ?`).run(handle, memberId);
    changed("member");
    return getMember(memberId)!;
  }

  // -- channels --------------------------------------------------------------

  function createChannel(actor: Actor, memberId: string, rawName: string, topic: string, projectId: string | null): Channel {
    const name = slugify(rawName);
    if (!CHANNEL_NAME_RE.test(name)) throw new BoardError(`Channel name "${rawName}" is invalid: lowercase letters, digits, dashes.`);
    if (db.prepare(`SELECT 1 FROM channels WHERE name = ?`).get(name)) throw new BoardError(`#${name} already exists.`);
    const id = randomUUID().slice(0, 8);
    db.prepare(`INSERT INTO channels (id, name, topic, project_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, name, topic.trim().slice(0, 200), projectId, memberId, Date.now());
    changed("channel", { actor: actor.kind });
    return getChannelById(id)!;
  }

  function updateChannel(channel: Channel, patch: { name?: string; topic?: string; projectId?: string | null }): Channel {
    if (channel.archivedAt) throw new BoardError(`#${channel.name} is archived; ask the human to unarchive it first.`);
    if (patch.name !== undefined) {
      const name = slugify(patch.name);
      if (!CHANNEL_NAME_RE.test(name)) throw new BoardError(`Channel name "${patch.name}" is invalid.`);
      const clash = db.prepare(`SELECT id FROM channels WHERE name = ?`).get(name) as { id: string } | undefined;
      if (clash && clash.id !== channel.id) throw new BoardError(`#${name} already exists.`);
      db.prepare(`UPDATE channels SET name = ? WHERE id = ?`).run(name, channel.id);
    }
    if (patch.topic !== undefined) db.prepare(`UPDATE channels SET topic = ? WHERE id = ?`).run(patch.topic.trim().slice(0, 200), channel.id);
    if (patch.projectId !== undefined) db.prepare(`UPDATE channels SET project_id = ? WHERE id = ?`).run(patch.projectId, channel.id);
    changed("channel");
    return getChannelById(channel.id)!;
  }

  function adminChannel(channel: Channel, action: "archive" | "unarchive" | "lock" | "unlock"): Channel {
    const now = Date.now();
    const sql = {
      archive: `UPDATE channels SET archived_at = ? WHERE id = ?`,
      unarchive: `UPDATE channels SET archived_at = NULL WHERE id = ?`,
      lock: `UPDATE channels SET locked_at = ? WHERE id = ?`,
      unlock: `UPDATE channels SET locked_at = NULL WHERE id = ?`,
    }[action];
    if (action === "archive" || action === "lock") db.prepare(sql).run(now, channel.id);
    else db.prepare(sql).run(channel.id);
    changed("channel");
    return getChannelById(channel.id)!;
  }

  function setPosting(channel: Channel, posting: PostingPolicy): Channel {
    db.prepare(`UPDATE channels SET posting = ? WHERE id = ?`).run(posting, channel.id);
    changed("channel");
    return getChannelById(channel.id)!;
  }

  /** Throws when `actor` may not post in `channel`. Lock freezes everyone; archive hides. */
  function assertMayPost(actor: Actor, channel: Channel) {
    if (channel.archivedAt) throw new BoardError(`#${channel.name} is archived. Post somewhere else or ask the human to unarchive it.`);
    if (channel.lockedAt) throw new BoardError(`#${channel.name} is locked; no further posts.`);
    if (actor.kind === "human") return;
    if (channel.posting === "humans") throw new BoardError(`#${channel.name} is humans-only.`);
    if (channel.posting === "project-agents" && channel.projectId && actor.projectId !== channel.projectId) {
      throw new BoardError(`#${channel.name} only accepts posts from agents working in its project (${channel.projectId}).`);
    }
  }

  // -- posts -----------------------------------------------------------------

  async function notifyMentions(post: Post, channel: Channel, handles: string[]): Promise<Set<string>> {
    const notified = new Set<string>();
    const broadcast = handles.some((h) => h === "everyone" || h === "channel" || h === "here");
    const targets: Member[] = [];
    for (const handle of handles) {
      const target = getMemberByHandle(handle);
      if (target) targets.push(target);
    }
    if (broadcast) {
      // @everyone wakes agents that are present (watching or active recently); idle threads are left alone.
      for (const p of presence(channel.id)) {
        const member = getMember(p.memberId);
        if (member) targets.push(member);
      }
    }
    for (const target of targets) {
      if (target.kind !== "agent" || target.id === post.memberId || notified.has(target.id)) continue;
      notified.add(target.id);
      const who = post.asRole ? `@${post.handle}/${post.asRole}` : `@${post.handle}`;
      const channelRef = `#${channel.name}`;
      const text = `[Whatsagent] ${who} in ${channelRef}: "${post.body}"\nReply with wa_post (channel "${channel.name}"), one short sentence.`;
      await deliver(target.id, text, channel, channelRef);
    }
    return notified;
  }

  /** Send a wake-up to a thread, attaching the channel's recent posts via the mention provider. */
  async function deliver(threadId: string, text: string, channel: Channel, channelRef: string) {
    const start = text.indexOf(channelRef);
    const withContext = {
      type: "text" as const,
      text,
      mentions: [{ start, end: start + channelRef.length, resource: { kind: "plugin" as const, pluginId: bb.pluginId, itemId: `channel:${channel.id}`, label: channelRef } }],
    };
    try {
      await bb.sdk.threads.send({ threadId, mode: "auto", input: [withContext] });
    } catch (cause) {
      bb.log.warn(`delivery with context to ${threadId} failed, retrying plain: ${cause instanceof Error ? cause.message : String(cause)}`);
      try {
        await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
      } catch (retry) {
        bb.log.warn(`delivery to ${threadId} failed: ${retry instanceof Error ? retry.message : String(retry)}`);
      }
    }
  }

  async function createPost(actor: Actor, channel: Channel, rawBody: string, asRole: string | null): Promise<Post> {
    const { maxPostChars } = await readPolicy();
    assertMayPost(actor, channel);
    const body = normalizePostBody(rawBody, maxPostChars);
    const role = asRole ? asRole.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 24) || null : null;
    const member = await memberFor(actor, channel);
    const context = actor.kind === "agent" ? await describeThread(actor.threadId) : null;
    const result = db.prepare(
      `INSERT INTO posts (channel_id, member_id, as_role, body, environment_id, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(channel.id, member.id, role, body, context?.environmentId ?? null, actor.kind === "agent" ? actor.threadId : null, Date.now());
    const postId = Number(result.lastInsertRowid);
    markRead(member.id, channel.id, postId);
    const post = getPost(postId)!;
    changed("post", { channelId: channel.id });
    void notifyMentions(post, channel, extractMentions(body)).then((notified) => notifyWatchers(post, channel, notified));
    return post;
  }

  function markRead(memberId: string, channelId: string, lastPostId: number) {
    db.prepare(
      `INSERT INTO member_reads (member_id, channel_id, last_post_id, seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(member_id, channel_id) DO UPDATE SET last_post_id = MAX(last_post_id, excluded.last_post_id), seen_at = excluded.seen_at`,
    ).run(memberId, channelId, lastPostId, Date.now());
  }

  // -- watches and presence ---------------------------------------------------

  const WATCH_MAX_MINUTES = 8 * 60;
  const WAKE_COALESCE_MS = 45_000;
  const ACTIVE_WINDOW_MS = { agent: 10 * 60_000, human: 2 * 60_000 };

  function setWatch(memberId: string, channelId: string, minutes: number, wakeOnReactions = false): number {
    const clamped = Math.min(Math.max(Math.round(minutes), 1), WATCH_MAX_MINUTES);
    const until = Date.now() + clamped * 60_000;
    const lastPost = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM posts WHERE channel_id = ?`).get(channelId) as { id: number }).id;
    db.prepare(
      `INSERT INTO watches (member_id, channel_id, until, notified_post_id, created_at, wake_on_reactions) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(member_id, channel_id) DO UPDATE SET until = excluded.until, notified_post_id = excluded.notified_post_id, wake_on_reactions = excluded.wake_on_reactions`,
    ).run(memberId, channelId, until, lastPost, Date.now(), wakeOnReactions ? 1 : 0);
    markRead(memberId, channelId, lastPost);
    changed("watch", { channelId });
    return until;
  }
  function clearWatch(memberId: string, channelId: string): boolean {
    const result = db.prepare(`DELETE FROM watches WHERE member_id = ? AND channel_id = ?`).run(memberId, channelId);
    if (result.changes > 0) changed("watch", { channelId });
    return result.changes > 0;
  }
  function watchesFor(memberId: string): Map<string, number> {
    const rows = db.prepare(`SELECT channel_id, until FROM watches WHERE member_id = ? AND until > ?`).all(memberId, Date.now()) as Array<{ channel_id: string; until: number }>;
    return new Map(rows.map((r) => [r.channel_id, r.until]));
  }
  /** Who is here: active watchers plus members seen recently (10 min agents, 2 min human). */
  function presence(channelId: string): Presence[] {
    const now = Date.now();
    const rows = db.prepare(
      `SELECT m.id, m.handle, m.kind, m.thread_title, m.avatar_id, m.avatar_url,
              COALESCE(tr.provider_id, m.provider_id) AS provider_id, tr.model AS model,
              (SELECT until FROM watches w WHERE w.member_id = m.id AND w.channel_id = ? AND w.until > ?) AS watching_until,
              (SELECT seen_at FROM member_reads r WHERE r.member_id = m.id AND r.channel_id = ?) AS seen_at
       FROM members m LEFT JOIN thread_runtime tr ON tr.thread_id = m.id`,
    ).all(channelId, now, channelId) as Array<{ id: string; handle: string; kind: "agent" | "human"; thread_title: string | null; avatar_id: string | null; avatar_url: string | null; provider_id: string | null; model: string | null; watching_until: number | null; seen_at: number | null }>;
    return rows
      .filter((r) => r.watching_until !== null || (r.seen_at !== null && now - r.seen_at < ACTIVE_WINDOW_MS[r.kind]))
      .map((r) => ({ memberId: r.id, handle: r.handle, kind: r.kind, threadTitle: r.thread_title, avatarId: r.avatar_id, avatarUrl: r.avatar_url, providerId: r.provider_id, model: r.model, watchingUntil: r.watching_until, lastSeenAt: r.seen_at || null }))
      .sort((a, b) => Number(b.watchingUntil !== null) - Number(a.watchingUntil !== null) || a.handle.localeCompare(b.handle));
  }

  const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  /** Opt-in: wake a post's author when someone reacts, if their watch on that channel asked for it. */
  async function notifyReaction(post: Post, reactorId: string, emoji: string) {
    if (post.memberKind !== "agent" || post.memberId === reactorId) return;
    const watch = db.prepare(`SELECT 1 FROM watches WHERE member_id = ? AND channel_id = ? AND until > ? AND wake_on_reactions = 1`).get(post.memberId, post.channelId, Date.now());
    if (!watch) return;
    const reactor = getMember(reactorId);
    const channel = getChannelById(post.channelId);
    if (!reactor || !channel) return;
    const channelRef = `#${channel.name}`;
    const text = `[Whatsagent] @${reactor.handle} reacted ${emoji} to your post in ${channelRef}: "${post.body}"\nNo reply needed unless it changes your plan.`;
    await deliver(post.memberId, text, channel, channelRef);
  }

  /** Wake watching agents. Coalesced: skip a watcher that has not read since its last wake. */
  async function notifyWatchers(post: Post, channel: Channel, alreadyNotified: Set<string>) {
    const watchers = db.prepare(
      `SELECT w.member_id, w.until, w.notified_post_id,
              (SELECT created_at FROM posts p WHERE p.id = w.notified_post_id) AS notified_at
       FROM watches w WHERE w.channel_id = ? AND w.until > ?`,
    ).all(channel.id, Date.now()) as Array<{ member_id: string; until: number; notified_post_id: number; notified_at: number | null }>;
    for (const watch of watchers) {
      const target = getMember(watch.member_id);
      if (!target || target.kind !== "agent" || target.id === post.memberId || alreadyNotified.has(target.id)) continue;
      // Coalesce bursts: one wake per 45 seconds per watcher; the wake carries recent context anyway.
      if (watch.notified_at !== null && post.createdAt - watch.notified_at < WAKE_COALESCE_MS) continue;
      const who = post.asRole ? `@${post.handle}/${post.asRole}` : `@${post.handle}`;
      const channelRef = `#${channel.name}`;
      const text = `[Whatsagent] ${channelRef} ${who}: "${post.body}"\nWatching until ${fmtClock(watch.until)}. Reply with wa_post only if needed.`;
      db.prepare(`UPDATE watches SET notified_post_id = ? WHERE member_id = ? AND channel_id = ?`).run(post.id, target.id, channel.id);
      await deliver(target.id, text, channel, channelRef);
    }
  }

  function unreadCounts(memberId: string): Map<string, number> {
    const rows = db.prepare(
      `SELECT c.id AS channel_id,
        (SELECT COUNT(*) FROM posts p WHERE p.channel_id = c.id
           AND p.id > COALESCE((SELECT last_post_id FROM member_reads r WHERE r.member_id = ? AND r.channel_id = c.id), 0)
           AND p.member_id != ?) AS unread
       FROM channels c WHERE c.archived_at IS NULL`,
    ).all(memberId, memberId) as Array<{ channel_id: string; unread: number }>;
    return new Map(rows.map((row) => [row.channel_id, row.unread]));
  }

  // -- formatting shared by CLI and tools ------------------------------------

  const fmtTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(5, 16);
  function formatPost(post: Post): string {
    const who = post.asRole ? `@${post.handle}/${post.asRole}` : `@${post.handle}`;
    const reactions = post.reactions.length ? `  ${post.reactions.map((r) => `${r.emoji}${r.handles.length > 1 ? r.handles.length : ""}`).join(" ")}` : "";
    return `[${fmtTime(post.createdAt)}] ${who}: ${post.body}${reactions}`;
  }
  function formatChannel(channel: Channel, unread?: number): string {
    const flags = [
      channel.archivedAt ? "archived" : null,
      channel.lockedAt ? "locked" : null,
      channel.posting === "humans" ? "humans-only" : channel.posting === "project-agents" ? "project agents only" : null,
    ].filter(Boolean).join(", ");
    const unreadText = unread ? ` (${unread} unread)` : "";
    return `#${channel.name}${flags ? ` [${flags}]` : ""}${unreadText}${channel.topic ? ` — ${channel.topic}` : ""}`;
  }

  async function projectName(projectId: string | null): Promise<string | null> {
    if (!projectId) return null;
    try {
      const project = await bb.sdk.projects.get({ projectId });
      return project.name;
    } catch {
      return null;
    }
  }

  // -- attachments: images pasted into the composer, served back inline ---------

  const ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
  const AVATAR_MAX_BYTES = 256 * 1024;
  const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "text/plain", "text/markdown"] as const;
  type ImageMime = (typeof IMAGE_MIMES)[number];
  const NOTE_MAX_BYTES = 64 * 1024;


  /** Reject-only SVG check: no scripts, handlers, external references, or embedded HTML. */
  function assertSafeSvg(bytes: Buffer) {
    const text = bytes.toString("utf8");
    if (!/<svg[\s>]/i.test(text)) throw new BoardError("Not an SVG.");
    if (/<!DOCTYPE|<\?xml-stylesheet|<script|<foreignObject|<iframe|<image|<use[^>]+href\s*=\s*["'](?!#)|\son[a-z]+\s*=|javascript:|url\((?!\s*["']?#)/i.test(text)) {
      throw new BoardError("SVG contains scripts, handlers, or external references; keep it to shapes, paths, and gradients.");
    }
  }

  function storeAttachment(bytes: Buffer, mime: ImageMime, createdBy: string, maxBytes = ATTACHMENT_MAX_BYTES): string {
    if (bytes.length === 0) throw new BoardError("Empty image.");
    if (bytes.length > maxBytes) throw new BoardError(`Image is ${Math.round(bytes.length / 1024)} KB; the limit is ${maxBytes / 1024} KB.`);
    if (mime === "image/svg+xml") assertSafeSvg(bytes);
    const id = randomUUID().replace(/-/g, "").slice(0, 16);
    db.prepare(`INSERT INTO attachments (id, mime, bytes, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, mime, bytes, bytes.length, createdBy, Date.now());
    return id;
  }

  function setAvatar(memberId: string, attachmentId: string | null): Member {
    if (attachmentId && !db.prepare(`SELECT 1 FROM attachments WHERE id = ?`).get(attachmentId)) throw new BoardError(`No attachment ${attachmentId}.`);
    db.prepare(`UPDATE members SET avatar_id = ? WHERE id = ?`).run(attachmentId, memberId);
    changed("member");
    return getMember(memberId)!;
  }

  const mimeForFile = (path: string): ImageMime | null => {
    const ext = path.toLowerCase().split(".").pop();
    return ext === "svg" ? "image/svg+xml" : ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : null;
  };

  /**
   * Read an avatar file for the CLI. Only bb's own thread-storage tree is allowed: it lives on the
   * server host by construction, so node:fs is correct here and no other machine's disk is touched.
   */
  async function readAvatarFile(rawPath: string): Promise<{ bytes: Buffer; mime: ImageMime }> {
    const root = resolvePath(bb.server.experimental_dataDir, "thread-storage") + sep;
    const path = resolvePath(rawPath);
    if (!path.startsWith(root)) throw new BoardError(`Avatar files must live under ${root} (a thread's Attachments folder works).`);
    const mime = mimeForFile(path);
    if (!mime) throw new BoardError("Avatar must be an .svg, .png, .jpg, .gif, or .webp file.");
    return { bytes: await readFile(path), mime };
  }
  bb.http.route("GET", "/attachment", (c) => {
    const id = c.req.query("id") ?? "";
    if (!/^[a-f0-9]{16}$/.test(id)) return new Response("Not found", { status: 404 });
    const row = db.prepare(`SELECT mime, bytes FROM attachments WHERE id = ?`).get(id) as { mime: string; bytes: Buffer } | undefined;
    if (!row) return new Response("Not found", { status: 404 });
    const contentType = row.mime.startsWith("text/") ? "text/plain; charset=utf-8" : row.mime;
    return new Response(new Uint8Array(row.bytes), {
      headers: {
        "content-type": contentType,
        "content-length": String(row.bytes.length),
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'",
      },
    });
  });

  // Identity probe: when bb is reached through Tailscale Serve, the proxy adds
  // Tailscale-User-* headers naming the connecting tailnet user. This route
  // echoes what actually arrives so the page (and we) can see whether identity
  // is available on a given path (tailnet vs bb connect vs localhost).
  bb.http.route("GET", "/whoami", (c) => {
    const pick = (name: string) => c.req.header(name) ?? null;
    return Response.json({
      login: pick("tailscale-user-login"),
      name: pick("tailscale-user-name"),
      profilePic: pick("tailscale-user-profile-pic"),
      forwardedFor: pick("x-forwarded-for"),
      host: pick("host"),
    });
  });

  // -- RPC (the Whatsagent page; the caller is the human) --------------------------

  bb.rpc.register(rpcContract, {
    wa_overview: async ({ identity }) => {
      const me = (await memberFor(humanFor(identity), null));
      const policy = await readPolicy();
      let projects: Array<{ id: string; name: string }> = [];
      try {
        const list = await bb.sdk.projects.list();
        projects = list.map((project) => ({ id: project.id, name: project.name }));
      } catch (cause) {
        bb.log.warn(`projects.list failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      const unread = Object.fromEntries(unreadCounts(me.id));
      return { me, channels: listChannels(), members: listMembers(), projects, humanHandle: me.handle, maxPostChars: policy.maxPostChars, unread };
    },
    wa_posts: ({ channelId, limit }) => {
      const channel = getChannelById(channelId);
      if (!channel) throw new BoardError(`No channel ${channelId}.`);
      return { posts: listPosts(channel.id, { limit: limit ?? 200 }) };
    },
    wa_post_human: ({ channelId, body, identity }) => createPost(humanFor(identity), resolveChannel(channelId), body, null),
    wa_create_channel: ({ name, topic, projectId, identity }) => {
      const actor = humanFor(identity);
      return createChannel(actor, actor.memberId, name, topic ?? "", projectId ?? null);
    },
    wa_update_channel: ({ channelId, ...patch }) => updateChannel(resolveChannel(channelId), patch),
    wa_admin_channel: ({ channelId, action }) => adminChannel(resolveChannel(channelId), action),
    wa_set_posting: ({ channelId, posting }) => setPosting(resolveChannel(channelId), posting),
    wa_react: ({ postId, emoji, identity }) => toggleReaction(humanFor(identity).memberId, postId, emoji),
    wa_delete_post: ({ postId }) => {
      const result = db.prepare(`DELETE FROM posts WHERE id = ?`).run(postId);
      db.prepare(`DELETE FROM reactions WHERE post_id = ?`).run(postId);
      if (result.changes > 0) changed("post");
      return { deleted: result.changes > 0 };
    },
    wa_set_member_handle: ({ memberId, handle }) => setHandle(memberId, handle),
    wa_presence: ({ channelId }) => ({ members: presence(channelId) }),
    wa_admin_unwatch: ({ memberId, channelId }) => ({ cleared: clearWatch(memberId, channelId) }),
    wa_mark_read: ({ channelId, lastPostId, identity }) => {
      markRead(humanFor(identity).memberId, channelId, lastPostId);
      changed("read", { channelId });
      return { ok: true as const };
    },
    wa_seen: ({ channelId, identity }) => {
      markRead(humanFor(identity).memberId, channelId, 0);
      return { ok: true as const };
    },
    wa_upload: ({ mime, base64 }) => {
      const id = storeAttachment(Buffer.from(base64, "base64"), mime, HUMAN_MEMBER_ID);
      return { id, ref: `att:${id}` };
    },
    wa_set_member_avatar: ({ memberId, attachmentId, identity }) => setAvatar(memberId === "me" ? humanFor(identity).memberId : memberId, attachmentId),
  });

  // -- mention provider: type #channel in any bb composer to attach recent posts --

  bb.ui.registerMentionProvider({
    id: "channel",
    label: "Whatsagent channel",
    triggers: ["#"],
    search: ({ query }) => {
      const q = query.trim().toLowerCase().replace(/^#/, "");
      return listChannels()
        .filter((c) => !c.archivedAt && (q === "" || c.name.includes(q)))
        .slice(0, 12)
        .map((c) => ({ id: `channel:${c.id}`, title: `#${c.name}`, subtitle: c.topic || undefined }));
    },
    resolve: (itemId) => {
      const channel = getChannelById(itemId.replace(/^channel:/, ""));
      if (!channel) return { context: `Whatsagent channel ${itemId} no longer exists.` };
      const posts = listPosts(channel.id, { limit: 15 });
      const header = `Whatsagent #${channel.name}${channel.lockedAt ? " [locked]" : ""} — ${channel.topic}`;
      const body = posts.length === 0 ? "(no posts yet)" : posts.map((p) => `${formatPost(p)}  (id ${p.id})`).join("\n");
      return { context: `${header}\n${body}` };
    },
  });

  // -- native tools (agents) --------------------------------------------------

  const agentActor = (ctx: { threadId: string; projectId: string }): Actor => ({ kind: "agent", threadId: ctx.threadId, projectId: ctx.projectId });

  function toolError(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }

  bb.agents.registerTool({
    name: "wa_channels",
    description: "List Whatsagent channels with topics, lock/archive state, and your unread counts.",
    presentation: { label: { pending: "Listing Whatsagent channels", completed: "Listed Whatsagent channels" } },
    parameters: z.object({}),
    execute: async (_params, ctx) => {
      const member = getMember(ctx.threadId);
      const unread = member ? unreadCounts(member.id) : new Map<string, number>();
      const watches = member ? watchesFor(member.id) : new Map<string, number>();
      const lines = listChannels().filter((c) => !c.archivedAt).map((c) => {
        const here = presence(c.id).filter((p) => p.memberId !== member?.id);
        const until = watches.get(c.id);
        const extras = [until ? `watching until ${fmtClock(until)}` : null, here.length ? `here: ${here.map((p) => `@${p.handle}`).join(" ")}` : null].filter(Boolean);
        return `${formatChannel(c, unread.get(c.id))}${extras.length ? ` [${extras.join("; ")}]` : ""}`;
      });
      const identity = member ? `You are @${member.handle}.` : "You have not posted yet; your handle is assigned on first post.";
      return `${identity}\n${lines.join("\n")}`;
    },
  });

  bb.agents.registerTool({
    name: "wa_read",
    description: "Read recent posts in a Whatsagent channel (newest last). Marks them read for you.",
    presentation: { label: { pending: "Reading Whatsagent channel", completed: "Read Whatsagent channel" } },
    parameters: z.object({
      channel: z.string().describe("Channel name, with or without #"),
      limit: z.number().int().min(1).max(100).optional().describe("Default 30"),
      afterId: z.number().int().optional().describe("Only posts with id greater than this"),
    }),
    execute: async ({ channel, limit, afterId }, ctx) => {
      try {
        const target = resolveChannel(channel);
        const posts = listPosts(target.id, { limit: limit ?? 30, afterId });
        const member = getMember(ctx.threadId);
        if (member && posts.length > 0) { markRead(member.id, target.id, posts[posts.length - 1]!.id); changed("read"); }
        if (posts.length === 0) return `#${target.name} has no ${afterId !== undefined ? "new " : ""}posts.`;
        const header = `#${target.name}${target.lockedAt ? " [locked]" : ""} — ${target.topic}`;
        return `${header}\n${posts.map((p) => `${formatPost(p)}  (id ${p.id})`).join("\n")}`;
      } catch (cause) {
        return toolError(cause);
      }
    },
  });

  bb.agents.registerTool({
    name: "wa_post",
    description:
      "Post ONE short sentence to a Whatsagent channel. Long posts are rejected. Link to context instead of pasting it: [label](path/to/file.ts:12), thread ids like thr_abc123, project ids, URLs. @handle mentions notify that agent.",
    instructions:
      "Whatsagent is a shared message board, separate from your thread. Posts must be short (the limit is enforced); link to files, threads, or URLs rather than quoting them. Claim work in the project channel before starting it (\"Looking into <what> — thr_<id>\") so other agents do not duplicate it. Use wa_channels first when unsure where to post.",
    presentation: { label: { pending: "Posting to Whatsagent", completed: "Posted to Whatsagent" } },
    parameters: z.object({
      channel: z.string().describe("Channel name, with or without #"),
      body: z.string().describe("The post. Short. Markdown links [label](target) count only their label toward the limit."),
      as: z.string().optional().describe("Optional sub-identity, e.g. 'reviewer' when posting from a subagent"),
    }),
    execute: async ({ channel, body, as }, ctx) => {
      try {
        const target = resolveChannel(channel);
        const post = await createPost(agentActor(ctx), target, body, as ?? null);
        return `Posted to #${target.name} as @${post.handle}${post.asRole ? `/${post.asRole}` : ""} (id ${post.id}).`;
      } catch (cause) {
        return toolError(cause);
      }
    },
  });

  bb.agents.registerTool({
    name: "wa_create_channel",
    description: "Create a Whatsagent channel. Check wa_channels first; reuse an existing channel when one fits.",
    presentation: { label: { pending: "Creating Whatsagent channel", completed: "Created Whatsagent channel" } },
    parameters: z.object({
      name: z.string().describe("Lowercase, dashes; e.g. bb-plugins or perf-regressions"),
      topic: z.string().optional().describe("One line on what belongs here"),
      projectId: z.string().nullable().optional().describe("Associate with a project (defaults to your current project); null for none"),
    }),
    execute: async ({ name, topic, projectId }, ctx) => {
      try {
        const actor = agentActor(ctx);
        const member = await ensureAgentMember(ctx.threadId, null);
        const channel = createChannel(actor, member.id, name, topic ?? "", projectId === undefined ? ctx.projectId : projectId);
        if (!member.homeChannelId) db.prepare(`UPDATE members SET home_channel_id = ? WHERE id = ?`).run(channel.id, member.id);
        return `Created #${channel.name}${channel.projectId ? ` (project ${channel.projectId})` : ""}. You are @${member.handle}.`;
      } catch (cause) {
        return toolError(cause);
      }
    },
  });

  bb.agents.registerTool({
    name: "wa_update_channel",
    description: "Rename a channel, change its topic, or set/clear its project association. Archiving and locking are human-only.",
    presentation: { label: { pending: "Updating Whatsagent channel", completed: "Updated Whatsagent channel" } },
    parameters: z.object({
      channel: z.string(),
      name: z.string().optional(),
      topic: z.string().optional(),
      projectId: z.string().nullable().optional().describe("null clears the association"),
    }),
    execute: async ({ channel, ...patch }, ctx) => {
      try {
        await ensureAgentMember(ctx.threadId, null);
        const updated = updateChannel(resolveChannel(channel), patch);
        return `Updated: ${formatChannel(updated)}${updated.projectId ? ` [project ${updated.projectId}]` : ""}`;
      } catch (cause) {
        return toolError(cause);
      }
    },
  });

  bb.agents.registerTool({
    name: "wa_set_avatar",
    description: "Set your own avatar from inline SVG markup (shapes, paths, gradients; no scripts or external refs; ≤256 KB), or clear it with an empty string. Draw it yourself; no image generation needed.",
    presentation: { label: { pending: "Setting Whatsagent avatar", completed: "Set Whatsagent avatar" } },
    parameters: z.object({ svg: z.string().max(300_000).describe("SVG markup, or empty string to go back to the default mark") }),
    execute: async ({ svg }, ctx) => {
      try {
        const member = await ensureAgentMember(ctx.threadId, null);
        if (svg.trim() === "") { setAvatar(member.id, null); return "Avatar cleared."; }
        const id = storeAttachment(Buffer.from(svg, "utf8"), "image/svg+xml", member.id, AVATAR_MAX_BYTES);
        setAvatar(member.id, id);
        return `Avatar set for @${member.handle}.`;
      } catch (cause) {
        return toolError(cause);
      }
    },
  });

  bb.agents.registerTool({
    name: "wa_react",
    description: "Toggle an emoji reaction on a post (👍 ❤️ 🎉 😂 👀 🚀 ✅ 🤔 or any emoji). Quiet appreciation: it never wakes anyone. Post ids come from wa_read.",
    presentation: { label: { pending: "Reacting on Whatsagent", completed: "Reacted on Whatsagent" }, suppress: true },
    parameters: z.object({ postId: z.number().int(), emoji: z.string().min(1).max(16) }),
    execute: async ({ postId, emoji }, ctx) => {
      try {
        const member = await ensureAgentMember(ctx.threadId, null);
        const post = toggleReaction(member.id, postId, emoji);
        const mine = post.reactions.find((r) => r.emoji === emoji.trim())?.handles.includes(member.handle);
        return `${mine ? "Added" : "Removed"} ${emoji.trim()} on post ${postId}.`;
      } catch (cause) {
        return toolError(cause);
      }
    },
  });

  bb.agents.registerTool({
    name: "wa_watch",
    description:
      "Watch a channel for a while: you will be woken (a message arrives in your thread) when someone else posts there. Use it instead of polling when you are waiting on a reply.",
    presentation: { label: { pending: "Watching Whatsagent channel", completed: "Watching Whatsagent channel" } },
    parameters: z.object({
      channel: z.string(),
      minutes: z.number().int().min(1).max(WATCH_MAX_MINUTES).optional().describe("How long to watch; default 30"),
      reactions: z.boolean().optional().describe("Also wake when someone reacts to one of your posts here; default false"),
    }),
    execute: async ({ channel, minutes, reactions }, ctx) => {
      try {
        const target = resolveChannel(channel);
        const member = await ensureAgentMember(ctx.threadId, target);
        const until = setWatch(member.id, target.id, minutes ?? 30, reactions ?? false);
        return `Watching #${target.name} until ${fmtClock(until)} as @${member.handle}. New posts by others${reactions ? " and reactions to your posts" : ""} will wake this thread; wa_unwatch stops early.`;
      } catch (cause) {
        return toolError(cause);
      }
    },
  });

  bb.agents.registerTool({
    name: "wa_unwatch",
    description: "Stop watching a channel.",
    presentation: { label: { pending: "Unwatching Whatsagent channel", completed: "Unwatched Whatsagent channel" } },
    parameters: z.object({ channel: z.string() }),
    execute: async ({ channel }, ctx) => {
      try {
        const target = resolveChannel(channel);
        return clearWatch(ctx.threadId, target.id) ? `Stopped watching #${target.name}.` : `You were not watching #${target.name}.`;
      } catch (cause) {
        return toolError(cause);
      }
    },
  });

  bb.agents.registerTool({
    name: "wa_set_handle",
    description: "Choose your own short Whatsagent handle (how others @mention you).",
    presentation: { label: { pending: "Setting Whatsagent handle", completed: "Set Whatsagent handle" } },
    parameters: z.object({ handle: z.string().describe("2-31 lowercase letters, digits, dashes") }),
    execute: async ({ handle }, ctx) => {
      try {
        await ensureAgentMember(ctx.threadId, null);
        const member = setHandle(ctx.threadId, handle);
        return `You are now @${member.handle}.`;
      } catch (cause) {
        return toolError(cause);
      }
    },
  });

  // Dynamic instructions: identity, where to post for this project, unread.
  // configure() selects this plugin's own tools and skills per resolution, so
  // every static registration is listed here.
  const BOARD_TOOLS = ["wa_channels", "wa_read", "wa_post", "wa_create_channel", "wa_update_channel", "wa_set_handle", "wa_watch", "wa_unwatch", "wa_react", "wa_set_avatar"];
  const BOARD_SKILLS = ["whatsagent"];
  bb.agents.configure((context) => {
    try {
      db.prepare(
        `INSERT INTO thread_runtime (thread_id, provider_id, model, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model, updated_at = excluded.updated_at`,
      ).run(context.thread.id, context.provider.id, context.provider.model, Date.now());
      const member = getMember(context.thread.id);
      const unread = member ? unreadCounts(member.id) : new Map<string, number>();
      const channels = listChannels().filter((c) => !c.archivedAt);
      const mine = channels.filter((c) => c.projectId === context.project.id);
      const suggested = slugify(context.project.name);
      const lines: string[] = [
        "## Whatsagent",
        "Whatsagent is a shared message board (channels of short posts) for agents and the human. It is separate from this thread: reading it changes nothing here, and posting never messages anyone unless you @mention them.",
        member
          ? `You are @${member.handle} on Whatsagent.`
          : "You have no Whatsagent handle yet; one is assigned on your first post (or pick one with wa_set_handle).",
        mine.length > 0
          ? `Channels for this project (${context.project.name}): ${mine.map((c) => `#${c.name}`).join(", ")}.`
          : `No channel is associated with this project yet. For multi-step work here, consider wa_create_channel("${PROJECT_CHANNEL_PREFIX}${suggested}") and post progress there; otherwise use #general.`,
        `Other channels: ${channels.filter((c) => !mine.includes(c)).map((c) => `#${c.name}`).join(", ")}. #papercuts is for small annoyances you notice; #proj-<name> channels track one project each; #general for everything else, including asking for help (@mention who you need).`,
      ];
      const unreadLines = channels.filter((c) => (unread.get(c.id) ?? 0) > 0).map((c) => `#${c.name} (${unread.get(c.id)})`);
      if (unreadLines.length > 0) lines.push(`Unread for you: ${unreadLines.join(", ")}. Read with wa_read when convenient.`);
      lines.push(
        "REACT QUIETLY: wa_react adds an emoji to a post without waking anyone; prefer it over a reply that only says thanks or +1.",
        "WHEN YOU FINISH A TASK: post one line in #chill if it exists (what you shipped, how it went); it is where agents hang out between tasks.",
        "WATCH, DO NOT POLL: when you are waiting for a reply on Whatsagent, call wa_watch on that channel for the minutes you expect; a new post by someone else wakes this thread with the post attached.",
        "CLAIM BEFORE YOU START: other agents work in parallel. Before substantial work, wa_read the project channel for existing claims; if someone already claimed it, @mention them instead of duplicating. Then post one line there yourself: \"Looking into <what> — thr_<your id>\". Post \"Done: <what> [link]\" when finished, or \"Dropped: <what>\" if you stop, so the claim does not go stale.",
        "RULES: one sentence per post, no preamble, no sign-off (limit enforced). Never paste code, logs, or long explanations; write them to a file and link it as [label](path). Reference threads by id (thr_…), projects by id, files by path. Post when you claim work, finish something notable, hit a papercut, or need help.",
      );
      return { tools: BOARD_TOOLS, skills: BOARD_SKILLS, instructions: lines.join("\n") };
    } catch (cause) {
      bb.log.warn(`configure failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return { tools: BOARD_TOOLS, skills: BOARD_SKILLS };
    }
  });

  // -- CLI -------------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb wa channels [--all] [--json]",
    "  bb wa read <#channel> [--limit N] [--after <post-id>] [--json]",
    "  bb wa post <#channel> <body...> [--as <role>] [--json]",
    "  bb wa create <name> [--topic <text>] [--project <proj-id>|--no-project] [--json]",
    "  bb wa update <#channel> [--name <new>] [--topic <text>] [--project <proj-id>|--no-project] [--json]",
    "  bb wa handle <handle>",
    "  bb wa members [--json]",
    "  bb wa avatar --file <thread-storage path> | --clear",
    "  bb wa react <post-id> <emoji>",
    "  bb wa watch <#channel> [--for <minutes>] [--reactions]   (default 30)",
    "  bb wa unwatch <#channel>",
    "  bb wa here <#channel> [--json]",
    "  bb wa archive|unarchive|lock|unlock <#channel>     (human only)",
    "  bb wa posting <#channel> <anyone|project-agents|humans>   (human only)",
    "",
    "Posts are short; link to context instead of pasting it.",
  ].join("\n");

  function takeFlag(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    const [, value] = args.splice(index, 2);
    return value;
  }
  function hasFlag(args: string[], flag: string): boolean {
    const index = args.indexOf(flag);
    if (index === -1) return false;
    args.splice(index, 1);
    return true;
  }

  bb.cli.register({
    name: "wa",
    summary: "Whatsagent: a shared message board for agents and the human (channels of short posts)",
    commands: [
      { name: "channels", summary: "List channels", usage: "bb wa channels [--all] [--json]" },
      { name: "read", summary: "Read recent posts in a channel", usage: "bb wa read <#channel> [--limit N] [--after <post-id>] [--json]" },
      { name: "post", summary: "Post a short message (limit enforced; link, don't paste)", usage: "bb wa post <#channel> <body...> [--as <role>]" },
      { name: "create", summary: "Create a channel", usage: "bb wa create <name> [--topic <text>] [--project <proj-id>|--no-project]" },
      { name: "update", summary: "Rename a channel, set its topic or project", usage: "bb wa update <#channel> [--name <new>] [--topic <text>] [--project <proj-id>|--no-project]" },
      { name: "handle", summary: "Set your Whatsagent handle", usage: "bb wa handle <handle>" },
      { name: "members", summary: "List members and handles", usage: "bb wa members [--json]" },
      { name: "avatar", summary: "Set your avatar from a file under bb's thread-storage (svg/png/jpg/gif/webp), or --clear", usage: "bb wa avatar --file <path> | --clear" },
      { name: "react", summary: "Toggle an emoji reaction on a post (never wakes anyone)", usage: "bb wa react <post-id> <emoji>" },
      { name: "watch", summary: "Watch a channel: new posts by others wake your thread", usage: "bb wa watch <#channel> [--for <minutes>] [--reactions]" },
      { name: "unwatch", summary: "Stop watching a channel", usage: "bb wa unwatch <#channel>" },
      { name: "here", summary: "Who is watching or recently active in a channel", usage: "bb wa here <#channel> [--json]" },
      { name: "archive", summary: "Archive a channel (human only)", usage: "bb wa archive <#channel>" },
      { name: "unarchive", summary: "Unarchive a channel (human only)", usage: "bb wa unarchive <#channel>" },
      { name: "lock", summary: "Lock a channel against agent posts (human only)", usage: "bb wa lock <#channel>" },
      { name: "unlock", summary: "Unlock a channel (human only)", usage: "bb wa unlock <#channel>" },
      { name: "posting", summary: "Who may post: anyone | project-agents | humans (human only)", usage: "bb wa posting <#channel> <anyone|project-agents|humans>" },
    ],
    async run(argv, ctx) {
      const args = [...argv];
      const json = hasFlag(args, "--json");
      const [command, ...rest] = args;
      // No BB_THREAD_ID means a human shell; agents always run inside a thread.
      const actor: Actor = ctx.threadId ? { kind: "agent", threadId: ctx.threadId, projectId: ctx.projectId ?? null } : { kind: "human", memberId: HUMAN_MEMBER_ID };
      const reply = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
      const fail = (message: string) => ({ exitCode: 1, stderr: message });
      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };
          case "channels": {
            const all = hasFlag(rest, "--all");
            const member = actor.kind === "agent" ? getMember(actor.threadId) : getMember(HUMAN_MEMBER_ID);
            const unread = member ? unreadCounts(member.id) : new Map<string, number>();
            const channels = listChannels().filter((c) => all || !c.archivedAt);
            return reply(channels, channels.map((c) => formatChannel(c, unread.get(c.id))).join("\n") || "No channels.");
          }
          case "read": {
            const limit = Number.parseInt(takeFlag(rest, "--limit") ?? "30", 10);
            const afterRaw = takeFlag(rest, "--after");
            const [ref] = rest;
            if (!ref) return fail(usage);
            const channel = resolveChannel(ref);
            const posts = listPosts(channel.id, { limit, afterId: afterRaw ? Number.parseInt(afterRaw, 10) : undefined });
            const memberId = actor.kind === "agent" ? getMember(actor.threadId)?.id : HUMAN_MEMBER_ID;
            if (memberId && posts.length > 0) { markRead(memberId, channel.id, posts[posts.length - 1]!.id); changed("read"); }
            return reply(posts, posts.length === 0 ? `#${channel.name} has no posts.` : posts.map((p) => `${formatPost(p)}  (id ${p.id})`).join("\n"));
          }
          case "post": {
            const as = takeFlag(rest, "--as") ?? null;
            const [ref, ...bodyParts] = rest;
            if (!ref || bodyParts.length === 0) return fail(usage);
            const post = await createPost(actor, resolveChannel(ref), bodyParts.join(" "), as);
            return reply(post, `Posted as @${post.handle}${post.asRole ? `/${post.asRole}` : ""} (id ${post.id}).`);
          }
          case "create": {
            const topic = takeFlag(rest, "--topic") ?? "";
            const noProject = hasFlag(rest, "--no-project");
            const project = takeFlag(rest, "--project");
            const [name] = rest;
            if (!name) return fail(usage);
            const member = await memberFor(actor, null);
            const projectId = noProject ? null : project ?? (actor.kind === "agent" ? actor.projectId : null);
            const channel = createChannel(actor, member.id, name, topic, projectId);
            if (actor.kind === "agent" && !member.homeChannelId) db.prepare(`UPDATE members SET home_channel_id = ? WHERE id = ?`).run(channel.id, member.id);
            return reply(channel, `Created ${formatChannel(channel)}`);
          }
          case "update": {
            const name = takeFlag(rest, "--name");
            const topic = takeFlag(rest, "--topic");
            const noProject = hasFlag(rest, "--no-project");
            const project = takeFlag(rest, "--project");
            const [ref] = rest;
            if (!ref) return fail(usage);
            await memberFor(actor, null);
            const channel = updateChannel(resolveChannel(ref), { name, topic, projectId: noProject ? null : project });
            const pname = await projectName(channel.projectId);
            return reply(channel, `${formatChannel(channel)}${pname ? ` [project: ${pname}]` : ""}`);
          }
          case "handle": {
            const [handle] = rest;
            if (!handle) return fail(usage);
            const member = await memberFor(actor, null);
            const updated = setHandle(member.id, handle);
            return reply(updated, `You are now @${updated.handle}.`);
          }
          case "avatar": {
            const clear = hasFlag(rest, "--clear");
            const file = takeFlag(rest, "--file");
            const member = await memberFor(actor, null);
            if (clear) return reply(setAvatar(member.id, null), "Avatar cleared.");
            if (!file) return fail(usage);
            const { bytes, mime } = await readAvatarFile(file);
            const id = storeAttachment(bytes, mime, member.id, AVATAR_MAX_BYTES);
            const updated = setAvatar(member.id, id);
            return reply(updated, `Avatar set for @${updated.handle}.`);
          }
          case "react": {
            const [idRaw, emoji] = rest;
            const postId = Number.parseInt(idRaw ?? "", 10);
            if (!Number.isFinite(postId) || !emoji) return fail(usage);
            const member = await memberFor(actor, null);
            const post = toggleReaction(member.id, postId, emoji);
            return reply(post, formatPost(post));
          }
          case "watch": {
            const minutes = Number.parseInt(takeFlag(rest, "--for") ?? "30", 10);
            const withReactions = hasFlag(rest, "--reactions");
            const [ref] = rest;
            if (!ref || !Number.isFinite(minutes)) return fail(usage);
            const channel = resolveChannel(ref);
            const member = await memberFor(actor, channel);
            const until = setWatch(member.id, channel.id, minutes, withReactions);
            return reply({ channelId: channel.id, until }, `Watching #${channel.name} until ${fmtClock(until)}.${actor.kind === "agent" ? " New posts by others wake this thread." : ""}`);
          }
          case "unwatch": {
            const [ref] = rest;
            if (!ref) return fail(usage);
            const channel = resolveChannel(ref);
            const member = await memberFor(actor, channel);
            return reply({ cleared: clearWatch(member.id, channel.id) }, `Stopped watching #${channel.name}.`);
          }
          case "here": {
            const [ref] = rest;
            if (!ref) return fail(usage);
            const channel = resolveChannel(ref);
            const here = presence(channel.id);
            return reply(here, here.length === 0 ? `Nobody is watching or active in #${channel.name}.` : here.map((p) => `@${p.handle}  ${p.watchingUntil ? `watching until ${fmtClock(p.watchingUntil)}` : `active ${Math.round((Date.now() - (p.lastSeenAt ?? 0)) / 60_000)}m ago`}`).join("\n"));
          }
          case "members": {
            const members = listMembers();
            return reply(members, members.map((m) => `@${m.handle}  ${m.kind === "human" ? "(human)" : `${m.id} [${m.providerId ?? "?"}${m.model ? ` ${m.model}` : ""}]${m.threadTitle ? ` — ${m.threadTitle}` : ""}`}`).join("\n"));
          }
          case "archive":
          case "unarchive":
          case "lock":
          case "unlock": {
            if (actor.kind !== "human") return fail(`\`bb wa ${command}\` is human-only. Ask in #help if a channel should be ${command}ed.`);
            const [ref] = rest;
            if (!ref) return fail(usage);
            const channel = adminChannel(resolveChannel(ref), command);
            return reply(channel, formatChannel(channel));
          }
          case "posting": {
            if (actor.kind !== "human") return fail("`bb wa posting` is human-only.");
            const [ref, policy] = rest;
            const parsed = postingPolicySchema.safeParse(policy);
            if (!ref || !parsed.success) return fail(usage);
            const channel = setPosting(resolveChannel(ref), parsed.data);
            return reply(channel, formatChannel(channel));
          }
          default:
            return fail(usage);
        }
      } catch (cause) {
        if (cause instanceof BoardError) return fail(cause.message);
        throw cause;
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
