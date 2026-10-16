import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { assertPortAllowed, assertPortRange, runtimeInfrastructurePorts } from "./port-policy";

export type PortConfig = { portBase: number; blockSize: number; blockCount: number };
export type Block = { environmentId: string; index: number; base: number; size?: number };
export type Assignment = {
  name?: string;
  environmentId: string;
  port: number;
  terminalId: string | null;
  command: string;
  threadId?: string;
};
// null means ownership could not be established; inspection failures must not
// turn a live adopted server into evidence that a block is free.
export type ListenerOwnership = (port: number, environment: { id: string; path?: string | null }) => Promise<boolean | null>;
export const blockBase = (config: PortConfig, index: number) => config.portBase + index * config.blockSize;
export const lastPort = (config: PortConfig) => blockBase(config, config.blockCount - 1) + config.blockSize - 1;
export const blockSize = (block: Block, config: PortConfig) => block.size
  // Pre-lease records used 5910 + index*10 and did not store their size.
  // Preserve their full span even under a custom five-port configuration.
  ?? (config.portBase === 5910 && config.blockSize === 5 && block.base === 5910 + block.index * 10 ? 10 : config.blockSize);
export const blockContains = (block: Block, port: number, config: PortConfig) =>
  port >= block.base && port < block.base + blockSize(block, config);

async function assignments(bb: BbPluginApi) {
  const rows = await Promise.all((await bb.storage.kv.list("assignment:")).map(async (key) => ({
    key, value: await bb.storage.kv.get<Assignment>(key),
  })));
  return rows.flatMap(({ key, value }) => value ? [{ key, value }] : []);
}

export async function managedPortHolder(bb: BbPluginApi, environmentId: string | null, port: number) {
  const candidates = environmentId
    ? [await bb.storage.kv.get<Assignment>(`assignment:${environmentId}:${port}`)].filter((a): a is Assignment => !!a)
    : (await assignments(bb)).map((row) => row.value).filter((a) => a.port === port);
  for (const assignment of candidates) {
    if (!assignment.terminalId) continue;
    try {
      const { sessions } = await bb.sdk.terminals.list({ scope: assignment.threadId
        ? { kind: "thread", threadId: assignment.threadId }
        : { kind: "environment", environmentId: assignment.environmentId },
      });
      const terminal = sessions.find((s) => s.id === assignment.terminalId);
      if (terminal && terminal.status !== "exited") return { ...assignment, status: terminal.status };
    } catch {
      return { ...assignment, status: "unknown" };
    }
  }
  return null;
}

// No terminal events are available in the SDK. Sweep periodically and before allocation.
// A managed terminal also protects the startup interval before its process binds a port.
export async function reclaimIdleBlocks(bb: BbPluginApi, occupied: Set<number>, config: PortConfig, ownsListener?: ListenerOwnership) {
  const live = new Map<string, { id: string; path?: string | null }>();
  for (let offset = 0; ; offset += 1000) {
    const page = await bb.sdk.environments.list({ limit: 1000, offset });
    for (const environment of page) if (environment.status !== "destroyed") live.set(environment.id, environment);
    if (page.length < 1000) break;
  }
  const rows = await assignments(bb);
  const scopes = new Map<string, Promise<Set<string>>>();
  const retained = new Set<string>();
  // Reconcile every assignment, including explicit ports outside a block and
  // old rows left behind by a settings change. A foreign listener never revives
  // a closed managed terminal's lease.
  for (const { key, value } of rows) {
    const environment = live.get(value.environmentId);
    let busy = false;
    if (environment && value.terminalId) {
      const scopeKey = value.threadId ? `thread:${value.threadId}` : `environment:${value.environmentId}`;
      let sessions = scopes.get(scopeKey);
      if (!sessions) {
        sessions = bb.sdk.terminals.list({ scope: value.threadId
          ? { kind: "thread", threadId: value.threadId }
          : { kind: "environment", environmentId: value.environmentId },
        }).then(({ sessions }) => new Set(sessions.filter((s) => s.status !== "exited").map((s) => s.id)));
        scopes.set(scopeKey, sessions);
      }
      try { busy = (await sessions).has(value.terminalId); }
      catch { busy = true; }
    } else if (environment && occupied.has(value.port)) {
      busy = !ownsListener || await ownsListener(value.port, environment) !== false;
    }
    if (busy) retained.add(key);
    else await bb.storage.kv.delete(key);
  }
  const active: Block[] = [];
  for (const key of await bb.storage.kv.list("block:")) {
    const saved = await bb.storage.kv.get<Block>(key);
    if (!saved) continue;
    const block = { ...saved, size: blockSize(saved, config) };
    const blockAssignments = rows.filter(({ value }) => value.environmentId === block.environmentId && blockContains(block, value.port, config));
    let busy = blockAssignments.some(({ key }) => retained.has(key));
    const environment = live.get(block.environmentId);
    // Legacy blocks can predate assignment records. Preserve their actual own
    // listeners, but not another environment's process in the same port span.
    if (!busy && environment && blockAssignments.length === 0) {
      for (const port of occupied) if (blockContains(block, port, config)) {
        busy = !ownsListener || await ownsListener(port, environment) !== false;
        if (busy) break;
      }
    }
    if (live.has(block.environmentId) && busy) {
      active.push(block);
      // Stamp legacy records before settings change, preserving running 10-port blocks.
      if (saved.size === undefined) await bb.storage.kv.set(key, block);
    } else {
      await bb.storage.kv.delete(key);
      for (const { key: assignmentKey } of blockAssignments) await bb.storage.kv.delete(assignmentKey);
    }
  }
  return active;
}

