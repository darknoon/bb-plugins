import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const MIN_DEV_PORT = 5910;
export const MAX_DEV_PORT = 65535;
export const DEFAULT_PERSISTENT_PORT = 6360;

// Infrastructure ports must never become dev-server or Tailscale Serve listeners.
// An orphaned Serve rule on 5900 answered TCP but blocked the VNC greeting, breaking
// Screen Sharing for three days. Reserve the whole 5900–5909 span, even when idle.
export const PORT_DENYLIST = Object.freeze([
  22, 80, 443, 3389, 5432,
  5900, 5901, 5902, 5903, 5904, 5905, 5906, 5907, 5908, 5909,
  6379, 8080,
  38886, 38887, // bb server and local host daemon defaults
  41641, // Tailscale
]);

export function runtimeInfrastructurePorts(bb: BbPluginApi, requireBoundServer = true) {
  const daemonPort = Number(process.env.BB_HOST_DAEMON_PORT ?? 38887);
  const ports = new Set([daemonPort].filter((p) => Number.isInteger(p) && p > 0 && p <= MAX_DEV_PORT));
  try {
    const url = new URL(bb.server.loopbackBaseUrl);
    ports.add(Number(url.port || (url.protocol === "https:" ? 443 : 80)));
  } catch (cause) {
    // Factories can load before loopback is bound. Services validate strictly
    // again before any server starts; allocation/controls always require it.
    if (requireBoundServer) throw cause;
  }
  return ports;
}

export function portPolicyError(port: number, infrastructure: Iterable<number> = []): string | null {
  if (!Number.isInteger(port) || port < 1 || port > MAX_DEV_PORT) return "Port must be an integer from 5910 to 65535";
  if (PORT_DENYLIST.includes(port) || [...infrastructure].includes(port)) return `Port ${port} is reserved for infrastructure and cannot be used by Dev Servers`;
  if (port < MIN_DEV_PORT) return "Dev server ports must start at 5910; ports below it are unavailable";
  return null;
}

export function assertPortAllowed(port: number, infrastructure: Iterable<number> = []) {
  const error = portPolicyError(port, infrastructure);
  if (error) throw new Error(error);
}

export function assertPortRange(config: { portBase: number; blockSize: number; blockCount: number }, infrastructure: Iterable<number> = []) {
  const { portBase, blockSize, blockCount } = config;
  if (!Number.isInteger(portBase) || !Number.isInteger(blockSize) || !Number.isInteger(blockCount)
    || blockSize < 1 || blockSize > 100 || blockCount < 1 || blockCount > 100) throw new Error("Port blocks require an integer base, size (1–100), and count (1–100)");
  const end = portBase + blockSize * blockCount - 1;
  if (end > MAX_DEV_PORT) throw new Error("The configured port blocks extend past port 65535");
  const blocked = [...new Set([...PORT_DENYLIST, ...infrastructure])].filter((p) => p >= portBase && p <= end).sort((a, b) => a - b);
  if (blocked.length) throw new Error(`Configured range ${portBase}-${end} overlaps infrastructure denylist: ${blocked.join(", ")}. Choose a range without reserved ports; they are never silently skipped.`);
  assertPortAllowed(portBase, infrastructure);
}
