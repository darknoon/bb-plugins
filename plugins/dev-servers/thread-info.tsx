import { useEffect, useState } from "react";
import {
  experimental_InfoSection as InfoSection,
  experimental_InfoList as InfoList,
  experimental_InfoListRow as InfoListRow,
  experimental_Icon as Icon,
  experimental_copyToClipboard,
  experimental_useAppPanel,
  useBbNavigate,
  useRpc,
  useSdk,
  type ExperimentalThreadInfoProps,
} from "@get-bb/plugin-sdk/app";
import { BubbleChatIcon, Copy01Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";
import { Button } from "./components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
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
  const rows = state.groups.flatMap((group) => group.servers.map((server) => ({ server, child: group.thread })));
  function renderServer({ server, child }: typeof rows[number]) {
    const url = serverUrl(server);
    const owner = child ? `Child thread: ${child.title}` : "Running";
    return (
      <InfoListRow
        leading={<Icon name="ServerStack01" className="size-3 text-muted-foreground" aria-hidden="true" />}
        leadingLabel={owner}
        name={server.name}
        context={child ? "child" : undefined}
        title={`${serverTitle(server)} · ${owner}${url ? "" : " · No secure preview URL available"}`}
        onSelect={url ? () => open(server) : undefined}
        trailing={
          // The native name button stretches its hit area across the
          // row; trailing actions must sit above that overlay.
          <span className="relative z-10 flex shrink-0 items-center gap-1">
            <span className="text-2xs text-subtle-foreground">:{server.port}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost" size="sm"
                  className="size-5 p-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
                  aria-label={`Actions for ${server.name}`}
                >
                  <HugeiconsIcon icon={MoreHorizontalIcon} size={14} aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" mobileTitle={`${server.name} actions`}>
                <DropdownMenuItem disabled={!url} onSelect={() => void copy(server)}>
                  <HugeiconsIcon icon={Copy01Icon} aria-hidden="true" />
                  Copy URL
                </DropdownMenuItem>
                {child ? (
                  <DropdownMenuItem aria-label={`Open child thread ${child.title}`} onSelect={() => navigate.toThread(child.id)}>
                    <HugeiconsIcon icon={BubbleChatIcon} aria-hidden="true" />
                    <span className="min-w-0">
                      Open child thread
                      <span className="block max-w-64 truncate text-xs text-muted-foreground">{child.title}</span>
                    </span>
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        }
      />
    );
  }
  return (
    <InfoSection label="Dev Servers" count={state.error ? undefined : rows.length}>
      {state.error ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground" role="status">
          Couldn’t check dev servers.
          <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setRetry((value) => value + 1)}>Retry</Button>
        </div>
      ) : (
        <InfoList items={rows} getKey={({ server }) => `${server.environmentId}:${server.port}`} renderItem={renderServer} />
      )}
    </InfoSection>
  );
}

export function DevServersInfo(props: ExperimentalThreadInfoProps) {
  // The thread is part of the scope even when siblings share a checkout.
  // Never let an old subtree's pending response appear after navigation.
  return <ThreadServers key={`${props.projectId}:${props.threadId}:${props.environment?.id ?? ""}`} {...props} />;
}