export async function assignBlock(bb: BbPluginApi, environmentId: string, occupied: Set<number>, config: PortConfig, reserved: Set<number>, ownsListener?: ListenerOwnership) {
  const infrastructure = runtimeInfrastructurePorts(bb);
  assertPortRange(config, infrastructure);
  const active = await reclaimIdleBlocks(bb, occupied, config, ownsListener);
  const prior = active.find((block) => block.environmentId === environmentId);
  if (prior) {
    if (occupied.has(prior.base) && ownsListener && await ownsListener(prior.base, { id: environmentId }) === false) {
      throw new Error(`Retained block ${prior.base}-${prior.base + prior.size! - 1} has another environment's listener on its base. Stop this environment's remaining servers and release its lease before starting again.`);
    }
    assertPortRange({ portBase: prior.base, blockSize: prior.size!, blockCount: 1 }, infrastructure);
    if ([...reserved].some((port) => blockContains(prior, port, config))) {
      throw new Error("This worktree block overlaps a persistent port; adjust the worktree port settings");
    }
    return prior;
  }
  for (let index = 0; index < config.blockCount; index++) {
    const block: Block = { environmentId, index, base: blockBase(config, index), size: config.blockSize };
    const overlaps = active.some((held) => block.base < held.base + held.size! && held.base < block.base + block.size!);
    if (overlaps || [...occupied, ...reserved].some((port) => blockContains(block, port, config))) continue;
    await bb.storage.kv.set(`block:${environmentId}`, block);
    return block;
  }
  return null;
}

export async function adoptBlock(bb: BbPluginApi, environmentId: string, port: number, occupied: Set<number>, config: PortConfig, reserved: Set<number>, ownsListener?: ListenerOwnership) {
  const infrastructure = runtimeInfrastructurePorts(bb);
  assertPortRange(config, infrastructure);
  assertPortAllowed(port, infrastructure);
  if (port < config.portBase || port > lastPort(config)) throw new Error(`Port ${port} is outside the thread range ${config.portBase}-${lastPort(config)}`);
  const active = await reclaimIdleBlocks(bb, occupied, config, ownsListener);
  const prior = active.find((block) => block.environmentId === environmentId);
  if (prior) {
    assertPortRange({ portBase: prior.base, blockSize: prior.size!, blockCount: 1 }, infrastructure);
    if (!blockContains(prior, port, config)) throw new Error(`This environment already uses block ${prior.base}-${prior.base + prior.size! - 1}`);
    if ([...reserved].some((candidate) => blockContains(prior, candidate, config))) throw new Error("This worktree block overlaps a persistent port");
    return prior;
  }
  const index = Math.floor((port - config.portBase) / config.blockSize);
  const block: Block = { environmentId, index, base: blockBase(config, index), size: config.blockSize };
  if ([...reserved].some((candidate) => blockContains(block, candidate, config))) throw new Error("This worktree block overlaps a persistent port");
  if (active.some((held) => block.base < held.base + held.size! && held.base < block.base + block.size!)) throw new Error(`Block ${block.base}-${block.base + block.size! - 1} already belongs to another active environment`);
  await bb.storage.kv.set(`block:${environmentId}`, block);
  return block;
}
