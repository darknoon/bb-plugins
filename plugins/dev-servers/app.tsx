import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { FolderGitTwoIcon, BubbleChatIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";

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
  url: string | null;
  thread: { id: string; title: string } | null;
  terminal: { id: string; title: string; status: string } | null;
  association: "managed" | "inferred" | "external";
};

function DevServersPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await rpc.call("list", { projectId: null });
      setServers(result.servers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => { void refresh(); }, [refresh]);

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
                        {server.url ? (
                          <Button size="sm" asChild>
                            <a href={server.url} target="_blank" rel="noreferrer">Open</a>
                          </Button>
                        ) : (
                          <Button size="sm" disabled>
                            Open
                          </Button>
                        )}
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
});
