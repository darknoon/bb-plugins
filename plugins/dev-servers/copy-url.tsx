import { useState } from "react";
import { experimental_copyToClipboard, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "./components/ui/button";
import type { rpcContract } from "./server";
import { serverUrl, type Server } from "./servers";

export function useCopyServerUrl() {
  const rpc = useRpc<typeof rpcContract>();
  const [failure, setFailure] = useState<{ message: string; url?: string } | null>(null);

  async function copy(server: Server) {
    setFailure(null);
    let url = serverUrl(server);
    if (!url) {
      // A failed Tailscale status read can temporarily omit an existing
      // private route. Retry discovery on demand instead of disabling Copy.
      try {
        const { servers } = await rpc.call("list", { projectId: server.projectId });
        const current = servers.find((candidate) => candidate.environmentId === server.environmentId && candidate.port === server.port);
        url = current ? serverUrl(current) : null;
      } catch {
        const message = "Could not check the dev server URL. Try Copy URL again.";
        setFailure({ message });
        toast.error(message);
        return;
      }
    }
    if (!url) {
      const message = "No private URL is available for this server. Check its Tailscale Serve route, then try Copy URL again.";
      setFailure({ message });
      toast.error(message);
      return;
    }
    try {
      // BB uses the desktop clipboard bridge in the native app, with
      // Clipboard API and copy-command fallbacks in browsers.
      if (await experimental_copyToClipboard({ text: url })) {
        toast.success("Dev server URL copied");
        return;
      }
    } catch { /* Keep the URL usable even if an older host throws. */ }
    const message = "Could not copy the URL. Select and copy it below.";
    setFailure({ message, url });
    toast.error(message);
  }

  const feedback = failure ? (
    <div role="alert" className="my-2 space-y-2 rounded-md border border-border p-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <p>{failure.message}</p>
        <Button variant="ghost" size="sm" className="h-5 shrink-0 px-1 text-xs" onClick={() => setFailure(null)}>Dismiss</Button>
      </div>
      {failure.url ? (
        <input
          aria-label="URL to copy manually" readOnly value={failure.url}
          className="h-8 w-full rounded border border-input bg-background px-2 text-xs"
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.currentTarget.select()}
        />
      ) : null}
    </div>
  ) : null;
  return { copy, feedback };
}
