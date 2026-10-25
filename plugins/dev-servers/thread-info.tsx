import { useEffect, useState } from "react";
import {
  experimental_InfoSection as InfoSection,
  experimental_InfoList as InfoList,
  experimental_InfoListRow as InfoListRow,
  experimental_copyToClipboard,
  experimental_useAppPanel,
  useRpc,
  type ExperimentalThreadInfoProps,
} from "@get-bb/plugin-sdk/app";
import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";
import { Button } from "./components/ui/button";
import type { rpcContract } from "./server";
import { DEV_SERVER_TAB, serverIdentity, serverTitle, serverUrl, type Server } from "./servers";

export const INFO_REFRESH_MS = 10_000;

function EnvironmentServers({ projectId, environment }: ExperimentalThreadInfoProps & { environment: { id: string } }) {
  const rpc = useRpc<typeof rpcContract>();
  const panel = experimental_useAppPanel();
  const [state, setState] = useState<{ scope: string; servers: Server[]; error: boolean } | null>(null);
  const scope = `${projectId}:${environment.id}`;
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
        const { servers } = await rpc.call("list", { projectId });
        if (!cancelled) setState({ scope, servers: servers.filter((server) => server.environmentId === environment.id).sort((a, b) => a.port - b.port), error: false });
      } catch {
        if (!cancelled) setState({ scope, servers: [], error: true });
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
  }, [rpc, projectId, environment.id, scope, retry]);

  if (state?.scope !== scope || (!state.error && state.servers.length === 0)) return null;

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
  return (
    <InfoSection label="Dev Servers" count={state.error ? undefined : state.servers.length}>
      {state.error ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground" role="status">
          Couldn’t check dev servers.
          <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setRetry((value) => value + 1)}>Retry</Button>
        </div>
      ) : (
        <InfoList items={state.servers} getKey={(server) => `${server.environmentId}:${server.port}`} renderItem={(server) => {
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
        }} />
      )}
    </InfoSection>
  );
}

export function DevServersInfo(props: ExperimentalThreadInfoProps) {
  // No usable environment => no scan or section. Remount on navigation so a
  // pending result from another checkout cannot appear in this thread's Info.
  return props.environment ? <EnvironmentServers key={`${props.projectId}:${props.environment.id}`} {...props} environment={props.environment} /> : null;
}
