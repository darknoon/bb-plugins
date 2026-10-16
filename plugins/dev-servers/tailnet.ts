import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { assertPortAllowed } from "./port-policy";
import { serverNameSchema } from "./names";

const execFile = promisify(execFileCallback);
// Native Tailscale Serve has no description field. This label is plugin-owned
// metadata, alongside the exact native route used for safe ownership/cleanup.
export type TailnetRule = { dnsName: string; port: number; proxy: string; description?: string };
type ServeStatus = {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
};
type Runner = (args: string[]) => Promise<string>;

export class TailnetRules {
  constructor(private readonly execute: Runner = async (args) => {
    const { stdout, stderr } = await execFile(process.env.TAILSCALE_BIN ?? "tailscale", args, { timeout: 3000, maxBuffer: 256_000 });
    // Some Tailscale.app CLI failures return exit 0 with a diagnostic instead of JSON.
    if (stderr.includes("failed") || stdout.includes("failed to start")) throw new Error(stderr || stdout);
    return stdout;
  }) {}

  private async status() {
    const [statusText, serveText] = await Promise.all([this.execute(["status", "--json"]), this.execute(["serve", "status", "--json"])]);
    const status = JSON.parse(statusText) as { BackendState?: string; Self?: { DNSName?: string } };
    const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
    if (status.BackendState !== "Running" || !dnsName?.endsWith(".ts.net")) throw new Error("Tailscale must be connected to the private tailnet");
    return { dnsName, serve: JSON.parse(serveText) as ServeStatus };
  }
  private matches(serve: ServeStatus, rule: TailnetRule) {
    const key = `${rule.dnsName}:${rule.port}`;
    const handlers = serve.Web?.[key]?.Handlers;
    return serve.TCP?.[rule.port]?.HTTPS === true
      && handlers && Object.keys(handlers).length === 1
      && handlers["/"]?.Proxy?.replace(/\/$/, "") === rule.proxy;
  }
  private assertPrivate(serve: ServeStatus, rule: TailnetRule) {
    if (serve.AllowFunnel?.[`${rule.dnsName}:${rule.port}`]) throw new Error(`Port ${rule.port} has public Funnel enabled; persistent servers require tailnet-only access`);
  }
  async inspect(port: number, adopt = false, owned: TailnetRule | null = null, description?: string): Promise<TailnetRule> {
    assertPortAllowed(port);
    const { dnsName, serve } = await this.status();
    const rule = { dnsName, port, proxy: `http://127.0.0.1:${port}`, ...(description === undefined ? {} : { description: serverNameSchema.parse(description) }) };
    this.assertPrivate(serve, rule);
    const occupied = serve.TCP?.[port] || Object.keys(serve.Web ?? {}).some((key) => key.endsWith(`:${port}`));
    if (occupied && (!this.matches(serve, rule) || (!adopt && owned?.dnsName !== dnsName))) {
      throw new Error(`Serve port ${port} already belongs to another rule; use --adopt-tailnet-rule only for the identical private root proxy`);
    }
    return rule;
  }
  async ensure(rule: TailnetRule) {
    assertPortAllowed(rule.port);
    const { dnsName, serve } = await this.status();
    if (dnsName !== rule.dnsName) throw new Error("Tailnet identity changed; refusing to alter another machine's rule");
    this.assertPrivate(serve, rule);
    if (this.matches(serve, rule)) return;
    if (serve.TCP?.[rule.port] || serve.Web?.[`${dnsName}:${rule.port}`]) throw new Error(`Serve port ${rule.port} changed; refusing to overwrite it`);
    await this.execute(["serve", "--bg", "--yes", `--https=${rule.port}`, rule.proxy]);
    const after = await this.status();
    this.assertPrivate(after.serve, rule);
    if (!this.matches(after.serve, rule)) throw new Error("Tailscale did not install the expected private proxy");
  }
  async remove(rule: TailnetRule) {
    const { dnsName, serve } = await this.status();
    if (dnsName !== rule.dnsName) throw new Error("Tailnet identity changed; refusing to remove another machine's rule");
    const exists = serve.TCP?.[rule.port] || serve.Web?.[`${dnsName}:${rule.port}`];
    if (!exists) return;
    this.assertPrivate(serve, rule);
    if (!this.matches(serve, rule)) throw new Error(`Serve port ${rule.port} was modified externally; leaving it untouched`);
    await this.execute(["serve", "--yes", `--https=${rule.port}`, "off"]);
    const after = await this.status();
    if (after.serve.TCP?.[rule.port] || after.serve.Web?.[`${dnsName}:${rule.port}`]) throw new Error(`Serve port ${rule.port} could not be removed`);
  }
}
