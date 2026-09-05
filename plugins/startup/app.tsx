import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { ActiveThread, StartupStatus, rpcContract } from "./contract.js";

type StatusResult = { hostId: string; status: StartupStatus };
type Action = "enable" | "disable" | "handoff";
// "stopping": handoff scheduled, waiting for the realtime connection to drop.
// "reconnecting": connection dropped, waiting for the new bb to come back.
type RestartPhase = "stopping" | "reconnecting";

// The handoff script sleeps briefly, stops bb, and allows up to 30 seconds for the port to be
// released; if the connection is still up after this, the handoff most likely failed.
const RESTART_STOP_TIMEOUT_MS = 90_000;
// `bb-app@latest start` may download an update before listening again.
const RESTART_RECONNECT_TIMEOUT_MS = 5 * 60_000;
const STATUS_RETRY_ATTEMPTS = 5;
const STATUS_RETRY_DELAY_MS = 1_000;

function statusLabel(status: StartupStatus): { label: string; detail: string } {
  if (!status.supported) return { label: "Unsupported", detail: "This host is not running macOS." };
  if (!status.enabled) return { label: "Disabled", detail: "bb will not be started at the next login." };
  if (!status.loaded) return { label: "Attention needed", detail: "The LaunchAgent exists but is not loaded." };
  if (!status.runtimeManaged) return { label: "Attention needed", detail: "Startup is installed, but this bb process is not managed by launchd." };
  if (status.keychain.credentialPresent && status.keychain.accessible !== true) {
    return { label: "Attention needed", detail: "The LaunchAgent cannot access the existing Claude credential." };
  }
  if (!status.tailscale.configured) return { label: "Attention needed", detail: "Tailscale Serve is not confirmed for bb's port." };
  return { label: "Healthy", detail: "bb is running under launchd and ready for future logins." };
}

