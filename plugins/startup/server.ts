import type { BbPluginApi, PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { hostContract, rpcContract, type StartupStatus } from "./contract.js";

function usage(exitCode = 0): PluginCliResult {
  return {
    exitCode,
    stdout: [
      "Usage:",
      "  bb startup status [--host <host-id>]",
      "  bb startup enable [--host <host-id>] [--no-handoff]",
      "  bb startup disable [--host <host-id>]",
      "  bb startup handoff [--host <host-id>]",
      "",
      "The primary host is used when --host is omitted. Startup always runs bb-app@latest.",
    ].join("\n") + "\n",
  };
}

function parseArgs(argv: string[]): { command: string; hostId?: string; noHandoff: boolean } {
  const args = [...argv];
  const command = args.shift() ?? "status";
  let hostId: string | undefined;
  let noHandoff = false;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--host") {
      hostId = args.shift();
      if (!hostId) throw new Error("--host requires a host id");
    } else if (arg === "--no-handoff") {
      noHandoff = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { command, hostId, noHandoff };
}

function formatStatus(hostId: string, status: StartupStatus): string {
  const lines = [
    `Host: ${hostId}`,
    `Platform: ${status.platform}`,
    `Startup: ${status.enabled ? "enabled" : "disabled"}${status.loaded ? " (loaded)" : ""}`,
    `Current runtime: ${status.runtimeManaged ? "launchd-managed" : "not launchd-managed"}`,
    `Managed files: ${status.managed ? "yes" : "no"}`,
    `Command: ${status.command ?? "unavailable"}`,
    `LaunchAgent: ${status.launchAgentPath ?? "unavailable"}`,
    `Claude keychain: ${status.keychain.credentialPresent ? (status.keychain.accessible ? "accessible from LaunchAgent" : "present but inaccessible") : "credential not detected"}`,
    `Tailscale Serve: ${status.tailscale.configured ? "configured for port 38886" : "not confirmed"}`,
  ];
  if (status.keychain.detail) lines.push(`Keychain detail: ${status.keychain.detail}`);
  if (status.tailscale.detail) lines.push(`Tailscale detail: ${status.tailscale.detail}`);
  if (status.detail) lines.push(`Detail: ${status.detail}`);
  return lines.join("\n") + "\n";
}

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });

  async function primaryHost(signal?: AbortSignal): Promise<string> {
    const config = await bb.sdk.system.config({ signal });
    if (!config.primaryHostId) throw new Error("No primary bb host is configured.");
    return config.primaryHostId;
  }

  async function selectedHost(explicit: string | undefined, ctx: PluginCliContext): Promise<string> {
    if (explicit) return explicit;
    return primaryHost(ctx.signal);
  }

  bb.rpc.register(rpcContract, {
    async status() {
      const hostId = await primaryHost();
      return { hostId, status: await host.call("status", null, { hostId }) };
    },
    async enable() {
      const hostId = await primaryHost();
      return { hostId, status: await host.call("enable", null, { hostId }) };
    },
    async disable() {
      const hostId = await primaryHost();
      return { hostId, status: await host.call("disable", null, { hostId }) };
    },
    async handoff() {
      const hostId = await primaryHost();
      const result = await host.call("handoff", { delaySeconds: 8 }, { hostId });
      return { hostId, ...result };
    },
  });

  bb.cli.register({
    name: "startup",
    summary: "Manage automatic bb startup on a macOS host",
    commands: [
      { name: "status", summary: "Show startup state", usage: "bb startup status [--host <host-id>]" },
      { name: "enable", summary: "Install startup and hand off the running bb", usage: "bb startup enable [--host <host-id>] [--no-handoff]" },
      { name: "disable", summary: "Remove automatic startup", usage: "bb startup disable [--host <host-id>]" },
      { name: "handoff", summary: "Restart bb under launchd management", usage: "bb startup handoff [--host <host-id>]" },
    ],
    async run(argv, ctx) {
      try {
        if (argv.includes("--help") || argv.includes("-h")) return usage();
        const parsed = parseArgs(argv);
        if (!["status", "enable", "disable", "handoff"].includes(parsed.command)) return usage(2);
        if (parsed.noHandoff && parsed.command !== "enable") throw new Error("--no-handoff is only valid with enable");
        const hostId = await selectedHost(parsed.hostId, ctx);
        if (parsed.command === "handoff") {
          const result = await host.call("handoff", { delaySeconds: 8 }, { hostId, signal: ctx.signal });
          return { exitCode: 0, stdout: `Managed handoff scheduled on ${hostId} in ${result.delaySeconds} seconds.\n` };
        }
        if (parsed.command === "enable") {
          const status = await host.call("enable", null, { hostId, signal: ctx.signal });
          if (!status.supported) return { exitCode: 1, stderr: formatStatus(hostId, status) };
          let message = formatStatus(hostId, status);
          if (!parsed.noHandoff) {
            const handoff = await host.call("handoff", { delaySeconds: 8 }, { hostId, signal: ctx.signal });
            message += `Managed handoff scheduled in ${handoff.delaySeconds} seconds.\n`;
          }
          return { exitCode: 0, stdout: message };
        }
        const status = parsed.command === "disable"
          ? await host.call("disable", null, { hostId, signal: ctx.signal })
          : await host.call("status", null, { hostId, signal: ctx.signal });
        return { exitCode: status.supported ? 0 : 1, [status.supported ? "stdout" : "stderr"]: formatStatus(hostId, status) };
      } catch (error) {
        return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
      }
    },
  });

  bb.log.info("registered `bb startup` host-management commands");
}
