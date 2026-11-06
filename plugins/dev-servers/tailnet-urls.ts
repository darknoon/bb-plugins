import { setTimeout as delay } from "node:timers/promises";
import { TailnetRules } from "./tailnet";

export const VERIFIED_URL_GRACE_MS = 60_000;

// A status-command failure does not mean a Serve route disappeared. Share
// concurrent reads and briefly retain verified private routes on read errors.
// A successful read always replaces the cache, including an empty result.
export class TailnetUrlResolver {
  private verified: { urls: Map<number, string>; at: number } | null = null;
  private pending: Promise<Map<number, string>> | null = null;
  private reported = false;
  constructor(private readonly options: {
    read?: () => Promise<Map<number, string>>;
    now?: () => number;
    retryDelay?: () => Promise<unknown>;
    onError?: (cause: unknown) => void;
  } = {}) {}

  private async read() {
    const urls = this.options.read ? await this.options.read() : new Map(
      (await new TailnetRules().privateRootRules()).map((rule) => [rule.port, `https://${rule.dnsName}:${rule.port}`]),
    );
    this.verified = { urls, at: (this.options.now ?? Date.now)() };
    this.reported = false;
    return urls;
  }
  private report(cause: unknown) {
    if (!this.reported) this.options.onError?.(cause);
    this.reported = true;
  }
  private async refresh() {
    try { return await this.read(); }
    catch (cause) {
      this.report(cause);
      if (this.verified && (this.options.now ?? Date.now)() - this.verified.at < VERIFIED_URL_GRACE_MS) return this.verified.urls;
    }
    // Initial reads have no verified route to fall back to. Retry once with a
    // bounded delay; never guess a URL from the app origin or create exposure.
    await (this.options.retryDelay ?? (() => delay(100)))();
    try { return await this.read(); }
    catch (cause) { this.report(cause); return new Map<number, string>(); }
  }
  async get(ports: Iterable<number>) {
    const pending = this.pending ?? (this.pending = this.refresh());
    try {
      const urls = await pending;
      return new Map([...ports].flatMap((port) => urls.has(port) ? [[port, urls.get(port)!] as const] : []));
    } finally { if (this.pending === pending) this.pending = null; }
  }
}
