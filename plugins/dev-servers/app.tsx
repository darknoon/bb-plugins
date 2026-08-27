import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRpc,
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  BubbleChatIcon,
  Copy01Icon,
  FolderGitTwoIcon,
  LinkSquare01Icon,
  ReloadIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const PANEL_ACTION_ID = "dev-server";
const PENDING_OPEN_PREFIX = "bb-dev-servers:pending-open:";
const PENDING_OPEN_TTL_MS = 30_000;

type Server = {
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  branchName: string | null;
  path: string;
  port: number;
  pid: number;
  processName: string;
  command: string | null;
  connectUrl: string | null;
  tailnetUrl: string | null;
  threadIds: string[];
  thread: { id: string; title: string } | null;
  terminal: { id: string; title: string; status: string } | null;
  association: "managed" | "inferred" | "external";
};

type ServerIdentity = {
  environmentId: string;
  port: number;
};

type PendingPanelOpen = {
  createdAt: number;
  title: string;
  params: ServerIdentity;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseServerIdentity(value: unknown): ServerIdentity | null {
  if (!isRecord(value)) return null;
  return typeof value.environmentId === "string" && Number.isInteger(value.port)
    ? { environmentId: value.environmentId, port: value.port as number }
    : null;
}

function serverIdentity(server: Server): ServerIdentity {
  return { environmentId: server.environmentId, port: server.port };
}

function isServerForThread(server: Server, threadId: string) {
  return server.threadIds.includes(threadId);
}

function serverTitle(server: Server) {
  return `${server.branchName ?? server.environmentName} · :${server.port}`;
}

function serverUrl(server: Server) {
  const isTailnetOrigin = window.location.protocol === "https:"
    && window.location.hostname.endsWith(".ts.net");
  return isTailnetOrigin && server.tailnetUrl
    ? server.tailnetUrl
    : server.connectUrl ?? server.tailnetUrl;
}

function pendingOpenKey(threadId: string) {
  return `${PENDING_OPEN_PREFIX}${threadId}`;
}

function savePendingOpen(threadId: string, pending: PendingPanelOpen) {
  try {
    window.sessionStorage.setItem(pendingOpenKey(threadId), JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

function takePendingOpen(threadId: string): PendingPanelOpen | null {
  try {
    const key = pendingOpenKey(threadId);
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    window.sessionStorage.removeItem(key);
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.createdAt !== "number" || typeof value.title !== "string") {
      return null;
    }
    const params = parseServerIdentity(value.params);
    if (!params || Date.now() - value.createdAt > PENDING_OPEN_TTL_MS) return null;
    return { createdAt: value.createdAt, title: value.title, params };
  } catch {
    return null;
  }
}

async function copyUrl(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success("Dev server URL copied");
  } catch {
    toast.error("Could not copy the URL");
  }
}

function useDevServers(projectId: string | null = null) {
  const rpc = useRpc<typeof rpcContract>();
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await rpc.call("list", { projectId });
      setServers(result.servers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId, rpc]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { servers, loading, error, refresh };
}

function ServerChoice({
  server,
  currentThread,
  onSelect,
}: {
  server: Server;
  currentThread: boolean;
  onSelect: (server: Server) => void;
}) {
  const url = serverUrl(server);
  return (
    <button
      type="button"
      className={`flex w-full items-center gap-3 border-b border-border px-4 text-left transition-colors last:border-b-0 disabled:cursor-not-allowed disabled:opacity-50 ${
        currentThread
          ? "bg-state-active py-4 hover:bg-state-active"
          : "py-3 hover:bg-state-hover"
      }`}
      disabled={!url}
      onClick={() => onSelect(server)}
    >
      <span className="size-2 shrink-0 rounded-full bg-foreground" aria-label="Running" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">
            {server.branchName ?? server.environmentName}
          </span>
          {currentThread ? (
            <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-secondary-foreground">
              Current thread
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {server.projectName}{server.thread ? ` · ${server.thread.title}` : " · No linked chat"}
        </div>
      </div>
      <code className="shrink-0 text-sm font-medium tabular-nums">:{server.port}</code>
    </button>
  );
}

function DevServerPreview({ server, onBack }: { server: Server; onBack: () => void }) {
  const [reloadKey, setReloadKey] = useState(0);
  const [frameLoading, setFrameLoading] = useState(true);
  const url = serverUrl(server);

  useEffect(() => {
    setFrameLoading(true);
  }, [reloadKey, url]);

  if (!url) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="flex h-11 shrink-0 items-center border-b border-border px-2">
          <Button size="icon" variant="ghost" aria-label="Back to dev servers" onClick={onBack}>
            <HugeiconsIcon icon={ArrowLeft01Icon} />
          </Button>
        </div>
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          This server is running, but no secure preview URL is available.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <Button size="icon" variant="ghost" aria-label="Back to dev servers" onClick={onBack}>
          <HugeiconsIcon icon={ArrowLeft01Icon} />
        </Button>
        <input
          aria-label="Dev server URL"
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-muted/50 px-3 text-xs text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          size="icon"
          variant="ghost"
          aria-label="Copy dev server URL"
          onClick={() => void copyUrl(url)}
        >
          <HugeiconsIcon icon={Copy01Icon} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Reload dev server"
          onClick={() => setReloadKey((value) => value + 1)}
        >
          <HugeiconsIcon icon={ReloadIcon} />
        </Button>
        <Button size="icon" variant="ghost" asChild>
          <a href={url} target="_blank" rel="noreferrer" aria-label="Open dev server externally">
            <HugeiconsIcon icon={LinkSquare01Icon} />
          </a>
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 bg-muted/30">
        {frameLoading ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            Loading {serverTitle(server)}…
          </div>
        ) : null}
        <iframe
          key={`${url}:${reloadKey}`}
          src={url}
          title={`Dev server ${serverTitle(server)}`}
          className="relative h-full w-full border-0 bg-background"
          allow="clipboard-read; clipboard-write; fullscreen"
          onLoad={() => setFrameLoading(false)}
        />
      </div>
    </div>
  );
}

function DevServerPanel({ threadId, params }: PluginThreadPanelProps) {
  const initialSelection = useRef(parseServerIdentity(params));
  const [selected, setSelected] = useState<ServerIdentity | null>(initialSelection.current);
  const { servers, loading, error, refresh } = useDevServers();
  const selectedServer = selected
    ? servers.find((server) => server.environmentId === selected.environmentId && server.port === selected.port) ?? null
    : null;
  const compareServers = (left: Server, right: Server) =>
    left.projectName.localeCompare(right.projectName)
      || (left.branchName ?? left.environmentName).localeCompare(right.branchName ?? right.environmentName)
      || left.port - right.port;
  const currentServers = servers
    .filter((server) => isServerForThread(server, threadId))
    .sort(compareServers);
  const otherServers = servers
    .filter((server) => !isServerForThread(server, threadId))
    .sort(compareServers);

  if (selected && selectedServer) {
    return <DevServerPreview server={selectedServer} onBack={() => setSelected(null)} />;
  }

  if (selected && loading) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
        Finding dev server…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <div>
          <div className="text-sm font-medium">Choose a dev server</div>
          <div className="text-xs text-muted-foreground">
            {loading ? "Scanning…" : `${servers.length} running`}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {selected && !loading ? (
          <div className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
            That dev server is no longer running. Choose another one.
          </div>
        ) : null}
        {error ? <p className="px-4 py-3 text-sm text-destructive">{error}</p> : null}
        {!loading && !error && servers.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No running dev servers found.
          </div>
        ) : null}
        {currentServers.length > 0 ? (
          <section aria-labelledby="current-thread-dev-servers">
            <div
              id="current-thread-dev-servers"
              className="sticky top-0 z-10 border-b border-border bg-muted/90 px-4 py-2 text-xs font-medium text-foreground backdrop-blur"
            >
              Current thread
            </div>
            {currentServers.map((server) => (
              <ServerChoice
                key={`${server.environmentId}:${server.port}`}
                server={server}
                currentThread
                onSelect={(next) => setSelected(serverIdentity(next))}
              />
            ))}
          </section>
        ) : !loading && !error && servers.length > 0 ? (
          <div className="border-b border-border px-4 py-3">
            <div className="text-xs font-medium text-foreground">Current thread</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              No dev server is running for this thread.
            </div>
          </div>
        ) : null}
        {otherServers.length > 0 ? (
          <section aria-labelledby="other-dev-servers">
            <div
              id="other-dev-servers"
              className="sticky top-0 z-10 border-b border-border bg-muted/90 px-4 py-2 text-xs font-medium text-muted-foreground backdrop-blur"
            >
              Other dev servers
            </div>
            {otherServers.map((server) => (
              <ServerChoice
                key={`${server.environmentId}:${server.port}`}
                server={server}
                currentThread={false}
                onSelect={(next) => setSelected(serverIdentity(next))}
              />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function DevServerPanelOpenBridge({ threadId }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const tryOpen = () => {
      if (cancelled) return;
      const pending = takePendingOpen(threadId);
      if (!pending) return;
      const accepted = navigate.openThreadPanel({
        actionId: PANEL_ACTION_ID,
        title: pending.title,
        params: pending.params,
      });
      if (!accepted && attempts < 5) {
        attempts += 1;
        savePendingOpen(threadId, pending);
        timer = setTimeout(tryOpen, 50);
      }
    };

    timer = setTimeout(tryOpen, 0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [navigate, threadId]);

  return null;
}

function ServerOpenButtons({ server, onOpen }: { server: Server; onOpen: (server: Server) => void }) {
  const url = serverUrl(server);
  const canOpenInPanel = Boolean(url && server.thread);

  return (
    <div
      className="flex"
      title={!url
        ? "No secure preview URL is available"
        : !server.thread
          ? "No linked chat is available for the right-panel preview"
          : undefined}
    >
      <Button
        size="sm"
        className="rounded-r-none px-3"
        disabled={!canOpenInPanel}
        onClick={() => onOpen(server)}
      >
        Open
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            className="w-7 rounded-l-none border-l border-background/20 px-0"
            disabled={!url}
            aria-label="More ways to open dev server"
          >
            <HugeiconsIcon icon={ArrowDown01Icon} className="size-3.5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" mobileTitle="Dev server actions">
          <DropdownMenuItem onSelect={() => void copyUrl(url!)}>
            <HugeiconsIcon icon={Copy01Icon} aria-hidden="true" />
            Copy URL
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => window.open(url!, "_blank", "noopener,noreferrer")}
          >
            <HugeiconsIcon icon={LinkSquare01Icon} aria-hidden="true" />
            Open externally
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function DevServersPanel() {
  const navigate = useBbNavigate();
  const { servers, loading, error, refresh } = useDevServers();

  const openInPanel = (server: Server) => {
    const url = serverUrl(server);
    if (!url || !server.thread) return;
    const pending: PendingPanelOpen = {
      createdAt: Date.now(),
      title: serverTitle(server),
      params: serverIdentity(server),
    };
    if (!savePendingOpen(server.thread.id, pending)) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    navigate.toThread(server.thread.id);
  };

  const projects = Array.from(
    servers.reduce((groups, server) => {
      const group = groups.get(server.projectId) ?? {
        id: server.projectId,
        name: server.projectName,
        servers: [] as Server[],
      };
      group.servers.push(server);
      groups.set(server.projectId, group);
      return groups;
    }, new Map<string, { id: string; name: string; servers: Server[] }>()),
  ).map(([, project]) => project);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="text-sm text-muted-foreground">
          {loading ? "Scanning…" : `${servers.length} running`}
        </span>
        <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? <p className="px-4 py-3 text-sm text-destructive">{error}</p> : null}
        {!loading && !error && servers.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No running dev servers found.
          </div>
        ) : null}
        {projects.map((project) => (
          <section key={project.id}>
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-muted/80 px-4 py-2 backdrop-blur">
              <span className="text-xs font-medium">{project.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {project.servers.length}
              </span>
            </div>
            {project.servers.map((server) => (
              <div key={`${server.environmentId}:${server.port}`} className="border-b border-border px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="mt-1.5 size-2 shrink-0 rounded-full bg-foreground" aria-label="Running" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-4">
                      <div
                        className="flex min-w-0 items-center gap-1.5 text-sm font-medium"
                        title={server.branchName ?? server.environmentName}
                      >
                        <HugeiconsIcon
                          icon={FolderGitTwoIcon}
                          className="size-4 shrink-0 text-subtle-foreground"
                          aria-hidden="true"
                        />
                        <span className="truncate">{server.branchName ?? server.environmentName}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <code className="text-base font-medium tabular-nums">:{server.port}</code>
                        <ServerOpenButtons server={server} onOpen={openInPanel} />
                      </div>
                    </div>
                    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
                      {server.thread ? (
                        <button
                          type="button"
                          className="inline-flex h-6 max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-background px-2 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          title={`Open chat: ${server.thread.title}`}
                          onClick={() => navigate.toThread(server.thread!.id)}
                        >
                          <HugeiconsIcon icon={BubbleChatIcon} className="size-3.5 shrink-0" aria-hidden="true" />
                          <span className="truncate">{server.thread.title}</span>
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">No chat found</span>
                      )}
                      <span className="truncate text-xs text-muted-foreground">
                        {server.terminal
                          ? `Terminal · ${server.terminal.title}`
                          : "No BB terminal"}
                      </span>
                    </div>
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                        Details
                      </summary>
                      <dl className="mt-2 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 border-l border-border pl-3">
                        <dt className="text-muted-foreground">Process</dt>
                        <dd className="truncate" title={server.command ?? undefined}>{server.processName} · PID {server.pid}</dd>
                        <dt className="text-muted-foreground">Path</dt>
                        <dd className="truncate" title={server.path}>{server.path}</dd>
                        <dt className="text-muted-foreground">Detected</dt>
                        <dd>
                          {server.association === "managed"
                            ? "Started through Dev Servers"
                            : server.association === "inferred"
                              ? "Matched from terminal output"
                              : "External process"}
                        </dd>
                      </dl>
                    </details>
                  </div>
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "dev-servers",
    title: "Dev Servers",
    icon: "ServerStack01",
    path: "dev-servers",
    component: DevServersPanel,
  });

  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Open dev server",
    icon: "ServerStack01",
    layout: "flush",
    component: DevServerPanel,
  });

  app.slots.experimental_threadHeaderAction({
    id: "dev-server-open-bridge",
    title: "Open dev server",
    component: DevServerPanelOpenBridge,
  });
});
