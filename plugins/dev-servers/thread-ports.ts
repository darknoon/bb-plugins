import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { adoptBlock, blockSize, lastPort, type Assignment, type Block, type PortConfig, type ReclaimOptions } from "./port-blocks";
import { defaultServerName } from "./names";
import { portPolicyError } from "./port-policy";
import { TailnetRules, type TailnetRule } from "./tailnet";

export type PortListener = { port: number; pid: number; processName: string };
type ProcessInfo = { cwd: string | null; command: string | null };
type Owner = { environmentId: string; threadId: string; title: string | null; updatedAt: number; status: string };
type OwnedRule = { rule: TailnetRule; environmentId: string; threadId: string; pid: number };
export type PortSnapshot = { listeners: PortListener[]; config: PortConfig; reserved: Set<number>; reclaim?: ReclaimOptions };
type Dependencies = {
  processInfo: (pid: number) => Promise<ProcessInfo>;
  probe: (port: number) => Promise<boolean>;
  rules?: TailnetRules;
  now?: () => number;
};
const OWNED = "thread-serve:";
const OFFGRID = "offgrid-notice:";
const PRESSURE = "pressure-notice:";
const DISCOVERY_MS = 120_000;
const tailscaleProcess = (name: string) => /tailscale|ipnexten/i.test(name);
export const gridBase = (port: number, config: PortConfig) => port >= config.portBase && port <= lastPort(config)
  ? config.portBase + Math.floor((port - config.portBase) / config.blockSize) * config.blockSize : null;
export const isGridBase = (port: number, config: PortConfig) => gridBase(port, config) === port;
const allowed = (port: number) => port >= 5910 && port <= 6999 && portPolicyError(port) === null;
const devLike = (listener: PortListener, info: ProcessInfo) => !tailscaleProcess(listener.processName)
  && !/chrome|chromium|remote-debugging-port/i.test(`${listener.processName} ${info.command ?? ""}`)
  && /node|bun|vite|wrangler|workerd|http-server|http\.server|uvicorn|flask|harbor\s+view/i.test(`${listener.processName} ${info.command ?? ""}`);
const elapsed = (ms: number) => ms < 60_000 ? `${Math.floor(ms / 1000)}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h`;

