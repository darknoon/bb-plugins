import { useEffect, useState } from "react";
import {
  experimental_InfoSection as InfoSection,
  experimental_InfoList as InfoList,
  experimental_InfoListRow as InfoListRow,
  experimental_copyToClipboard,
  experimental_useAppPanel,
  useBbNavigate,
  useRpc,
  useSdk,
  type ExperimentalThreadInfoProps,
} from "@get-bb/plugin-sdk/app";
import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";
import { Button } from "./components/ui/button";
import type { rpcContract } from "./server";
import { DEV_SERVER_TAB, serverIdentity, serverTitle, serverUrl, type Server } from "./servers";
import { relatedServerGroups, type ServerGroup } from "./server-groups";

export const INFO_REFRESH_MS = 10_000;

function ThreadServers({ threadId, projectId, environment }: ExperimentalThreadInfoProps) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  const [state, setState] = useState<{ scope: string; groups: ServerGroup[]; error: boolean } | null>(null);
  const environmentId = environment?.id ?? null;
  const scope = `${projectId}:${threadId}:${environmentId}`;
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (running || cancelled) return;
      running = true;
      clearTimeout(timer);
      try {
        const { threads } = await sdk.threads.experimental_listDescendants({ threadIds: [threadId] });
        if (cancelled) return;
        const descendants = new Set(threads.find((thread) => thread.threadId === threadId)?.descendantIds ?? []);
        // Children can use other projects/checkouts, or have a parent with
        // no usable environment. BB resolves the entire active subtree.
        const { servers } = environmentId || descendants.size ? await rpc.call("list", { projectId: null }) : { servers: [] };
        if (!cancelled) setState({ scope, groups: relatedServerGroups(servers, environmentId, descendants), error: false });
      } catch {
        if (!cancelled) setState({ scope, groups: [], error: true });
      } finally {
        running = false;
        if (!cancelled) timer = setTimeout(() => {
          if (document.hidden) return; // The visibility listener resumes discovery.
          void refresh();
        }, INFO_REFRESH_MS);
      }
    }
    const visible = () => { if (!document.hidden) void refresh(); };
    void refresh();
    document.addEventListener("visibilitychange", visible);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [rpc, sdk, threadId, environmentId, scope, retry]);

  if (state?.scope !== scope || (!state.error && state.groups.length === 0)) return null;

  function open(server: Server) {
    if (!panel.experimental_openTab({ surface: { kind: "current" }, tab: DEV_SERVER_TAB, params: serverIdentity(server), title: serverTitle(server) })) {
      toast.error("Could not open the dev server preview");
    }
  }
  async function copy(server: Server) {
    const url = serverUrl(server);
    if (!url) return;
    try {
      if (await experimental_copyToClipboard({ text: url })) toast.success("Dev server URL copied");
      else toast.error("Could not copy the URL");
    } catch { toast.error("Could not copy the URL"); }
  }
  function renderServer(server: Server) {
    const url = serverUrl(server);
    return (
      <InfoListRow
        leading={<span className="block size-1.5 rounded-full bg-emerald-500" />}
        leadingLabel="Running"
        name={server.name}
        context={`:${server.port}`}
        title={url ? `Open ${serverTitle(server)}` : `${serverTitle(server)} · No secure preview URL available`}
        onSelect={url ? () => open(server) : undefined}
        trailing={
          // The native name button stretches its hit area across the
          // row; trailing actions must sit above that overlay.
          <span className="relative z-10 flex shrink-0 items-center gap-0.5">
            <Button variant="ghost" size="sm" className="h-6 px-1.5" disabled={!url} aria-label={`Open ${server.name} preview`} onClick={() => open(server)}>Open</Button>
            <Button variant="ghost" size="sm" className="size-6 p-0" disabled={!url} aria-label={`Copy ${server.name} URL`} onClick={() => void copy(server)}>
              <HugeiconsIcon icon={Copy01Icon} size={13} aria-hidden="true" />
            </Button>
          </span>
        }
      />
    );
  }
  return (
    <InfoSection label="Dev Servers" count={state.error ? undefined : state.groups.reduce((count, group) => count + group.servers.length, 0)}>
      {state.error ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground" role="status">
          Couldn’t check dev servers.
          <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setRetry((value) => value + 1)}>Retry</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {state.groups.map((group) => (
            <div key={group.thread?.id ?? "current"}>
              {group.thread ? (
                <button
                  type="button"
                  className="mb-1 flex max-w-full cursor-pointer items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  title={group.thread.title}
                  aria-label={`Open child thread ${group.thread.title}`}
                  onClick={() => navigate.toThread(group.thread!.id)}
                >
                  <span className="shrink-0">Child ·</span><span className="truncate">{group.thread.title}</span>
                </button>
              ) : null}
              <InfoList items={group.servers} getKey={(server) => `${server.environmentId}:${server.port}`} renderItem={renderServer} />
            </div>
          ))}
        </div>
      )}
    </InfoSection>
  );
}

export function DevServersInfo(props: ExperimentalThreadInfoProps) {
  // The thread is part of the scope even when siblings share a checkout.
  // Never let an old subtree's pending response appear after navigation.
  return <ThreadServers key={`${props.projectId}:${props.threadId}:${props.environment?.id ?? ""}`} {...props} />;
}