function StateRow({ label, value, detail }: { label: string; value: string; detail?: string | null }) {
  return (
    <div className="grid gap-1 border-b border-border py-3 last:border-b-0 sm:grid-cols-[11rem_1fr]">
      <div className="text-sm font-medium text-foreground">{label}</div>
      <div className="min-w-0">
        <div className="break-words text-sm text-foreground">{value}</div>
        {detail ? <div className="mt-1 break-words text-xs text-muted-foreground">{detail}</div> : null}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function StartupSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [result, setResult] = useState<StatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restartWarning, setRestartWarning] = useState<ActiveThread[] | null>(null);
  const [restart, setRestart] = useState<RestartPhase | null>(null);
  const restartRef = useRef<RestartPhase | null>(null);
  restartRef.current = restart;

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const next = await rpc.call("status", null);
      setResult(next);
      setError(null);
      return true;
    } catch (cause) {
      // Status calls are expected to fail while bb is restarting.
      if (restartRef.current === null) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }, [rpc]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    async function poll() {
      await load();
      if (!cancelled) timer = window.setTimeout(() => void poll(), 5_000);
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    if (connection === "connected" && restartRef.current === null) void load();
  }, [connection, load]);

  // Drive the restart phases from the realtime connection: scheduled -> dropped -> back.
  useEffect(() => {
    if (restart === "stopping" && connection !== "connected") {
      setRestart("reconnecting");
      return;
    }
    if (restart !== "reconnecting" || connection !== "connected") return;
    let cancelled = false;
    void (async () => {
      let loaded = false;
      for (let attempt = 0; attempt < STATUS_RETRY_ATTEMPTS && !cancelled; attempt += 1) {
        loaded = await load();
        if (loaded) break;
        await sleep(STATUS_RETRY_DELAY_MS);
      }
      if (cancelled) return;
      setRestart(null);
      setNotice(loaded ? "BB restarted." : "BB reconnected, but its startup status could not be read yet.");
    })();
    return () => {
      cancelled = true;
    };
  }, [restart, connection, load]);

  // Never spin forever: give up if bb does not go down, or does not come back.
  useEffect(() => {
    if (restart === null) return;
    const timeout = restart === "stopping" ? RESTART_STOP_TIMEOUT_MS : RESTART_RECONNECT_TIMEOUT_MS;
    const timer = window.setTimeout(() => {
      setRestart(null);
      setError(restart === "stopping"
        ? "BB did not stop for the restart. Check ~/.bb/logs/startup.handoff.log."
        : "BB has not come back yet. It may still be starting; check ~/.bb/logs/startup.stderr.log.");
    }, timeout);
    return () => window.clearTimeout(timer);
  }, [restart]);

  async function runAction(action: Action, allowActive = false) {
    setBusy(action);
    setError(null);
    setNotice(null);
    if (action !== "handoff") setRestartWarning(null);
    try {
      if (action === "handoff") {
        const handoff = await rpc.call("handoff", { allowActive });
        if (!handoff.scheduled) {
          setRestartWarning(handoff.activeThreads);
        } else {
          setRestartWarning(null);
          setRestart("stopping");
        }
      } else {
        const next = await rpc.call(action, null);
        setResult(next);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  const summary = useMemo(() => result ? statusLabel(result.status) : null, [result]);
  const status = result?.status;
  const locked = busy !== null || restart !== null;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold text-foreground">{summary?.label ?? "Checking startup…"}</div>
            <div className="mt-1 text-sm text-muted-foreground">{summary?.detail ?? "Reading the primary host state."}</div>
          </div>
          {status?.supported ? (
            <button
              type="button"
              role="switch"
              aria-checked={status.enabled}
              aria-label="Start bb at login"
              disabled={locked}
              onClick={() => void runAction(status.enabled ? "disable" : "enable")}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${status.enabled ? "bg-primary" : "bg-input"} disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-background shadow-sm transition-transform ${status.enabled ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          ) : null}
        </div>
        <div className="mt-3 text-xs font-medium text-muted-foreground">Start bb at login</div>
      </div>

      {error ? <div role="alert" className="rounded-lg border border-destructive p-3 text-sm text-destructive">{error}</div> : null}
      {restart ? (
        <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-lg border border-border bg-muted p-3 text-sm text-foreground">
          <Spinner />
          <span>{restart === "stopping" ? "Restarting BB…" : "Waiting for BB to come back…"}</span>
        </div>
      ) : notice ? (
        <div role="status" className="rounded-lg border border-border bg-muted p-3 text-sm text-foreground">{notice}</div>
      ) : null}

      {status && result ? (
        <div className="rounded-lg border border-border bg-card px-4">
          <StateRow label="Host" value={result.hostId} />
          <StateRow label="LaunchAgent" value={status.enabled ? (status.loaded ? "Enabled and loaded" : "Enabled for next login; not loaded") : status.loaded ? "Disabled for future logins" : "Disabled"} detail={status.launchAgentPath} />
          <StateRow label="Current bb" value={status.runtimeManaged ? "Managed by launchd" : "Not managed by launchd"} />
          <StateRow
            label="Claude keychain"
            value={status.keychain.credentialPresent ? (status.keychain.accessible ? "Accessible" : "Inaccessible") : "No credential detected"}
            detail={status.keychain.detail}
          />
          <StateRow
            label="Tailscale Serve"
            value={status.tailscale.configured ? "Configured for port 38886" : status.tailscale.available ? "Not configured" : "CLI unavailable"}
            detail={!status.tailscale.configured ? status.tailscale.detail : null}
          />
          <StateRow label="Managed command" value={status.command ?? "Unavailable"} />
          {status.detail ? <StateRow label="Detail" value={status.detail} /> : null}
        </div>
      ) : null}

      {restartWarning ? (
        <div role="alert" className="space-y-3 rounded-lg border border-destructive p-4">
          <div>
            <div className="text-sm font-semibold text-foreground">
              {restartWarning.length} running {restartWarning.length === 1 ? "thread" : "threads"} will be interrupted
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              Their history and workspace changes remain, but their current turns will stop.
            </div>
          </div>
          <ul className="space-y-1 text-sm text-foreground">
            {restartWarning.map((thread) => (
              <li key={thread.id} className="break-words">
                {thread.title} <span className="text-muted-foreground">({thread.providerId})</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={locked}
              onClick={() => void runAction("handoff", true)}
              className="rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "handoff" ? "Scheduling restart…" : "Restart anyway"}
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => setRestartWarning(null)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {status?.enabled && restartWarning === null ? (
        <button
          type="button"
          disabled={locked}
          onClick={() => void runAction("handoff")}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {restart ? <Spinner /> : null}
          {restart
            ? "Restarting…"
            : busy === "handoff"
              ? "Checking running threads…"
              : status.runtimeManaged
                ? "Restart and update BB"
                : "Restart under launchd"}
        </button>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Status updates every five seconds while this page is open. FileVault must be unlocked and this macOS user must log in before startup can run.
      </p>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "startup-status",
    title: "Automatic startup",
    description: "Start bb after login and verify the services it depends on.",
    component: StartupSettings,
  });
});