export class ThreadPortManager {
  private readonly rules: TailnetRules;
  private readonly now: () => number;
  private lastDiscovery = -Infinity;
  private failures = new Map<string, string>();
  constructor(private readonly bb: BbPluginApi, private readonly deps: Dependencies) {
    this.rules = deps.rules ?? new TailnetRules();
    this.now = deps.now ?? Date.now;
  }
  private warn(key: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (this.failures.get(key) !== message) this.bb.log.warn(`Port management (${key}): ${message}`);
    this.failures.set(key, message);
  }
  private async assignments() {
    const rows = await Promise.all((await this.bb.storage.kv.list("assignment:")).map((key) => this.bb.storage.kv.get<Assignment>(key)));
    return rows.filter((r): r is Assignment => !!r);
  }
  private async environments() {
    const result: Array<{ id: string; path: string | null }> = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await this.bb.sdk.environments.list({ limit: 1000, offset });
      result.push(...page.filter((e) => e.status !== "destroyed"));
      if (page.length < 1000) return result;
    }
  }
  private resolver(environments: Array<{ id: string; path: string | null }>, assignments: Assignment[]) {
    const processes = new Map<number, Promise<ProcessInfo>>();
    const owners = new Map<string, Promise<Owner | null>>();
    const threads = new Map<string, Promise<Owner | null>>();
    const info = (pid: number) => {
      let value = processes.get(pid);
      if (!value) { value = this.deps.processInfo(pid); processes.set(pid, value); }
      return value;
    };
    const thread = (threadId: string) => {
      let value = threads.get(threadId);
      if (!value) {
        value = (async () => {
          try {
            const t = await this.bb.sdk.threads.get({ threadId });
            return t.environmentId && !t.deletedAt && !t.archivedAt
              ? { environmentId: t.environmentId, threadId: t.id, title: t.title ?? t.titleFallback, updatedAt: t.updatedAt, status: t.status } : null;
          } catch { return null; }
        })();
        threads.set(threadId, value);
      }
      return value;
    };
    const environmentOwners = new Map<string, Promise<Owner | null>>();
    const environmentOwner = (environmentId: string) => {
      let value = environmentOwners.get(environmentId);
      if (!value) {
        value = (async () => {
          const candidates = (await this.bb.sdk.threads.list({ environmentId, archived: false, includeHidden: true, limit: 1000 }))
            .filter((t) => !t.deletedAt && !t.archivedAt);
          // A shared checkout is insufficient evidence to pick one of several
          // threads. Only an assignment or a process thread ID can disambiguate.
          return candidates.length === 1 ? thread(candidates[0].id) : null;
        })();
        environmentOwners.set(environmentId, value);
      }
      return value;
    };
    const owner = (listener: PortListener) => {
      const key = `${listener.pid}:${listener.port}`;
      let value = owners.get(key);
      if (!value) {
        value = (async () => {
          const process = await info(listener.pid);
          const matching = environments.filter((e) => e.path && process.cwd && (process.cwd === e.path || process.cwd.startsWith(`${e.path}/`)))
            .sort((a, b) => b.path!.length - a.path!.length);
          const nearest = matching.filter((e) => e.path!.length === matching[0].path!.length);
          const assignment = assignments.find((a) => a.port === listener.port && (a.pid === undefined || a.pid === listener.pid)
            && (!nearest.length || nearest.some((e) => e.id === a.environmentId)));
          const candidates = [assignment?.threadId, ...(process.cwd ?? "").match(/thr_[a-z0-9]{10}/g) ?? [], ...(process.command ?? "").match(/thr_[a-z0-9]{10}/g) ?? []];
          for (const id of candidates) if (id) {
            const found = await thread(id);
            if (found && (!nearest.length || nearest.some((e) => e.id === found.environmentId))) return found;
          }
          return nearest.length === 1 ? environmentOwner(nearest[0].id) : null;
        })();
        owners.set(key, value);
      }
      return value;
    };
    return { info, owner, thread, environmentOwner };
  }
  private async notifyOnce(key: string, owner: Owner, text: string) {
    if (await this.bb.storage.kv.get(key)) return false;
    await this.bb.sdk.threads.send({ threadId: owner.threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
    await this.bb.storage.kv.set(key, { at: this.now(), threadId: owner.threadId });
    return true;
  }

  async sweep(snapshot: PortSnapshot, forceDiscovery = false) {
    // Listener inspection failed upstream => this method is never called with
    // a false empty snapshot. Tailnet-only listeners do not prove a backend lives.
    const backend = snapshot.listeners.filter((l) => !tailscaleProcess(l.processName));
    const occupied = new Set(backend.map((l) => l.port));
    let assignments = await this.assignments();
    const environments = await this.environments();
    let resolver = this.resolver(environments, assignments);
    const discovery = forceDiscovery || this.now() - this.lastDiscovery >= DISCOVERY_MS;
    if (discovery) {
      const incidents = new Set<string>();
      const persistentPids = new Set(backend.filter((l) => snapshot.reserved.has(l.port)).map((l) => l.pid));
      for (const listener of [...backend].sort((a, b) => a.port - b.port)) {
        if (!allowed(listener.port) || snapshot.reserved.has(listener.port) || persistentPids.has(listener.pid)) continue;
        const process = await resolver.info(listener.pid);
        if (!devLike(listener, process)) continue;
        const owner = await resolver.owner(listener);
        if (!owner) continue;
        const existing = assignments.find((a) => a.port === listener.port && a.environmentId === owner.environmentId && (a.pid === undefined || a.pid === listener.pid));
        if (existing?.terminalId) continue;
        const base = gridBase(listener.port, snapshot.config);
        let reason = "outside the configured app-port grid";
        const baseListener = base === null ? undefined : backend.find((l) => l.port === base);
        const baseOwner = baseListener ? await resolver.owner(baseListener) : null;
        const helper = baseListener && (baseListener.pid === listener.pid || baseOwner?.environmentId === owner.environmentId);
        if (base !== null && (listener.port === base || helper)) {
          try {
            for (const other of backend.filter((l) => l.port >= base && l.port < base + snapshot.config.blockSize && l.pid !== listener.pid)) {
              if ((await resolver.owner(other))?.environmentId !== owner.environmentId) throw new Error(`block ${base} contains another or unverified owner's listener`);
            }
            await adoptBlock(this.bb, owner.environmentId, listener.port, occupied, snapshot.config, snapshot.reserved, async (port, environment, expectedPid) => {
              const matches = backend.filter((l) => l.port === port && (expectedPid === undefined || l.pid === expectedPid));
              if (!matches.length) return false;
              let unknown = false;
              for (const match of matches) {
                const owner = await resolver.owner(match);
                if (owner?.environmentId === environment.id) return true;
                if (!owner) unknown = true;
              }
              return unknown ? null : false;
            }, snapshot.reclaim);
            const assignment: Assignment = { name: defaultServerName({ threadTitle: existing?.name ?? owner.title, command: process.command }), environmentId: owner.environmentId,
              port: listener.port, terminalId: null, pid: listener.pid, command: process.command ?? listener.processName, threadId: owner.threadId };
            await this.bb.storage.kv.set(`assignment:${owner.environmentId}:${listener.port}`, assignment);
            assignments.push(assignment);
            continue;
          } catch (cause) { reason = cause instanceof Error ? cause.message : String(cause); }
        }
        const key = `${OFFGRID}${owner.threadId}:${listener.port}`;
        incidents.add(key);
        try {
          await this.notifyOnce(key, owner, `Dev Servers: ${listener.processName} (PID ${listener.pid}) listens on :${listener.port}, ${reason}. It could not be adopted as an app on the configured grid. Stop this manually started server from its owning thread, then use bb dev-servers start --name "dev server" --command '<your dev command> --port {port} --strictPort'. Helper ports must share their owner's app block. If no block is free, request a release rather than choosing a port by hand. This notice is sent once until the issue clears.`);
        } catch (cause) { this.warn(key, cause); }
      }
      for (const key of await this.bb.storage.kv.list(OFFGRID)) if (!incidents.has(key)) await this.bb.storage.kv.delete(key);
      this.lastDiscovery = this.now();
      resolver = this.resolver(environments, assignments);
    }

    await this.resetPressureIfFree(snapshot, occupied);
    let currentRules: TailnetRule[];
    try { currentRules = await this.rules.privateRootRules(); this.failures.delete("tailnet"); }
    catch (cause) { this.warn("tailnet", cause); return; }

    const desired = new Map<number, { owner: Owner; listener: PortListener; assignment: Assignment }>();
    for (const assignment of assignments) {
      if (!allowed(assignment.port) || !isGridBase(assignment.port, snapshot.config) || snapshot.reserved.has(assignment.port)) continue;
      for (const listener of backend.filter((l) => l.port === assignment.port)) {
        const owner = await resolver.owner(listener);
        if (owner?.environmentId === assignment.environmentId && devLike(listener, await resolver.info(listener.pid))) {
          desired.set(listener.port, { owner, listener, assignment }); break;
        }
      }
    }
    // Remove owned rules as soon as the app/assignment disappears. A process
    // that replaces it cannot inherit the old thread's ownership.
    for (const key of await this.bb.storage.kv.list(OWNED)) {
      const owned = await this.bb.storage.kv.get<OwnedRule>(key);
      if (!owned) continue;
      if (snapshot.reserved.has(owned.rule.port)) {
        // Persistent supervision takes over its own route. Never let old
        // thread metadata remove a newly reserved persistent endpoint.
        await this.bb.storage.kv.delete(key);
        continue;
      }
      const want = desired.get(owned.rule.port);
      if (!want || want.owner.environmentId !== owned.environmentId || want.listener.pid !== owned.pid) {
        try { await this.rules.remove(owned.rule); await this.bb.storage.kv.delete(key); this.failures.delete(key); }
        catch (cause) { this.warn(key, cause); }
      }
    }
    for (const [port, want] of desired) {
      if (!(await this.deps.probe(port))) continue; // A real expected HTTP response, never just a TCP handshake.
      const key = `${OWNED}${port}`;
      try {
        const previous = await this.bb.storage.kv.get<OwnedRule>(key);
        const rule = await this.rules.inspect(port, true, previous?.rule, want.assignment.name);
        await this.bb.storage.kv.set(key, { rule, environmentId: want.owner.environmentId, threadId: want.owner.threadId, pid: want.listener.pid } satisfies OwnedRule);
        await this.rules.ensure(rule);
        this.failures.delete(key);
      } catch (cause) { this.warn(key, cause); }
    }
    if (discovery) {
      try {
        for (const rule of currentRules) {
          if (!allowed(rule.port) || snapshot.reserved.has(rule.port) || occupied.has(rule.port) || assignments.some((a) => a.port === rule.port)) continue;
          // Includes old grid-base routes after their app stopped, and orphaned
          // off-grid routes. Funnel, custom handlers and VNC never enter here.
          await this.rules.remove(rule);
        }
        this.failures.delete("orphan-rules");
      } catch (cause) { this.warn("orphan-rules", cause); }
    }
  }

  private async resetPressureIfFree(snapshot: PortSnapshot, occupied: Set<number>) {
    // A free pool ends the scarcity episode, allowing one future release offer.
    const held = await this.blocks();
    const free = Array.from({ length: snapshot.config.blockCount }, (_, i) => snapshot.config.portBase + i * snapshot.config.blockSize)
      .some((base) => ![...snapshot.reserved, ...occupied].some((p) => p >= base && p < base + snapshot.config.blockSize)
        && !held.some((b) => base < b.base + blockSize(b, snapshot.config) && b.base < base + snapshot.config.blockSize));
    if (free) for (const key of await this.bb.storage.kv.list(PRESSURE)) await this.bb.storage.kv.delete(key);
  }

  private async blocks() {
    const rows = await Promise.all((await this.bb.storage.kv.list("block:")).map((key) => this.bb.storage.kv.get<Block>(key)));
    return rows.filter((b): b is Block => !!b);
  }
  async removeForPorts(ports: Iterable<number>, threadId: string) {
    for (const port of new Set(ports)) {
      const key = `${OWNED}${port}`;
      const owned = await this.bb.storage.kv.get<OwnedRule>(key);
      if (owned?.threadId !== threadId) continue;
      try { await this.rules.remove(owned.rule); await this.bb.storage.kv.delete(key); }
      catch (cause) { this.warn(key, cause); }
    }
  }
  async dispose() {
    for (const key of await this.bb.storage.kv.list(OWNED)) {
      const owned = await this.bb.storage.kv.get<OwnedRule>(key);
      if (!owned) continue;
      try { await this.rules.remove(owned.rule); await this.bb.storage.kv.delete(key); }
      catch (cause) { this.warn(key, cause); }
    }
  }

  async pressure(snapshot: PortSnapshot, requesterThreadId: string) {
    const assignments = await this.assignments();
    const blocks = await this.blocks();
    const resolver = this.resolver(await this.environments(), assignments);
    const lines: string[] = [];
    const offers: Array<{ owner: Owner; base: number; idleMs: number; stopped: boolean }> = [];
    for (let i = 0; i < snapshot.config.blockCount; i++) {
      const base = snapshot.config.portBase + i * snapshot.config.blockSize;
      const end = base + snapshot.config.blockSize - 1;
      const records = snapshot.listeners.filter((l) => l.port >= base && l.port <= end && !tailscaleProcess(l.processName));
      const held = blocks.find((b) => base < b.base + blockSize(b, snapshot.config) && b.base <= end);
      const assignment = assignments.find((a) => a.port >= base && a.port <= end && (!held || a.environmentId === held.environmentId));
      const owner = records.length ? await resolver.owner(records.find((l) => l.port === base) ?? records[0])
        : assignment?.threadId ? await resolver.thread(assignment.threadId) : held ? await resolver.environmentOwner(held.environmentId) : null;
      const persistent = [...snapshot.reserved].filter((p) => p >= base && p <= end);
      if (persistent.length) { lines.push(`${base}-${end}: persistent reservation ${persistent.join(", ")}; idle not applicable`); continue; }
      const stopped = held?.idleSince !== undefined && records.length === 0;
      const idleMs = stopped ? this.now() - held!.idleSince! : owner ? Math.max(0, this.now() - owner.updatedAt) : null;
      lines.push(`${base}-${end}: ${owner?.title ?? assignment?.name ?? records[0]?.processName ?? "pending lease"}; thread ${owner?.threadId ?? assignment?.threadId ?? "unknown"}; ${records.map((r) => `PID ${r.pid} :${r.port}`).join(", ") || "no listener"}; ${stopped ? "stopped" : "thread"} idle ${idleMs === null ? "unknown" : elapsed(idleMs)}`);
      if (owner && owner.threadId !== requesterThreadId && idleMs !== null) offers.push({ owner, base, idleMs, stopped });
    }
    const longest = offers.sort((a, b) => b.idleMs - a.idleMs)[0];
    let offer = "No identifiable holder is available for a release request.";
    if (longest) {
      try {
        const sent = await this.notifyOnce(`${PRESSURE}${longest.owner.threadId}:${longest.base}`, longest.owner,
          `Dev Servers: all configured port blocks are busy and thread ${requesterThreadId} needs one. Your block :${longest.base} is the longest-idle identified holder (${elapsed(longest.idleMs)} ${longest.stopped ? "since its server stopped" : "since thread activity"}). If Andrew no longer needs it, ${longest.stopped ? "run bb dev-servers release" : "run bb dev-servers stop, then bb dev-servers release"} from this owning thread. No process has been killed or port taken; keep it if it is still needed.`);
        offer = `${sent ? "Sent" : "Already offered"} a release request to thread ${longest.owner.threadId} for :${longest.base} (idle ${elapsed(longest.idleMs)}). Retry start after the owner releases it.`;
      } catch (cause) { offer = `Could not deliver the release request: ${cause instanceof Error ? cause.message : String(cause)}`; }
    }
    return { holders: lines, offer };
  }
}
