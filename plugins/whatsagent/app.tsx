// Whatsagent — frontend. A left channel list and a center channel view.
//
// References inside posts render as bb-native links: thr_… opens the thread,
// proj_… opens the project, paths open the file preview (scoped to the
// posting thread's environment), URLs use UrlLink, #channel switches channel,
// @handle opens that agent's thread.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  definePluginApp,
  experimental_FileLink as FileLink,
  experimental_useProviders as useProviders,
  UrlLink,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { SmileIcon } from "@hugeicons/core-free-icons";
import type { Channel, Member, Post, PostingPolicy, Presence, rpcContract } from "./server";

const REACTION_PALETTE = ["👍", "❤️", "🎉", "😂", "👀", "🚀", "✅", "🤔"];
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Overview = {
  channels: Channel[];
  members: Member[];
  projects: Array<{ id: string; name: string }>;
  humanHandle: string;
  maxPostChars: number;
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function useOverview() {
  const rpc = useRpc<typeof rpcContract>();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("wa_overview").then(
      (result) => {
        setOverview(result);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("board-changed", refetch);
  return { rpc, overview, error, refetch };
}

function usePosts(rpc: Rpc, channelId: string | null) {
  const [posts, setPosts] = useState<Post[]>([]);
  const refetch = useCallback(() => {
    if (!channelId) {
      setPosts([]);
      return;
    }
    rpc.call("wa_posts", { channelId, limit: 300 }).then(
      (result) => setPosts(result.posts),
      (cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, channelId]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("board-changed", (payload) => {
    const reason = (payload as { reason?: string } | null)?.reason;
    if (reason === "post" || reason === "member" || reason === "settings" || reason === "reaction") refetch();
  });
  return { posts, refetch };
}

/** Who is watching or recently active; also heartbeats the human's presence while the channel is open. */
function usePresence(rpc: Rpc, channelId: string | null) {
  const [members, setMembers] = useState<Presence[]>([]);
  const refetch = useCallback(() => {
    if (!channelId) return;
    rpc.call("wa_presence", { channelId }).then((result) => setMembers(result.members), () => undefined);
  }, [rpc, channelId]);
  useEffect(() => {
    if (!channelId) {
      setMembers([]);
      return;
    }
    const beat = () => rpc.call("wa_seen", { channelId }).then(refetch, () => undefined);
    beat();
    const timer = setInterval(beat, 60_000);
    return () => clearInterval(timer);
  }, [rpc, channelId, refetch]);
  useRealtime("board-changed", (payload) => {
    const reason = (payload as { reason?: string } | null)?.reason;
    if (reason === "watch" || reason === "post" || reason === "read") refetch();
  });
  return members;
}

// ---------------------------------------------------------------------------
// Post body rendering: tokenizer for references
// ---------------------------------------------------------------------------

type Token =
  | { kind: "text"; text: string }
  | { kind: "url"; href: string }
  | { kind: "thread"; id: string }
  | { kind: "project"; id: string }
  | { kind: "channel"; name: string }
  | { kind: "handle"; handle: string }
  | { kind: "file"; label: string; path: string; line: number | null }
  | { kind: "code"; text: string }
  | { kind: "image"; alt: string; id: string };

const TOKEN_RE = new RegExp(
  [
    String.raw`!\[([^\]]*)\]\(att:([a-f0-9]{16})\)`, // 1,2 inline image attachment
    String.raw`\[([^\]]+)\]\(([^)\s]+)\)`, // 3,4 markdown link
    String.raw`(https?://[^\s<>()]+[^\s<>().,;:!?'"])`, // 3 url
    String.raw`\b(thr_[a-z0-9]{6,})\b`, // 4 thread id
    String.raw`\b(proj_[a-z0-9]{6,})\b`, // 5 project id
    String.raw`(?:^|(?<=[\s(]))#([a-z0-9][a-z0-9-]*)`, // 6 channel
    String.raw`(?:^|(?<=[\s(]))@([a-z0-9][a-z0-9-]{1,30})(?:/([a-z0-9-]+))?`, // 7,8 handle(/role)
    "`([^`]+)`", // 9 inline code
    String.raw`((?:\.{0,2}/)?(?:[\w@.-]+/)+[\w@.-]+(?::\d+)?|[\w-]+\.(?:tsx?|jsx?|mjs|md|json|py|rs|go|css|html|sh|ya?ml|toml|sql|swift|kt|java)(?::\d+)?)`, // 10 path
  ].join("|"),
  "g",
);

function splitPath(raw: string): { path: string; line: number | null } {
  const match = /^(.*?):(\d+)(?::\d+)?$/.exec(raw);
  return match ? { path: match[1]!, line: Number.parseInt(match[2]!, 10) } : { path: raw, line: null };
}

export function tokenize(body: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of body.matchAll(TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ kind: "text", text: body.slice(last, index) });
    last = index + match[0].length;
    const [, imgAlt, imgId, mdLabel, mdTarget, url, thread, project, channel, handle, role, code, path] = match;
    if (imgId !== undefined) tokens.push({ kind: "image", alt: imgAlt ?? "", id: imgId });
    else if (mdLabel !== undefined && mdTarget !== undefined) {
      if (/^https?:\/\//.test(mdTarget)) tokens.push({ kind: "url", href: mdTarget });
      else if (/^thr_/.test(mdTarget)) tokens.push({ kind: "thread", id: mdTarget });
      else if (/^proj_/.test(mdTarget)) tokens.push({ kind: "project", id: mdTarget });
      else tokens.push({ kind: "file", label: mdLabel, ...splitPath(mdTarget) });
    } else if (url) tokens.push({ kind: "url", href: url });
    else if (thread) tokens.push({ kind: "thread", id: thread });
    else if (project) tokens.push({ kind: "project", id: project });
    else if (channel) tokens.push({ kind: "channel", name: channel });
    else if (handle) tokens.push({ kind: "handle", handle: role ? `${handle}/${role}` : handle });
    else if (code !== undefined) tokens.push({ kind: "code", text: code });
    else if (path) tokens.push({ kind: "file", label: path, ...splitPath(path) });
  }
  if (last < body.length) tokens.push({ kind: "text", text: body.slice(last) });
  return tokens;
}

const linkClass = "text-primary underline-offset-2 hover:underline";

type ProviderLookup = Map<string, { displayName: string; logoUrl: string | null }>;

/** Short model name for a chip: drops a leading provider family prefix and date suffixes. */
function shortModel(model: string): string {
  return model.replace(/^(claude|gpt|gemini|openai)[-_]/i, "").replace(/-\d{8}$/, "");
}

function ModelChip({ providerId, model, providers, title }: { providerId: string | null; model: string | null; providers: ProviderLookup; title?: string }) {
  if (!providerId && !model) return null;
  const provider = providerId ? providers.get(providerId) : undefined;
  return (
    <span className="inline-flex h-4 shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-[10px] leading-none text-muted-foreground" title={title ?? `${provider?.displayName ?? providerId ?? ""} ${model ?? ""}`.trim()}>
      {provider?.logoUrl ? (
        // Masked so the mark takes the chip's text color in both themes instead of the logo's baked-in color.
        <span
          aria-hidden="true"
          className="inline-block size-2.5 shrink-0 bg-current"
          style={{ maskImage: `url(${provider.logoUrl})`, WebkitMaskImage: `url(${provider.logoUrl})`, maskSize: "contain", WebkitMaskSize: "contain", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat", maskPosition: "center", WebkitMaskPosition: "center" }}
        />
      ) : null}
      <span className="max-w-32 truncate">{model ? shortModel(model) : provider?.displayName ?? providerId}</span>
    </span>
  );
}
const attachmentUrl = (id: string) => `/api/v1/plugins/whatsagent/http/attachment?id=${id}`;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function PostBody({
  post,
  members,
  channels,
  onChannel,
}: {
  post: Post;
  members: Member[];
  channels: Channel[];
  onChannel: (channel: Channel) => void;
}) {
  const navigate = useBbNavigate();
  const tokens = useMemo(() => tokenize(post.body), [post.body]);
  return (
    <span className="whitespace-pre-wrap break-words">
      {tokens.map((token, index) => {
        switch (token.kind) {
          case "text":
            return <span key={index}>{token.text}</span>;
          case "code":
            return (
              <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                {token.text}
              </code>
            );
          case "image":
            return (
              <a key={index} href={attachmentUrl(token.id)} target="_blank" rel="noopener noreferrer" className="my-1 block w-fit">
                <img src={attachmentUrl(token.id)} alt={token.alt} className="max-h-72 max-w-full rounded-md border border-border" loading="lazy" />
              </a>
            );
          case "url":
            return (
              <UrlLink key={index} href={token.href} className={linkClass}>
                {token.href.replace(/^https?:\/\//, "")}
              </UrlLink>
            );
          case "thread": {
            const member = members.find((m) => m.id === token.id);
            return (
              <button key={index} type="button" className={cn(linkClass, "font-mono text-[0.9em]")} onClick={() => navigate.toThread(token.id)} title={member?.threadTitle ?? token.id}>
                {member?.threadTitle ? `thread: ${member.threadTitle}` : token.id}
              </button>
            );
          }
          case "project":
            return (
              <button key={index} type="button" className={cn(linkClass, "font-mono text-[0.9em]")} onClick={() => navigate.toProject(token.id)}>
                {token.id}
              </button>
            );
          case "channel": {
            const channel = channels.find((c) => c.name === token.name);
            if (!channel) return <span key={index}>#{token.name}</span>;
            return (
              <button key={index} type="button" className={cn(linkClass, "font-medium")} onClick={() => onChannel(channel)}>
                #{token.name}
              </button>
            );
          }
          case "handle": {
            const base = token.handle.split("/")[0]!;
            const member = members.find((m) => m.handle === base);
            const label = <span className="rounded bg-primary/10 px-1 font-medium text-primary">@{token.handle}</span>;
            if (!member || member.kind !== "agent") return <span key={index}>{label}</span>;
            return (
              <button key={index} type="button" onClick={() => navigate.toThread(member.id)} title={member.threadTitle ?? member.id}>
                {label}
              </button>
            );
          }
          case "file": {
            if (!post.environmentId) {
              return (
                <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]" title="No environment attached to this post">
                  {token.label}
                </code>
              );
            }
            return (
              <FileLink
                key={index}
                target={{ kind: "workspace", environmentId: post.environmentId, path: token.path }}
                location={token.line ? { kind: "line", line: token.line, column: null } : null}
                className={cn(linkClass, "font-mono text-[0.9em]")}
              >
                {token.label}
              </FileLink>
            );
          }
        }
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Layout pieces
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
function dayLabel(ms: number): string {
  const date = new Date(ms);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms >= startOfToday) return "Today";
  if (ms >= startOfToday - DAY_MS) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function Avatar({ handle, kind, onClick, title }: { handle: string; kind: "agent" | "human"; onClick?: () => void; title?: string }) {
  const initials = handle.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";
  const className = cn(
    "flex size-8 shrink-0 select-none items-center justify-center rounded-full text-[11px] font-semibold",
    kind === "human" ? "bg-primary/15 text-primary" : "bg-muted text-foreground",
    onClick && "hover:ring-2 hover:ring-ring/40",
  );
  return onClick ? (
    <button type="button" className={className} onClick={onClick} title={title} aria-label={`Open ${handle}'s thread`}>
      {initials}
    </button>
  ) : (
    <div className={className} title={title}>{initials}</div>
  );
}

function ChannelList({
  channels,
  activeId,
  onSelect,
  onCreate,
}: {
  channels: Channel[];
  activeId: string | null;
  onSelect: (channel: Channel) => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const live = [...channels.filter((c) => !c.archivedAt)].sort((a, b) => {
    if (a.name === "general") return -1;
    if (b.name === "general") return 1;
    return a.name.localeCompare(b.name);
  });
  const archived = channels.filter((c) => c.archivedAt);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") return;
    await onCreate(name);
    setName("");
    setCreating(false);
  };
  const row = (channel: Channel) => (
    <button
      key={channel.id}
      type="button"
      onClick={() => onSelect(channel)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] leading-5 hover:bg-state-hover",
        channel.id === activeId ? "bg-state-active font-medium text-foreground" : "text-muted-foreground",
        channel.archivedAt && "italic",
      )}
    >
      <span className="w-3 text-center opacity-50">#</span>
      <span className="min-w-0 flex-1 truncate">{channel.name}</span>
      {channel.lockedAt ? <Icon name="Lock" className="size-3 opacity-60" /> : null}
    </button>
  );
  return (
    <nav className="flex h-full w-56 shrink-0 flex-col border-r border-border bg-card/40">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-2">
        <div className="space-y-px">{live.map(row)}</div>
        {creating ? (
          <form onSubmit={submit} className="mt-1 px-1">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setCreating(false); }}
              placeholder="new-channel"
              aria-label="New channel name"
              className="h-7 text-xs"
            />
          </form>
        ) : (
          <button type="button" className="mt-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={() => setCreating(true)}>
            <Icon name="Plus" className="size-3.5" />
            <span>New channel</span>
          </button>
        )}
        {archived.length > 0 ? (
          <div className="mt-3">
            <button type="button" className="w-full px-2 pb-1 text-left text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setShowArchived((v) => !v)}>
              Archived ({archived.length}) {showArchived ? "▾" : "▸"}
            </button>
            {showArchived ? <div className="space-y-px">{archived.map(row)}</div> : null}
          </div>
        ) : null}
      </div>
    </nav>
  );
}

function ChannelSettings({
  channel,
  projects,
  rpc,
  refetch,
  onEdit,
}: {
  channel: Channel;
  projects: Array<{ id: string; name: string }>;
  rpc: Rpc;
  refetch: () => void;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      refetch();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const admin = (action: "archive" | "unarchive" | "lock" | "unlock") => run(() => rpc.call("wa_admin_channel", { channelId: channel.id, action }));
  const project = projects.find((p) => p.id === channel.projectId);
  const projectLabel = project?.name ?? channel.projectId ?? "None";
  const postingOptions: Array<{ value: PostingPolicy; label: string; hint: string }> = [
    { value: "anyone", label: "Anyone", hint: "Every agent and you" },
    { value: "project-agents", label: `Only ${channel.projectId ? projectLabel : "project"} agents`, hint: channel.projectId ? "Agents working in this project, and you" : "Needs a project association" },
    { value: "humans", label: "Only humans", hint: "Agents can read but not post" },
  ];
  const menuRow = "flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Channel settings">
          <span className="text-lg leading-none">⋮</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1.5">
        <button type="button" className={menuRow} onClick={() => { setOpen(false); onEdit(); }} disabled={!!channel.archivedAt}>
          <span>Edit name &amp; topic</span>
        </button>
        <label className={menuRow}>
          <span>Project</span>
          <select
            className="h-7 max-w-36 rounded-md border border-input bg-transparent px-1.5 text-xs text-foreground"
            value={channel.projectId ?? ""}
            aria-label="Associated project"
            disabled={!!channel.archivedAt}
            onChange={(event) => run(() => rpc.call("wa_update_channel", { channelId: channel.id, projectId: event.target.value === "" ? null : event.target.value }))}
          >
            <option value="">None</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
            {channel.projectId && !project ? <option value={channel.projectId}>{channel.projectId}</option> : null}
          </select>
        </label>
        <div className="mt-1 border-t border-border pt-1">
          <div className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Who can post</div>
          {postingOptions.map((option) => (
            <label key={option.value} className={cn(menuRow, "justify-start gap-2")}>
              <input
                type="radio"
                name={`posting-${channel.id}`}
                className="accent-primary"
                checked={channel.posting === option.value}
                disabled={!!channel.archivedAt || (option.value === "project-agents" && !channel.projectId)}
                onChange={() => run(() => rpc.call("wa_set_posting", { channelId: channel.id, posting: option.value }))}
              />
              <span className="flex min-w-0 flex-col">
                <span>{option.label}</span>
                <span className="text-[11px] text-muted-foreground">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="mt-1 border-t border-border pt-1">
          <button type="button" className={menuRow} onClick={() => (channel.lockedAt ? admin("unlock") : admin("lock"))} disabled={!!channel.archivedAt}>
            <span>{channel.lockedAt ? "Unlock channel" : "Lock channel"}</span>
            <span className="text-[11px] text-muted-foreground">{channel.lockedAt ? "Allow new posts" : "Freeze all posts"}</span>
          </button>
          <button type="button" className={cn(menuRow, !channel.archivedAt && "hover:text-destructive")} onClick={() => { setOpen(false); void (channel.archivedAt ? admin("unarchive") : admin("archive")); }}>
            <span>{channel.archivedAt ? "Unarchive channel" : "Archive channel"}</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function describePresence(p: Presence): string {
  if (p.watchingUntil) return `watching until ${clockTime(p.watchingUntil)}`;
  if (p.lastSeenAt) {
    const minutes = Math.max(0, Math.round((Date.now() - p.lastSeenAt) / 60_000));
    return minutes === 0 ? "active now" : `active ${minutes}m ago`;
  }
  return "";
}

function PresenceChip({ presence, providers }: { presence: Presence[]; providers: ProviderLookup }) {
  const navigate = useBbNavigate();
  const watching = presence.filter((p) => p.watchingUntil).length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground" aria-label={`${presence.length} here`}>
          <Icon name="UserRound" className="size-3.5" />
          {presence.length}
          {watching > 0 ? <span className="ml-0.5 size-1.5 rounded-full bg-success" aria-label={`${watching} watching`} /> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1.5">
        <div className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Here now</div>
        {presence.length === 0 ? <p className="px-2 pb-1 text-sm text-muted-foreground">Nobody is watching or active.</p> : null}
        {presence.map((p) => {
          const row = (
            <>
              <span className={cn("size-2 shrink-0 rounded-full", p.watchingUntil ? "bg-success" : "bg-muted-foreground/50")} />
              <span className="font-medium">@{p.handle}</span>
              {p.kind === "human" ? <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">human</span> : <span className="min-w-0 flex-1"><ModelChip providerId={p.providerId} model={p.model} providers={providers} title={p.threadTitle ?? undefined} /></span>}
              <span className="shrink-0 text-[11px] text-muted-foreground">{describePresence(p)}</span>
            </>
          );
          const className = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover";
          return p.kind === "agent" ? (
            <button key={p.memberId} type="button" className={className} onClick={() => navigate.toThread(p.memberId)} title="Open thread">{row}</button>
          ) : (
            <div key={p.memberId} className={className}>{row}</div>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

function ChannelHeader({
  channel,
  projects,
  presence,
  providers,
  rpc,
  refetch,
}: {
  channel: Channel;
  projects: Array<{ id: string; name: string }>;
  presence: Presence[];
  providers: ProviderLookup;
  rpc: Rpc;
  refetch: () => void;
}) {
  const [editing, setEditing] = useState<null | { name: string; topic: string }>(null);
  const badge = (text: string) => <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{text}</span>;

  if (editing) {
    return (
      <header className="border-b border-border px-5 py-3">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            rpc.call("wa_update_channel", { channelId: channel.id, name: editing.name, topic: editing.topic }).then(
              () => { setEditing(null); refetch(); },
              (cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)),
            );
          }}
        >
          <span className="text-muted-foreground">#</span>
          <Input autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label="Channel name" className="h-8 w-44 text-sm" />
          <Input value={editing.topic} onChange={(e) => setEditing({ ...editing, topic: e.target.value })} aria-label="Channel topic" placeholder="Topic" className="h-8 flex-1 text-sm" />
          <Button type="submit" size="sm">Save</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
        </form>
      </header>
    );
  }

  return (
    <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-[15px] font-semibold leading-tight">#{channel.name}</h2>
          {channel.lockedAt ? badge("locked") : null}
          {channel.archivedAt ? badge("archived") : null}
          {channel.posting === "humans" ? badge("humans only") : channel.posting === "project-agents" ? badge("project agents") : null}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{channel.topic || "No topic yet."}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <PresenceChip presence={presence} providers={providers} />
        <ChannelSettings channel={channel} projects={projects} rpc={rpc} refetch={refetch} onEdit={() => setEditing({ name: channel.name, topic: channel.topic })} />
      </div>
    </header>
  );
}

function ReactionPicker({ onReact, className }: { onReact: (emoji: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn("rounded p-0.5 text-muted-foreground hover:text-foreground", className)} aria-label="Add reaction" title="Add reaction">
          <HugeiconsIcon icon={SmileIcon} className="size-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-1">
        <div className="flex gap-0.5">
          {REACTION_PALETTE.map((emoji) => (
            <button key={emoji} type="button" className="size-7 rounded-md text-base hover:bg-state-hover" onClick={() => { onReact(emoji); setOpen(false); }} aria-label={`React ${emoji}`}>
              {emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Reactions({ post, humanHandle, onReact }: { post: Post; humanHandle: string; onReact: (emoji: string) => void }) {
  if (post.reactions.length === 0) return null;
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1">
      {post.reactions.map((reaction) => {
        const mine = reaction.handles.includes(humanHandle);
        return (
          <button
            key={reaction.emoji}
            type="button"
            className={cn(
              "inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-[11px] leading-none hover:bg-state-hover",
              mine ? "border-primary/40 bg-primary/10 text-foreground" : "border-border text-muted-foreground",
            )}
            title={reaction.handles.map((h) => `@${h}`).join(", ")}
            aria-pressed={mine}
            onClick={() => onReact(reaction.emoji)}
          >
            <span>{reaction.emoji}</span>
            {reaction.handles.length > 1 ? <span>{reaction.handles.length}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

type PostGroup = { key: string; memberId: string; handle: string; kind: "agent" | "human"; threadId: string | null; who: string; posts: Post[] };

function groupPosts(posts: Post[]): Array<{ day: string; groups: PostGroup[] }> {
  const days: Array<{ day: string; groups: PostGroup[] }> = [];
  for (const post of posts) {
    const day = dayLabel(post.createdAt);
    let bucket = days[days.length - 1];
    if (!bucket || bucket.day !== day) {
      bucket = { day, groups: [] };
      days.push(bucket);
    }
    const last = bucket.groups[bucket.groups.length - 1];
    const who = post.asRole ? `${post.handle}/${post.asRole}` : post.handle;
    const lastPost = last?.posts[last.posts.length - 1];
    if (last && last.memberId === post.memberId && last.who === who && lastPost && post.createdAt - lastPost.createdAt < 5 * 60_000) {
      last.posts.push(post);
    } else {
      bucket.groups.push({ key: String(post.id), memberId: post.memberId, handle: post.handle, kind: post.memberKind, threadId: post.threadId, who, posts: [post] });
    }
  }
  return days;
}

function PostList({
  posts,
  members,
  channels,
  providers,
  humanHandle,
  onChannel,
  onDelete,
  onReact,
}: {
  posts: Post[];
  members: Member[];
  channels: Channel[];
  providers: ProviderLookup;
  humanHandle: string;
  onChannel: (channel: Channel) => void;
  onDelete: (post: Post) => void;
  onReact: (post: Post, emoji: string) => void;
}) {
  const navigate = useBbNavigate();
  const bottom = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [posts]);
  const days = useMemo(() => groupPosts(posts), [posts]);
  if (posts.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
        <span>Nothing here yet.</span>
        <span className="text-xs">Agents post with the <code className="rounded bg-muted px-1">wa_post</code> tool; you post below.</span>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
      {days.map(({ day, groups }) => (
        <div key={day}>
          <div className="my-3 flex items-center gap-3 text-[11px] text-muted-foreground">
            <div className="h-px flex-1 bg-border" />
            <span>{day}</span>
            <div className="h-px flex-1 bg-border" />
          </div>
          {groups.map((group) => {
            const member = members.find((m) => m.id === group.memberId);
            const title = member?.threadTitle ?? group.threadId ?? undefined;
            return (
              <div key={group.key} className="mb-3 flex gap-3">
                <Avatar handle={group.handle} kind={group.kind} title={title} onClick={group.kind === "agent" && group.threadId ? () => navigate.toThread(group.threadId!) : undefined} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 leading-tight">
                    {group.kind === "agent" && group.threadId ? (
                      <button type="button" className="text-[13px] font-semibold hover:underline" onClick={() => navigate.toThread(group.threadId!)} title={title}>
                        {group.who}
                      </button>
                    ) : (
                      <span className="text-[13px] font-semibold">{group.who}</span>
                    )}
                    {group.kind === "agent" && member ? <ModelChip providerId={member.providerId} model={member.model} providers={providers} title={member.threadTitle ?? undefined} /> : null}
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{clockTime(group.posts[0]!.createdAt)}</span>
                  </div>
                  {group.posts.map((post) => (
                    <div key={post.id} className="group -mx-2 flex items-start gap-2 rounded px-2 py-0.5 text-sm leading-relaxed hover:bg-state-hover/60">
                      <div className="min-w-0 flex-1">
                        <PostBody post={post} members={members} channels={channels} onChannel={onChannel} />
                        <Reactions post={post} humanHandle={humanHandle} onReact={(emoji) => onReact(post, emoji)} />
                      </div>
                      <span className="invisible flex shrink-0 items-center gap-1.5 pt-0.5 group-hover:visible has-[[data-state=open]]:visible">
                        <ReactionPicker onReact={(emoji) => onReact(post, emoji)} />
                        <button type="button" className="text-xs text-muted-foreground hover:text-destructive" aria-label="Delete post" title="Delete post" onClick={() => onDelete(post)}>
                          ×
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ))}
      <div ref={bottom} />
    </div>
  );
}

type Suggestion = { insert: string; title: string; subtitle?: string };

/** Drafts survive plugin reloads and channel switches. */
const draftKey = (channelId: string) => `whatsagent:draft:${channelId}`;
function readDraft(channelId: string): string {
  try {
    return window.localStorage.getItem(draftKey(channelId)) ?? "";
  } catch {
    return "";
  }
}
function writeDraft(channelId: string, value: string) {
  try {
    if (value === "") window.localStorage.removeItem(draftKey(channelId));
    else window.localStorage.setItem(draftKey(channelId), value);
  } catch {
    // storage unavailable; the draft just lives in state
  }
}

/** Finds an `@word` or `#word` token ending at the caret. */
function activeTrigger(text: string, caret: number): { trigger: "@" | "#"; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const match = /(^|[\s(])([@#])([a-z0-9-]*)$/i.exec(before);
  if (!match) return null;
  return { trigger: match[2] as "@" | "#", query: match[3]!.toLowerCase(), start: before.length - match[2]!.length - match[3]!.length };
}

function Composer({
  channel,
  members,
  channels,
  maxPostChars,
  onSend,
  onUpload,
}: {
  channel: Channel;
  members: Member[];
  channels: Channel[];
  maxPostChars: number;
  onSend: (body: string) => Promise<void>;
  onUpload: (file: File) => Promise<string>;
}) {
  const [body, setBodyState] = useState(() => readDraft(channel.id));
  const [caret, setCaret] = useState(0);
  const [pending, setPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const setBody = useCallback(
    (value: string) => {
      setBodyState(value);
      writeDraft(channel.id, value);
    },
    [channel.id],
  );
  useEffect(() => {
    const draft = readDraft(channel.id);
    setBodyState(draft);
    setCaret(draft.length);
  }, [channel.id]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const disabled = !!channel.archivedAt;

  const trigger = useMemo(() => activeTrigger(body, caret), [body, caret]);
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!trigger) return [];
    if (trigger.trigger === "@") {
      return members
        .filter((m) => m.handle.includes(trigger.query))
        .slice(0, 8)
        .map((m) => ({ insert: `@${m.handle} `, title: `@${m.handle}`, subtitle: m.kind === "human" ? "human" : m.threadTitle ?? m.id }));
    }
    return channels
      .filter((c) => !c.archivedAt && c.name.includes(trigger.query))
      .slice(0, 8)
      .map((c) => ({ insert: `#${c.name} `, title: `#${c.name}`, subtitle: c.topic || undefined }));
  }, [trigger, members, channels]);
  const menuKey = trigger ? `${trigger.trigger}${trigger.start}` : null;
  const showMenu = suggestions.length > 0 && menuKey !== null && dismissed !== menuKey;

  useEffect(() => setHighlight(0), [menuKey, suggestions.length]);

  const accept = (suggestion: Suggestion) => {
    if (!trigger) return;
    const next = body.slice(0, trigger.start) + suggestion.insert + body.slice(caret);
    const nextCaret = trigger.start + suggestion.insert.length;
    setBody(next);
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const attach = async (files: Iterable<File>) => {
    const images = Array.from(files).filter((f) => IMAGE_MIMES.has(f.type));
    if (images.length === 0 || disabled) return;
    setUploading(true);
    try {
      let next = body;
      for (const file of images) {
        const ref = await onUpload(file);
        next = `${next}${next === "" || next.endsWith(" ") ? "" : " "}![image](${ref}) `;
      }
      setBody(next);
      setCaret(next.length);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploading(false);
      inputRef.current?.focus();
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (body.trim() === "" || pending || disabled) return;
    setPending(true);
    try {
      await onSend(body);
      setBody("");
      setCaret(0);
    } finally {
      setPending(false);
    }
  };
  const cost = Array.from(body.replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")).length;
  const over = cost > maxPostChars;
  return (
    <div className="relative border-t border-border px-5 pb-3 pt-2">
      {showMenu ? (
        <ul role="listbox" className="absolute bottom-full left-5 z-10 mb-1 w-80 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.title}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlight}
                className={cn("flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm", index === highlight ? "bg-state-active" : "hover:bg-state-hover")}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(event) => { event.preventDefault(); accept(suggestion); }}
              >
                <span className="font-medium">{suggestion.title}</span>
                {suggestion.subtitle ? <span className="min-w-0 truncate text-xs text-muted-foreground">{suggestion.subtitle}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        onSubmit={submit}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
        onDrop={(e) => { if (e.dataTransfer.files.length > 0) { e.preventDefault(); void attach(Array.from(e.dataTransfer.files)); } }}
        className={cn("flex items-center gap-2 rounded-lg border border-input bg-background px-3 py-1.5 focus-within:ring-1 focus-within:ring-ring", over && "border-destructive")}
      >
        <input
          ref={inputRef}
          value={body}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.some((f) => IMAGE_MIMES.has(f.type))) { e.preventDefault(); void attach(files); }
          }}
          onChange={(e) => { setBody(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setDismissed(null); }}
          onSelect={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (!showMenu) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => (h + 1) % suggestions.length); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length); }
            else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); accept(suggestions[highlight] ?? suggestions[0]!); }
            else if (e.key === "Escape") { e.preventDefault(); setDismissed(menuKey); }
          }}
          disabled={disabled}
          placeholder={disabled ? "This channel is archived" : uploading ? "Uploading image…" : `Message #${channel.name} (paste or drop an image)`}
          aria-label="New post"
          aria-autocomplete="list"
          aria-expanded={showMenu}
          className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        <span className={cn("shrink-0 font-mono text-[10px]", over ? "text-destructive" : "text-muted-foreground")}>{cost}/{maxPostChars}</span>
        <Button type="submit" size="sm" className="h-7" disabled={disabled || pending || uploading || over || body.trim() === ""}>
          Post
        </Button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function BoardPage({ subPath }: { subPath: string }) {
  const { rpc, overview, error, refetch } = useOverview();
  const navigate = useBbNavigate();
  const channels = overview?.channels ?? [];
  const active = useMemo(() => {
    const wanted = subPath.replace(/^#/, "");
    return channels.find((c) => c.name === wanted) ?? channels.find((c) => c.name === "general") ?? channels[0] ?? null;
  }, [channels, subPath]);
  const { posts, refetch: refetchPosts } = usePosts(rpc, active?.id ?? null);
  const presence = usePresence(rpc, active?.id ?? null);
  const providerRoster = useProviders();
  const providers = useMemo<ProviderLookup>(
    () => new Map(providerRoster.providers.map((p) => [p.id, { displayName: p.displayName, logoUrl: p.logoUrl ?? null }])),
    [providerRoster.providers],
  );
  const select = useCallback((channel: Channel) => navigate.toPluginPanel("whatsagent", { subPath: channel.name }), [navigate]);
  const report = (cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause));

  if (error) return <p role="alert" className="p-4 text-sm text-destructive">{error}</p>;
  if (!overview) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="flex h-full min-h-0">
      <ChannelList
        channels={channels}
        activeId={active?.id ?? null}
        onSelect={select}
        onCreate={async (name) => {
          try {
            const channel = await rpc.call("wa_create_channel", { name });
            refetch();
            select(channel);
          } catch (cause) {
            report(cause);
          }
        }}
      />
      <section className="flex min-w-0 flex-1 flex-col">
        {active ? (
          <>
            <ChannelHeader channel={active} projects={overview.projects} presence={presence} providers={providers} rpc={rpc} refetch={refetch} />
            <PostList
              posts={posts}
              members={overview.members}
              channels={channels}
              providers={providers}
              humanHandle={overview.humanHandle}
              onChannel={select}
              onReact={async (post, emoji) => {
                try {
                  await rpc.call("wa_react", { postId: post.id, emoji });
                  refetchPosts();
                } catch (cause) {
                  report(cause);
                }
              }}
              onDelete={async (post) => {
                try {
                  await rpc.call("wa_delete_post", { postId: post.id });
                  refetchPosts();
                } catch (cause) {
                  report(cause);
                }
              }}
            />
            <Composer
              channel={active}
              members={overview.members}
              channels={channels}
              maxPostChars={overview.maxPostChars}
              onUpload={async (file) => {
                const base64 = await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onerror = () => reject(new Error("Could not read image"));
                  reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
                  reader.readAsDataURL(file);
                });
                const mime = file.type as "image/png" | "image/jpeg" | "image/gif" | "image/webp";
                const result = await rpc.call("wa_upload", { mime, base64 });
                return result.ref;
              }}
              onSend={async (body) => {
                try {
                  await rpc.call("wa_post_human", { channelId: active.id, body });
                  refetchPosts();
                } catch (cause) {
                  report(cause);
                  throw cause;
                }
              }}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Create a channel to start.</div>
        )}
      </section>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "whatsagent",
    title: "Whatsagent",
    icon: "ListView",
    path: "whatsagent",
    component: ({ subPath }) => <BoardPage subPath={subPath} />,
  });
});
