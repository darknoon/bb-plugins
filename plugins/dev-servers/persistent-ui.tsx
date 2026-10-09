import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { rpcContract } from "./server";
import type { PersistentServer } from "./persistent";
import { DEFAULT_PERSISTENT_PORT } from "./port-policy";

export type Promotion = { command: string; port: number; name: string };
const fieldClass = "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm";

function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

export function PersistentForm({ promotion, onDone }: { promotion: Promotion | null; onDone: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const value = (name: string) => String(data.get(name) ?? "");
    setBusy(true);
    setError(null);
    try {
      await rpc.call("persistentAdd", {
        name: value("name"), cwd: value("cwd"), command: value("command"), port: Number(value("port")),
        enabled: data.has("enabled"), tailnet: data.has("tailnet"), adoptTailnetRule: data.has("adopt"),
        health: { path: value("health-path"), status: Number(value("health-status")), contentType: value("content-type"), bodyIncludes: value("body") },
      });
      toast.success("Persistent server registered");
      onDone();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const command = promotion?.command.replace(new RegExp(`\\b${promotion.port}\\b`, "g"), "{port}") ?? "";
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3 border-b border-border px-4 py-3" aria-label={promotion ? "Promote to persistent server" : "Add persistent server"}>
      <p className="text-sm font-medium">{promotion ? "Promote to persistent" : "Add persistent server"}</p>
      {promotion ? <p className="text-xs text-muted-foreground">Choose a durable checkout and a free fixed port. Update any worktree paths in the command. The thread server keeps running.</p> : null}
      <label className="block text-xs">Name<input name="name" required maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*" defaultValue={promotion?.name} className={fieldClass} /></label>
      <label className="block text-xs">Working directory on this machine<input name="cwd" required placeholder="/Users/andrew/Developer/my-viewer" className={fieldClass} /></label>
      <label className="block text-xs">Command<textarea name="command" required defaultValue={command} placeholder="npm run dev -- --host 127.0.0.1 --port {port}" className={fieldClass} rows={3} /></label>
      <label className="block text-xs">Fixed port<input name="port" type="number" required min={5910} max={65535} defaultValue={DEFAULT_PERSISTENT_PORT} className={fieldClass} /></label>
      <p className="text-xs text-muted-foreground">Prefer a free port in 6360–6378, outside the default thread blocks. Infrastructure ports, including 5900–5909, are reserved. Run the command in the foreground; {"{port}"} uses this fixed port.</p>
      <details>
        <summary className="cursor-pointer text-xs">Health check and tailnet access</summary>
        <div className="mt-2 space-y-2">
          <label className="block text-xs">Health path<input name="health-path" defaultValue="/" required className={fieldClass} /></label>
          <label className="block text-xs">Expected HTTP status<input name="health-status" type="number" min={100} max={599} defaultValue={200} required className={fieldClass} /></label>
          <label className="block text-xs">Expected Content-Type<input name="content-type" defaultValue="text/html" required className={fieldClass} /></label>
          <label className="block text-xs">Expected response text (optional)<input name="body" className={fieldClass} /></label>
          <label className="flex items-center gap-2 text-xs"><input name="tailnet" type="checkbox" />Expose privately on the tailnet</label>
          <label className="flex items-center gap-2 text-xs"><input name="adopt" type="checkbox" />Take ownership of an existing identical Serve rule</label>
          <p className="text-xs text-muted-foreground">Owned rules are removed on Stop or removal. Public access is refused.</p>
        </div>
      </details>
      <label className="flex items-center gap-2 text-xs"><input name="enabled" type="checkbox" defaultChecked />Start now and automatically when bb starts</label>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2"><Button size="sm" type="submit" disabled={busy}>{busy ? "Saving…" : "Save persistent server"}</Button><Button size="sm" type="button" variant="outline" onClick={onDone} disabled={busy}>Cancel</Button></div>
    </form>
  );
}

function PersistentCard({ server, refresh }: { server: PersistentServer; refresh: () => Promise<void> }) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  async function control(action: "start" | "stop" | "restart" | "remove") {
    setBusy(true);
    try { await rpc.call("persistentControl", { name: server.name, action }); await refresh(); }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return (
    <article className="space-y-2 border-b border-border px-4 py-3" aria-label={`Persistent server ${server.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{server.name}</span><code className="text-xs">:{server.port}</code>
        <span className={`ml-auto text-xs ${server.state === "crashed" ? "text-destructive" : "text-muted-foreground"}`}>{server.state}</span>
      </div>
      <div className="text-xs text-muted-foreground">Uptime {elapsed(server.uptimeMs)}{server.restartAt ? ` · Retry in ${elapsed(server.restartAt - Date.now())}` : ""}</div>
      {server.healthResult ? <p className={`text-xs ${server.healthResult.healthy ? "text-muted-foreground" : "text-destructive"}`}>{server.healthResult.message}</p> : null}
      {server.lastExit ? <p className="break-words text-xs text-muted-foreground">Last exit: {server.lastExit.code !== null ? `code ${server.lastExit.code}` : server.lastExit.signal ?? "no exit code"} · {server.lastExit.reason} · {new Date(server.lastExit.at).toLocaleString()}</p> : null}
      <div className="flex flex-wrap gap-2">
        {server.enabled ? <><Button size="sm" variant="outline" disabled={busy} onClick={() => void control("restart")}>Restart</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void control("stop")}>Stop</Button></>
          : <Button size="sm" variant="outline" disabled={busy} onClick={() => void control("start")}>Start</Button>}
        {server.tailnetUrl ? <a href={server.tailnetUrl} target="_blank" rel="noopener noreferrer" className="self-center text-xs underline">Open viewer</a> : null}
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">Details and recent logs</summary>
        <p className="mt-2 break-all text-xs">{server.cwd}</p><pre className="mt-1 whitespace-pre-wrap break-all text-xs">{server.command}</pre>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{server.logs.length ? server.logs.map((line) => `${new Date(line.at).toLocaleTimeString()} [${line.stream}] ${line.line}`).join("\n") : "No logs yet."}</pre>
        {!server.enabled ? <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={() => void control("remove")}>Remove stopped server</Button> : null}
      </details>
    </article>
  );
}

export function PersistentServers({ promotion, onClosePromotion }: { promotion: Promotion | null | undefined; onClosePromotion: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [servers, setServers] = useState<PersistentServer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const form = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (promotion !== undefined || adding) form.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [promotion, adding]);
  const refresh = useCallback(async () => {
    try { setServers((await rpc.call("persistentList", { logLines: 20 })).servers); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, [rpc]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() { await refresh(); if (!cancelled) timer = setTimeout(() => void poll(), 2000); }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [refresh]);
  useRealtime("persistent-changed", () => void refresh());
  const done = () => { setAdding(false); onClosePromotion(); void refresh(); };
  return (
    <section aria-labelledby="persistent-servers-heading">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background px-4 py-2">
        <h2 id="persistent-servers-heading" className="text-sm font-medium">Persistent servers</h2>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>Add</Button>
      </div>
      {promotion !== undefined || adding ? <div ref={form}><PersistentForm key={promotion?.name ?? "new"} promotion={promotion ?? null} onDone={done} /></div> : null}
      {error ? <p role="alert" className="px-4 py-3 text-xs text-destructive">{error}</p> : null}
      {loading ? <p className="px-4 py-3 text-xs text-muted-foreground">Loading persistent servers…</p> : servers.length === 0 ? <p className="px-4 py-3 text-xs text-muted-foreground">No persistent servers. Add one or promote a thread dev server.</p> : null}
      {servers.map((server) => <PersistentCard key={server.name} server={server} refresh={refresh} />)}
    </section>
  );
}
