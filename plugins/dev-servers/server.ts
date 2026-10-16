import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { cliCommand, defineCli, defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { checkHealth, PersistentSupervisor, persistentInputSchema, persistentServerSchema } from "./persistent";
import { adoptBlock, assignBlock, blockBase, blockContains, blockSize, lastPort, managedPortHolder, reclaimIdleBlocks, type Assignment, type Block, type ListenerOwnership, type PortConfig } from "./port-blocks";
import { assertPortAllowed, assertPortRange, runtimeInfrastructurePorts } from "./port-policy";
import { defaultServerName, serverNameSchema, shortServerName } from "./names";
import { strictViteCommand } from "./strict-vite";
import { ThreadPortManager } from "./thread-ports";
import type { TailnetRules } from "./tailnet";
export { assignBlock } from "./port-blocks";

const execFile = promisify(execFileCallback);

const terminalSchema = z.object({ id: z.string(), title: z.string(), status: z.string() });
const serverSchema = z.object({
  name: serverNameSchema,
  projectId: z.string(),
  projectName: z.string(),
  environmentId: z.string(),
  environmentName: z.string(),
  branchName: z.string().nullable(),
  path: z.string(),
  port: z.number().int(),
  pid: z.number().int(),
  processName: z.string(),
  command: z.string().nullable(),
  connectUrl: z.string().url().nullable(),
  tailnetUrl: z.string().url().nullable(),
  tailnetDescription: serverNameSchema.nullable(),
  threadIds: z.array(z.string()),
  thread: z.object({ id: z.string(), title: z.string() }).nullable(),
  terminal: terminalSchema.nullable(),
  association: z.enum(["managed", "inferred", "external"]),
});

export const rpcContract = defineRpcContract({
  list: {
    input: z.object({ projectId: z.string().nullable() }).strict(),
    output: z.object({ servers: z.array(serverSchema), scannedAt: z.number() }),
  },
  persistentList: {
    input: z.object({ logLines: z.number().int().min(0).max(80).default(10) }).strict(),
    output: z.object({ servers: z.array(persistentServerSchema) }),
  },
  persistentAdd: { input: persistentInputSchema, output: persistentServerSchema },
  persistentControl: {
    input: z.object({ name: z.string(), action: z.enum(["start", "stop", "restart", "remove"]) }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
});

type EnvironmentInfo = {
  projectId: string;
  projectName: string;
  id: string;
  name: string | null;
  branchName: string | null;
  path: string;
  hostId: string;
  threads: Array<{
    id: string;
    title: string;
    updatedAt: number;
    archivedAt: number | null;
  }>;
};
type Listener = {
  pid: number;
  processName: string;
  port: number;
  cwd: string;
  command: string | null;
};
type ProjectThread = { id: string; environmentId: string | null; title?: string | null; titleFallback?: string | null };

type TailscaleStatus = {
  BackendState?: string;
  Self?: { DNSName?: string };
};

type TailscaleServeStatus = {
  Web?: Record<string, {
    Handlers?: Record<string, { Proxy?: string }>;
  }>;
};

function projectThreads(project: unknown): ProjectThread[] {
  if (!project || typeof project !== "object" || !("threads" in project)) return [];
  return Array.isArray(project.threads) ? project.threads as ProjectThread[] : [];
}

function parseListenerRecords(output: string) {
  const rows: Array<{ pid: number; processName: string; port: number }> = [];
  let pid: number | null = null;
  let processName = "unknown";
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (line.startsWith("c")) processName = line.slice(1);
    if (!line.startsWith("n") || pid === null) continue;
    const match = line.match(/:(\d+)(?:\s|$)/);
    if (match) rows.push({ pid, processName, port: Number(match[1]) });
  }
  return Array.from(new Map(rows.map((row) => [`${row.pid}:${row.port}`, row])).values());
}

async function listenerRecords() {
  try {
    const { stdout } = await execFile("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]);
    return parseListenerRecords(stdout);
  } catch (cause) {
    // lsof exits 1 with empty stdout when there are no listeners. Other failures must
    // not become a false idle snapshot that releases a running server's block.
    const error = cause as { code?: number; stdout?: string };
    if (error.code === 1 && error.stdout === "") return [];
    throw cause;
  }
}

async function processCwd(pid: number) {
  try {
    const { stdout } = await execFile("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    return stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? null;
  } catch {
    return null;
  }
}

function listenerOwnership(bb: BbPluginApi, records: Awaited<ReturnType<typeof listenerRecords>>): ListenerOwnership {
  const cwds = new Map<number, Promise<string | null>>();
  let paths: Promise<Array<{ id: string; path: string | null }>> | undefined;
  return async (port, environment, expectedPid) => {
    if (expectedPid !== undefined && !records.some((r) => r.port === port && r.pid === expectedPid)) return false;
    paths ??= (async () => {
      const result: Array<{ id: string; path: string | null }> = [];
      for (let offset = 0; ; offset += 1000) {
        const page = await bb.sdk.environments.list({ limit: 1000, offset });
        result.push(...page.filter((e) => e.status !== "destroyed"));
        if (page.length < 1000) return result;
      }
    })();
    const environments = await paths;
    const ownPath = environment.path ?? environments.find((e) => e.id === environment.id)?.path;
    let unknown = false;
    for (const record of records.filter((r) => r.port === port)) {
      let cwd = cwds.get(record.pid);
      if (!cwd) { cwd = processCwd(record.pid); cwds.set(record.pid, cwd); }
      const path = await cwd;
      if (!path) { unknown = true; continue; }
      const owner = environments.filter((e) => e.path && (path === e.path || path.startsWith(`${e.path}/`)))
        .sort((a, b) => b.path!.length - a.path!.length)[0];
      if (owner?.id === environment.id || (ownPath && (path === ownPath || path.startsWith(`${ownPath}/`)))) return true;
      if (!owner) unknown = true;
    }
    return unknown ? null : false;
  };
}

async function processCommand(pid: number) {
  try {
    const { stdout } = await execFile("/bin/ps", ["-p", String(pid), "-o", "command="]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function proxyTargetsLocalPort(proxy: string | undefined, port: number) {
  if (!proxy) return false;
  try {
    const target = new URL(proxy);
    const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    return target.protocol === "http:"
      && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
      && targetPort === port;
  } catch {
    return false;
  }
}

async function tailnetUrls(ports: Iterable<number>) {
  const urls = new Map<number, string>();
  try {
    const tailscale = process.env.TAILSCALE_BIN ?? "tailscale";
    const [{ stdout: statusOutput }, { stdout: serveOutput }] = await Promise.all([
      execFile(tailscale, ["status", "--json"]),
      execFile(tailscale, ["serve", "status", "--json"]),
    ]);
    const status = JSON.parse(statusOutput) as TailscaleStatus;
    const serve = JSON.parse(serveOutput) as TailscaleServeStatus;
    const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
    if (status.BackendState !== "Running" || !dnsName || !serve.Web) return urls;

    for (const port of ports) {
      const rootHandler = serve.Web[`${dnsName}:${port}`]?.Handlers?.["/"];
      if (proxyTargetsLocalPort(rootHandler?.Proxy, port)) {
        urls.set(port, `https://${dnsName}:${port}`);
      }
    }
  } catch {
    // Tailscale is optional. BB Connect remains the cross-network fallback.
  }
  return urls;
}

// Ports are handed out a block at a time, not one at a time: a worktree runs more than one
// service, and a block keeps that worktree's ports together and stable. Worktree k owns
// portBase + k*blockSize through +blockSize-1, written in commands as `{port}` for the base
// and `{port+N}` for the Nth slot.
const DEFAULT_PORT_BASE = 5910;
// Fieldlabel's R2 CORS allowlist accepts dev origins on 5910, 5920, ... 5990.
// Keep app bases on this grid; auxiliary ports (including inspectors) use offsets.
const DEFAULT_BLOCK_SIZE = 10;
const DEFAULT_BLOCK_COUNT = 9;
const PORT_PLACEHOLDER = /\{port(?:\+(\d+))?\}/g;

export function parsePortConfig(values: { portBase: string; blockSize: string; blockCount: string }, infrastructure: Iterable<number> = []) {
  const config: PortConfig = {
    portBase: Number(values.portBase),
    blockSize: Number(values.blockSize),
    blockCount: Number(values.blockCount),
  };
  try { assertPortRange(config, infrastructure); }
  catch (cause) { return { config: null, error: cause instanceof Error ? cause.message : String(cause) }; }
  return { config, error: null };
}

// `{port}` is the block base, `{port+N}` the Nth slot. An offset past the end of the block would
// land in the next worktree's ports, so it fails rather than silently overrunning.
function expandPorts(template: string, base: number, blockSize: number) {
  const offsets = Array.from(template.matchAll(PORT_PLACEHOLDER), (match) => (match[1] ? Number(match[1]) : 0));
  const overrun = offsets.find((offset) => offset >= blockSize) ?? null;
  const command = template.replaceAll(PORT_PLACEHOLDER, (_match, offset?: string) =>
    String(base + (offset ? Number(offset) : 0)));
  return { command, ports: offsets.map((offset) => base + offset), overrun };
}

async function isHtmlServer(port: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: controller.signal,
      redirect: "manual",
    });
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.includes("text/html") || response.status >= 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function commandAllowsPort(command: string | null, processName: string, port: number) {
  const explicitPort = command?.match(/--port(?:=|\s+)(\d+)/)?.[1];
  if (explicitPort) return Number(explicitPort) === port;
  const diagnosticProcess = `${processName} ${command ?? ""}`.toLowerCase();
  return ![
    "agent-browser",
    "chrome for testing",
    "remote-debugging-port",
    "inspector-addr",
    "workerd serve",
  ].some((marker) => diagnosticProcess.includes(marker));
}

async function discoverListeners(excludedPorts = new Set<number>()) {
  const candidates = (await listenerRecords()).filter(({ port }) => port >= 1024 && port !== 38886 && port !== 38887 && !excludedPorts.has(port));
  const listeners = await Promise.all(candidates.map(async (candidate): Promise<Listener | null> => {
    const [cwd, command, servesHtml] = await Promise.all([
      processCwd(candidate.pid),
      processCommand(candidate.pid),
      isHtmlServer(candidate.port),
    ]);
    return cwd && servesHtml && commandAllowsPort(command, candidate.processName, candidate.port)
      ? { ...candidate, cwd, command }
      : null;
  }));
  return listeners.filter((listener): listener is Listener => listener !== null);
}

async function projectEnvironments(bb: BbPluginApi, projectId: string | null) {
  const projects = await bb.sdk.projects.list();
  const selected = projectId === null ? projects : projects.filter((row) => row.id === projectId);
  const owners = new Map<string, {
    projectId: string;
    projectName: string;
    threads: EnvironmentInfo["threads"];
  }>();
  await Promise.all(selected.map(async (project) => {
    const [active, archived] = await Promise.all([
      bb.sdk.threads.list({ projectId: project.id, archived: false, includeHidden: true, limit: 1000 }),
      bb.sdk.threads.list({ projectId: project.id, archived: true, includeHidden: true, limit: 1000 }),
    ]);
    for (const thread of [...active, ...archived]) {
      if (!thread.environmentId || thread.visibility !== "visible") continue;
      const owner = owners.get(thread.environmentId) ?? {
        projectId: project.id,
        projectName: project.name,
        threads: [],
      };
      owner.threads.push({
        id: thread.id,
        title: thread.title ?? thread.titleFallback ?? "Untitled chat",
        updatedAt: thread.updatedAt,
        archivedAt: thread.archivedAt,
      });
      owners.set(thread.environmentId, owner);
    }
  }));
  for (const owner of owners.values()) {
    owner.threads.sort((a, b) => {
      if ((a.archivedAt === null) !== (b.archivedAt === null)) return a.archivedAt === null ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }
  const environments = await Promise.all(Array.from(owners.keys()).map((environmentId) => bb.sdk.environments.get({ environmentId })));
  return environments.flatMap((environment) => {
    const owner = owners.get(environment.id);
    if (!owner || environment.status !== "ready" || environment.path === null) return [];
    const result: EnvironmentInfo = {
      id: environment.id,
      name: environment.name,
      branchName: environment.branchName,
      path: environment.path,
      hostId: environment.hostId,
      ...owner,
    };
    return [result];
  });

}

async function terminalForPort(bb: BbPluginApi, environment: EnvironmentInfo, port: number, assignment: Assignment | null) {
  // Managed dev servers are created in a thread-scoped terminal. Looking only at the
  // environment scope can never find that terminal, even though the terminal record carries
  // the same environmentId. Resolve the persisted terminal ID directly before falling back to
  // output-based inference for environment-scoped terminals started another way.
  if (assignment?.terminalId) {
    try {
      const terminal = await bb.sdk.terminals.get({ terminalId: assignment.terminalId });
      if (terminal.environmentId === environment.id) {
        return { terminal, association: "managed" as const };
      }
    } catch {
      // The saved terminal may have been closed or removed; inference can still find another one.
    }
  }

  const { sessions } = await bb.sdk.terminals.list({ scope: { kind: "environment", environmentId: environment.id } });
  for (const terminal of sessions.filter((row) => row.status === "running")) {
    const output = await bb.sdk.terminals.output({ terminalId: terminal.id, tailBytes: 24_000 });
    const text = output.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8")).join("");
    if (text.includes(`:${port}`) || text.includes(`--port ${port}`) || text.includes(`--port=${port}`)) {
      return { terminal, association: "inferred" as const };
    }
  }
  return { terminal: null, association: "external" as const };
}

async function listServers(bb: BbPluginApi, projectId: string | null, persistentPorts = new Set<number>()) {
  const [environments, listeners, assignmentRows] = await Promise.all([
    projectEnvironments(bb, projectId),
    discoverListeners(persistentPorts),
    bb.storage.kv.list("assignment:"),
  ]);
  const assignmentValues = await Promise.all(
    assignmentRows.map((key) => bb.storage.kv.get<Assignment>(key)),
  );
  const assignments = new Map(
    assignmentValues
      .filter((assignment): assignment is Assignment => assignment !== undefined)
      .map((assignment) => [`${assignment.environmentId}:${assignment.port}`, assignment]),
  );
  const matched = listeners.filter((listener) => !persistentPorts.has(listener.port)).flatMap((listener) => {
    const environment = environments
      .filter((candidate) => listener.cwd === candidate.path || listener.cwd.startsWith(`${candidate.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return environment ? [{ listener, environment }] : [];
  });
  const servers = await Promise.all(matched.map(async ({ listener, environment }) => {
    const assignment = assignments.get(`${environment.id}:${listener.port}`) ?? null;
    const association = await terminalForPort(bb, environment, listener.port, assignment);
    const thread = (assignment?.threadId ? environment.threads.find((t) => t.id === assignment.threadId) : null) ?? environment.threads[0] ?? null;
    return {
      name: typeof assignment?.name === "string" ? shortServerName(assignment.name) : defaultServerName({ threadTitle: thread?.title, projectName: environment.projectName, command: listener.command }),
      projectId: environment.projectId,
      projectName: environment.projectName,
      environmentId: environment.id,
      environmentName: environment.name ?? environment.branchName ?? environment.id,
      branchName: environment.branchName,
      path: environment.path,
      port: listener.port,
      pid: listener.pid,
      processName: listener.processName,
      command: association.terminal?.status === "running" ? assignment?.command ?? listener.command : listener.command,
      hostId: environment.hostId,
      threadIds: environment.threads.map((thread) => thread.id),
      thread,
      terminal: association.terminal ? {
        id: association.terminal.id,
        title: association.terminal.title,
        status: association.terminal.status,
      } : null,
      association: association.association,
    };
  }));

  const portsByHost = new Map<string, Set<number>>();
  for (const server of servers) {
    const ports = portsByHost.get(server.hostId) ?? new Set<number>();
    ports.add(server.port);
    portsByHost.set(server.hostId, ports);
  }

  const allPorts = new Set(Array.from(portsByHost.values()).flatMap((ports) => Array.from(ports)));
  // Port management owns private Serve routes. Reading the list must never
  // create public Connect exposure as a fallback.
  const tailnetUrlByPort = await tailnetUrls(allPorts);

  return servers.map(({ hostId, ...server }) => {
    return {
      ...server,
      connectUrl: null,
      tailnetUrl: tailnetUrlByPort.get(server.port) ?? null,
      tailnetDescription: tailnetUrlByPort.has(server.port) ? server.name : null,
    };
  });
}

export default async function plugin(bb: BbPluginApi, dependencies: { threadRules?: TailnetRules } = {}) {
  bb.agents.configure(() => ({ tools: [], skills: ["dev-servers"], instructions: [
    'Always pass a short purpose name (at most 24 characters) when starting, adopting or registering a dev server, for example: bb dev-servers start --name "icon grader" --command \'pnpm dev --port {port} --host 127.0.0.1\'. Use --name for persistent servers too. Names appear first in Dev Servers.',
    'For Wrangler, include --inspector-port {port+4} inside --command. For Cloudflare Vite, use the plugin option --inspector-port \'{port+4}\' and wire BB_DEV_SERVER_INSPECTOR_PORT to cloudflare({ inspectorPort }) in vite.config as documented in the dev-servers skill.',
    'Defaults are ten-port blocks over 5910–5999. Use {port} for Fieldlabel HTTP servers: its R2 CORS allowlist accepts only 5910, 5920, … 5990. Keep inspectors inside the server\'s own block; {port+4} fits the default. Preserve saved machine settings during plugin releases.',
    'Automatic start requires {port} in --command; literal 59xx ports require an explicit --port option. The plugin owns private Tailscale Serve routes on app base ports and removes them when stopped; never create public Funnel or Connect exposure. It audits unmanaged listeners every two minutes, adopts only verified owners, and notifies the owning thread once if adoption is impossible.',
    'Detected Vite commands/scripts get --strictPort automatically; pass it explicitly inside custom Vite wrappers so collisions fail instead of moving ports. Stop managed thread servers with bb dev-servers stop (optionally --port), or bb terminal close <terminalId>. Use bb dev-servers release to clear idle leases; it never kills processes and refuses live servers.',
    'Stopped blocks expire automatically after idleReleaseMinutes (default 2). If the pool is full, start lists holders and idle times and asks the longest-idle identified owner to release; never kill another thread\'s server or choose an off-grid port to bypass the pool.',
  ].join(" ") }));
  const settings = bb.settings.define({
    portBase: {
      type: "string",
      label: "First port",
      description: "Base port of the first worktree block.",
      default: String(DEFAULT_PORT_BASE),
    },
    blockSize: {
      type: "string",
      label: "Ports per worktree",
      description: "Number of consecutive ports reserved for each worktree.",
      default: String(DEFAULT_BLOCK_SIZE),
    },
    blockCount: {
      type: "string",
      label: "Worktree blocks",
      description: "Maximum number of environments with concurrent port blocks. Idle blocks are released automatically.",
      default: String(DEFAULT_BLOCK_COUNT),
    },
    idleReleaseMinutes: {
      type: "string", label: "Stopped block grace (minutes)",
      description: "Release a stopped environment's block after this many minutes (0–1440). Explicit release bypasses the grace; live servers are never reclaimed.",
      default: "2",
    },
  });

  async function reclaimOptions(forceEnvironmentId?: string) {
    const minutes = Number((await settings.get()).idleReleaseMinutes);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw new Error("idleReleaseMinutes must be an integer from 0 to 1440");
    return { idleGraceMs: minutes * 60_000, ...(forceEnvironmentId ? { forceEnvironmentId } : {}) };
  }
  async function reclaimRecords(records: Awaited<ReturnType<typeof listenerRecords>>, config: PortConfig, forceEnvironmentId?: string) {
    return reclaimIdleBlocks(bb, new Set(records.map((l) => l.port)), config, listenerOwnership(bb, records), await reclaimOptions(forceEnvironmentId));
  }

  const startupConfig = parsePortConfig(await settings.get(), runtimeInfrastructurePorts(bb, false));
  if (!startupConfig.config) throw new Error(startupConfig.error!);
  await reclaimOptions();

  async function validateLocationAndPort(cwd: string, port: number) {
    assertPortAllowed(port, runtimeInfrastructurePorts(bb));
    const parsed = parsePortConfig(await settings.get(), runtimeInfrastructurePorts(bb));
    if (!parsed.config) throw new Error(parsed.error!);
    const config = parsed.config;
    const listeners = await listenerRecords();
    await reclaimRecords(listeners, config);
    const environments = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await bb.sdk.environments.list({ limit: 1000, offset });
      environments.push(...page);
      if (page.length < 1000) break;
    }
    for (const environment of environments) {
      if (!environment.path || environment.status === "destroyed") continue;
      const path = await realpath(environment.path).catch(() => environment.path!);
      if (environment.workspaceProvisionType === "managed-worktree" && (cwd === path || cwd.startsWith(`${path}/`))) {
        throw new Error("Persistent servers need a durable checkout outside managed worktrees. Choose its directory and update the command before promoting.");
      }
    }
    const live = new Set(environments.filter((e) => e.status !== "destroyed").map((e) => e.id));
    for (const key of await bb.storage.kv.list("block:")) {
      const block = await bb.storage.kv.get<Block>(key);
      if (block && live.has(block.environmentId) && blockContains(block, port, config)) {
        throw new Error(`Port ${port} belongs to live worktree block ${block.base}-${block.base + blockSize(block, config) - 1}. Choose a free port outside active blocks, such as 6360–6378 with the defaults.`);
      }
    }
  }
  const persistent = new PersistentSupervisor(bb, validateLocationAndPort);
  const threadPorts = new ThreadPortManager(bb, {
    rules: dependencies.threadRules,
    processInfo: async (pid) => { const [cwd, command] = await Promise.all([processCwd(pid), processCommand(pid)]); return { cwd, command }; },
    probe: async (port) => (await checkHealth({ port, health: { path: "/", status: 200, contentType: "text/html", bodyIncludes: "" } }, 1000)).healthy,
  });
  bb.background.service("persistent-servers", { async start(signal) {
    const parsed = parsePortConfig(await settings.get(), runtimeInfrastructurePorts(bb));
    if (!parsed.config) throw new Error(parsed.error!);
    await persistent.run(signal);
  } });
  bb.onDispose(() => persistent.dispose());
  bb.onDispose(() => threadPorts.dispose());
  bb.background.service("port-block-leases", { async start(signal) {
    while (!signal.aborted) {
      try {
        await persistent.exclusive(async () => {
          const parsed = parsePortConfig(await settings.get(), runtimeInfrastructurePorts(bb));
          if (!parsed.config) throw new Error(parsed.error!);
          const listeners = await listenerRecords();
          await reclaimRecords(listeners, parsed.config);
          await threadPorts.sweep({ listeners, config: parsed.config, reserved: new Set([...await persistent.reservedPorts(), ...runtimeInfrastructurePorts(bb)]), reclaim: await reclaimOptions() });
        });
      } catch (cause) {
        if (!signal.aborted) bb.log.warn(`Could not inspect port block leases: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      try { await delay(15_000, undefined, { signal }); }
      catch (cause) { if (!signal.aborted) throw cause; }
    }
  } });

  async function describeHolders(records: Awaited<ReturnType<typeof listenerRecords>>, ports: Set<number>) {
    const environments = await projectEnvironments(bb, null);
    // Commands may cd outside their environment (e.g. a viewer for a separate
    // directory). An active managed assignment is stronger evidence than cwd.
    const managed = new Map<number, Assignment>();
    for (const key of await bb.storage.kv.list("assignment:")) {
      const assignment = await bb.storage.kv.get<Assignment>(key);
      if (assignment?.terminalId && ports.has(assignment.port) && await managedPortHolder(bb, assignment.environmentId, assignment.port)) {
        managed.set(assignment.port, assignment);
      }
    }
    return Promise.all(records.filter((l) => ports.has(l.port)).slice(0, 40).map(async (listener) => {
      const cwd = await processCwd(listener.pid);
      const environment = environments.filter((e) => cwd === e.path || cwd?.startsWith(`${e.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
      const assignment = managed.get(listener.port) ?? (environment ? await bb.storage.kv.get<Assignment>(`assignment:${environment.id}:${listener.port}`) : undefined);
      const threadId = assignment?.threadId ?? environment?.threads[0]?.id;
      return `Port ${listener.port}: ${listener.processName} (PID ${listener.pid}), thread ${threadId ?? "unknown"}${threadId && !assignment ? " (inferred from environment)" : ""}${assignment ? "" : "; unmanaged — use bb dev-servers adopt --port " + listener.port + " from its thread"}`;
    }));
  }

  bb.rpc.register(rpcContract, {
    list: async ({ projectId }) => ({ servers: await listServers(bb, projectId, await persistent.reservedPorts()), scannedAt: Date.now() }),
    persistentList: async ({ logLines }) => ({ servers: await persistent.list(logLines) }),
    persistentAdd: (input) => persistent.add(input),
    persistentControl: async ({ name, action }) => { await persistent.control(name, action); return { ok: true }; },
  });

  const json = { type: "boolean", description: "Emit JSON" } as const;
  const nameOption = { type: "string", description: 'Short purpose label, at most 24 characters (e.g. "icon grader"); defaults to the thread title or project/script' } as const;
  async function resolveName(name: string | undefined, command: string | null, projectName?: string, thread?: ProjectThread, cwd?: string) {
    if (name !== undefined) return serverNameSchema.parse(name);
    let title = thread?.title || thread?.titleFallback;
    if (!title && thread) {
      try { const full = await bb.sdk.threads.get({ threadId: thread.id }); title = full.title || full.titleFallback; }
      catch { /* The project/script remains meaningful if thread lookup is unavailable. */ }
    }
    return defaultServerName({ threadTitle: title, projectName, cwd, command });
  }
  async function currentEnvironment(projectId: string, threadId: string) {
    const project = (await bb.sdk.projects.list({ include: "threads" })).find((p) => p.id === projectId);
    const environmentId = projectThreads(project).find((t) => t.id === threadId)?.environmentId;
    if (!environmentId) throw new Error("This thread has no environment.");
    return environmentId;
  }
  async function environmentAssignments(environmentId: string) {
    const rows = [];
    for (const key of await bb.storage.kv.list("assignment:")) {
      const value = await bb.storage.kv.get<Assignment>(key);
      if (value?.environmentId === environmentId) rows.push({ key, value });
    }
    return rows;
  }
  async function reconcile(forceEnvironmentId?: string) {
    const parsed = parsePortConfig(await settings.get(), runtimeInfrastructurePorts(bb));
    if (!parsed.config) throw new Error(parsed.error!);
    const listeners = await listenerRecords();
    const occupied = new Set(listeners.map((l) => l.port));
    const active = await reclaimRecords(listeners, parsed.config, forceEnvironmentId);
    return { active, occupied, listeners, config: parsed.config };
  }
  const commands = {
    list: cliCommand({
      summary: "List discovered thread dev servers", options: { json },
      async run(_input, context) {
        if (!context.projectId) return { exitCode: 2, stderr: "Run this from a BB project thread.\n" };
        return { exitCode: 0, stdout: `${JSON.stringify(await listServers(bb, context.projectId, await persistent.reservedPorts()), null, 2)}\n` };
      },
    }),
    start: cliCommand({
      summary: "Start a dev server in a thread terminal",
      options: {
        name: nameOption,
        command: { type: "string", required: true, description: "Foreground command requiring {port} for automatic allocation; {port+N} is another slot. Literal 59xx ports require --port." },
        port: { type: "integer", min: 1, max: 65535, description: "Explicit fixed port (bypasses worktree blocks)" },
        "inspector-port": { type: "string", description: "Reserve a separate slot (e.g. {port+4}) and export BB_DEV_SERVER_INSPECTOR_PORT; Cloudflare Vite config must read it" },
        json,
      },
      async run(input, context) {
        if (!context.projectId || !context.threadId) return { exitCode: 2, stderr: "Start requires a BB project thread.\n" };
        // Serialize allocation with persistent reservations and other starts.
        return persistent.exclusive(async () => {
          const commandTemplate = input.options.command;
          if (input.options.port === undefined) {
            if (/\b59\d{2}\b/.test(commandTemplate)) return { exitCode: 2, stderr: "Hard-coded 59xx ports require an explicit --port option. Use {port} for the app and {port+N} for helpers.\n" };
            if (!commandTemplate.includes("{port}")) return { exitCode: 2, stderr: "Automatic allocation requires {port} in --command. Use --port explicitly for a fixed-port command.\n" };
          }
          const inspectorTemplate = input.options["inspector-port"];
          if (inspectorTemplate !== undefined && !/^(?:\d+|\{port(?:\+\d+)?\})$/.test(inspectorTemplate)) {
            return { exitCode: 2, stderr: "--inspector-port must be a port number or a single {port+N} placeholder.\n" };
          }
          const parsedConfig = parsePortConfig(await settings.get(), runtimeInfrastructurePorts(bb));
          if (!parsedConfig.config) return { exitCode: 2, stderr: `${parsedConfig.error}\n` };
          const config = parsedConfig.config;
          if (input.options.port !== undefined) {
            const fixed = expandPorts(commandTemplate, input.options.port, config.blockSize);
            for (const candidate of [input.options.port, ...fixed.ports]) assertPortAllowed(candidate, runtimeInfrastructurePorts(bb));
            if (inspectorTemplate !== undefined) assertPortAllowed(Number(expandPorts(inspectorTemplate, input.options.port, config.blockSize).command), runtimeInfrastructurePorts(bb));
          }
          const projects = await bb.sdk.projects.list({ include: "threads" });
          const project = projects.find((row) => row.id === context.projectId);
          const thread = projectThreads(project).find((row) => row.id === context.threadId);
          if (!thread?.environmentId) return { exitCode: 2, stderr: "This thread has no environment.\n" };
          const name = await resolveName(input.options.name, commandTemplate, project?.name, thread);
          const reserved = await persistent.reservedPorts();
          const listeners = await listenerRecords();
          const occupied = new Set(listeners.map((listener) => listener.port));
          const ownership = listenerOwnership(bb, listeners);
          const reclaim = await reclaimOptions();
          const active = input.options.port === undefined ? [] : await reclaimRecords(listeners, config);
          const block = input.options.port === undefined ? await assignBlock(bb, thread.environmentId, occupied, config, reserved, ownership, reclaim) : null;
          const base = input.options.port ?? block?.base ?? null;
          if (base === null) {
            const inRange = new Set([...occupied].filter((p) => p >= config.portBase && p <= lastPort(config)));
            const holders = await describeHolders(listeners, inRange);
            const definitions = (await persistent.list(0)).filter((s) => s.port >= config.portBase && s.port <= lastPort(config));
            const pending: string[] = [];
            for (const key of await bb.storage.kv.list("assignment:")) {
              const assignment = await bb.storage.kv.get<Assignment>(key);
              const held = assignment && await bb.storage.kv.get<Block>(`block:${assignment.environmentId}`);
              if (assignment?.terminalId && held && blockContains(held, assignment.port, config) && !occupied.has(assignment.port)) pending.push(`Port ${assignment.port}: terminal ${assignment.terminalId}, thread ${assignment.threadId ?? "unknown"} (no listener yet; terminal lease retained)`);
            }
            const pressure = await threadPorts.pressure({ listeners, config, reserved, reclaim }, context.threadId!);
            return { exitCode: 1, stderr: `All ${config.blockCount} port blocks (${config.portBase}-${lastPort(config)}) are active or reserved.\n${pressure.holders.concat(holders, pending.slice(0, 40), definitions.map((s) => `Port ${s.port}: persistent ${s.name} (${s.state})`)).join("\n")}\n${pressure.offer}\n` };
          }
          const size = block?.size ?? config.blockSize;
          let cwd: string | null = null;
          try { cwd = (await bb.sdk.environments.get({ environmentId: thread.environmentId })).path; }
          catch { /* Direct Vite commands remain identifiable without a directory. */ }
          const strictCommand = await strictViteCommand(commandTemplate, cwd);
          const { command: expandedCommand, ports, overrun } = expandPorts(strictCommand, base, size);
          if (overrun !== null) {
            await reclaimRecords(listeners, config, thread.environmentId);
            return { exitCode: 2, stderr: `{port+${overrun}} is past the end of a ${size}-port block.\n` };
          }
          const requested = [...new Set(ports.length ? ports : [base])];
          for (const match of expandedCommand.matchAll(/(?:^|\s)--(?:inspector-)?port(?:=|\s+)(\d+)(?=\s|$)/g)) {
            const literal = Number(match[1]);
            if (literal < base || literal >= base + size) {
              await reclaimRecords(listeners, config, thread.environmentId);
              return { exitCode: 2, stderr: `Command port ${literal} is outside the assigned block ${base}-${base + size - 1}. Use {port} or {port+N}, or request its base with --port.\n` };
            }
            if (!requested.includes(literal)) requested.push(literal);
          }
          let inspectorPort: number | null = null;
          if (inspectorTemplate !== undefined) {
            const inspector = expandPorts(inspectorTemplate, base, size);
            inspectorPort = Number(inspector.command);
            if (inspector.overrun !== null || inspectorPort < base || inspectorPort >= base + size || !Number.isSafeInteger(inspectorPort)) {
              await reclaimRecords(listeners, config, thread.environmentId);
              return { exitCode: 2, stderr: `Inspector port must be inside this server's ${size}-port block (${base}-${base + size - 1}). Use {port+1} through {port+${size - 1}} when the block has room.\n` };
            }
            if (requested.includes(inspectorPort)) {
              await reclaimRecords(listeners, config, thread.environmentId);
              return { exitCode: 2, stderr: `Inspector port ${inspectorPort} is already used by the command. Choose a separate slot. For Wrangler, put --inspector-port {port+N} inside --command; the plugin option is for an environment-based configuration.\n` };
            }
            requested.push(inspectorPort);
          }
          // Only validated integers enter this shell prefix. Export, rather than a
          // command-local assignment, also covers scripts containing shell operators.
          const command = inspectorPort === null ? expandedCommand : `export BB_DEV_SERVER_INSPECTOR_PORT=${inspectorPort}; ${expandedCommand}`;
          for (const candidate of new Set([base, ...requested])) assertPortAllowed(candidate, runtimeInfrastructurePorts(bb));
          const foreign = active.find((held) => held.environmentId !== thread.environmentId && [base, ...requested].some((candidate) => blockContains(held, candidate, config)));
          if (foreign) return { exitCode: 1, stderr: `Port block ${foreign.base}-${foreign.base + foreign.size! - 1} is leased by environment ${foreign.environmentId}. Stop its servers and release its lease before requesting a fixed port inside it.\n` };
          const currentListeners = await listenerRecords();
          const currentOccupied = new Set(currentListeners.map((l) => l.port));
          const reusedOwnBlock = block ?? active.find((held) => held.environmentId === thread.environmentId && blockContains(held, base, config));
          const clash = [base, ...requested].find((candidate) => reserved.has(candidate))
            ?? (currentOccupied.has(base) && (!occupied.has(base) || !reusedOwnBlock) ? base : undefined)
            ?? requested.find((candidate) => currentOccupied.has(candidate));
          if (clash !== undefined) {
            await reclaimRecords(currentListeners, config, thread.environmentId);
            const detail = reserved.has(clash) ? [`Port ${clash}: reserved by a persistent server`] : await describeHolders(currentListeners, new Set([clash]));
            return { exitCode: 1, stderr: `Port ${clash} is already in use or reserved.\n${detail.join("\n")}\n` };
          }
          for (const candidate of new Set(requested)) {
            const holder = await managedPortHolder(bb, null, candidate);
            if (holder) return { exitCode: 1, stderr: `Port ${candidate}: managed terminal ${holder.terminalId} (${holder.status}), thread ${holder.threadId ?? "unknown"} has not released its startup lease.\n` };
          }
          const port = ports[0] ?? base;
          const terminal = await bb.sdk.terminals.create({
            cols: 120, rows: 32, scope: { kind: "thread", threadId: context.threadId! },
            start: { mode: "command", command }, title: `${name} · ${port}`,
          });
          for (const assignedPort of new Set(requested)) await bb.storage.kv.set(`assignment:${thread.environmentId}:${assignedPort}`, {
            name, environmentId: thread.environmentId, port: assignedPort, terminalId: terminal.id, command, threadId: context.threadId,
          } satisfies Assignment);
          return { exitCode: 0, stdout: input.options.json
            ? `${JSON.stringify({ name, command, base, ports: requested, inspectorPort, terminalId: terminal.id })}\n`
            : `Started ${name}: ${command}\nBlock: ${base}-${base + size - 1}\nPorts: ${requested.join(", ")}\n${inspectorPort === null ? "" : `Inspector: ${inspectorPort} (BB_DEV_SERVER_INSPECTOR_PORT)\n`}Terminal: ${terminal.id}\n` };
        });
      },
    }),
    stop: cliCommand({
      summary: "Close this thread's managed server terminals; adopted processes must be stopped separately",
      options: { port: { type: "integer", min: 1, max: 65535, description: "Stop only the managed server using this port" }, json },
      async run(input, context) {
        if (!context.projectId || !context.threadId) return { exitCode: 2, stderr: "Stop requires the server's BB project thread.\n" };
        return persistent.exclusive(async () => {
          const environmentId = await currentEnvironment(context.projectId!, context.threadId!);
          await reconcile();
          const rows = (await environmentAssignments(environmentId)).filter(({ value }) => value.threadId === context.threadId);
          const selected = rows.filter(({ value }) => input.options.port === undefined || value.port === input.options.port);
          const ids = new Set(selected.flatMap(({ value }) => value.terminalId ? [value.terminalId] : []));
          const { sessions } = await bb.sdk.terminals.list({ scope: { kind: "thread", threadId: context.threadId! } });
          for (const id of ids) {
            if (sessions.some((s) => s.id === id && s.status !== "exited")) await bb.sdk.terminals.close({ terminalId: id, mode: "force" });
            for (const { key, value } of rows) if (value.terminalId === id) await bb.storage.kv.delete(key);
          }
          await threadPorts.removeForPorts(rows.filter(({ value }) => value.terminalId && ids.has(value.terminalId)).map(({ value }) => value.port), context.threadId!);
          const { occupied } = await reconcile();
          const manualPorts = selected.filter(({ value }) => !value.terminalId && occupied.has(value.port)).map(({ value }) => value.port);
          return { exitCode: manualPorts.length ? 1 : 0,
            stdout: `${JSON.stringify({ stoppedTerminals: [...ids], manualPorts })}\n`,
            ...(manualPorts.length ? { stderr: `Adopted processes on ${manualPorts.join(", ")} have no managed terminal. Stop those processes, then run bb dev-servers release.\n` } : {}),
          };
        });
      },
    }),
    release: cliCommand({
      summary: "Release this environment's idle port block and stale assignments; active servers are refused",
      options: { json },
      async run(_input, context) {
        if (!context.projectId || !context.threadId) return { exitCode: 2, stderr: "Release requires a BB project thread.\n" };
        return persistent.exclusive(async () => {
          const environmentId = await currentEnvironment(context.projectId!, context.threadId!);
          const before = await bb.storage.kv.get<Block>(`block:${environmentId}`);
          await reconcile(environmentId);
          const rows = await environmentAssignments(environmentId);
          const block = await bb.storage.kv.get<Block>(`block:${environmentId}`);
          if (rows.length || block) return { exitCode: 1, stderr: `Environment ${environmentId} still has live or unverified servers. Run bb dev-servers stop, or close their terminal with bb terminal close <terminalId>, then release.\n` };
          return { exitCode: 0, stdout: `${JSON.stringify({ environmentId, releasedBase: before?.base ?? null })}\n` };
        });
      },
    }),
    adopt: cliCommand({
      summary: "Associate a manually started listener with this thread and lease its port block",
      options: { name: nameOption, port: { type: "integer", required: true, min: 1, max: 65535, description: "Existing listening port in the configured thread range" }, json },
      async run(input, context) {
        if (!context.projectId || !context.threadId) return { exitCode: 2, stderr: "Adopt requires the server's BB project thread.\n" };
        return persistent.exclusive(async () => {
          if (input.options.name !== undefined) serverNameSchema.parse(input.options.name);
          const parsed = parsePortConfig(await settings.get(), runtimeInfrastructurePorts(bb));
          if (!parsed.config) return { exitCode: 2, stderr: `${parsed.error}\n` };
          const config = parsed.config;
          const projects = await bb.sdk.projects.list({ include: "threads" });
          const project = projects.find((p) => p.id === context.projectId);
          const thread = projectThreads(project).find((t) => t.id === context.threadId);
          if (!thread?.environmentId) return { exitCode: 2, stderr: "This thread has no environment.\n" };
          const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
          if (!environment.path) return { exitCode: 2, stderr: "This environment has no directory.\n" };
          const path = await realpath(environment.path);
          const listeners = await listenerRecords();
          const port = input.options.port;
          assertPortAllowed(port, runtimeInfrastructurePorts(bb));
          const prior = await bb.storage.kv.get<Block>(`block:${environment.id}`);
          const base = prior && blockContains(prior, port, config) ? prior.base : blockBase(config, Math.floor((port - config.portBase) / config.blockSize));
          const size = prior && blockContains(prior, port, config) ? blockSize(prior, config) : config.blockSize;
          const inBlock = listeners.filter((l) => l.port >= base && l.port < base + size);
          if (!inBlock.some((l) => l.port === port)) return { exitCode: 1, stderr: `Nothing is listening on port ${port}.\n` };
          for (const listener of inBlock) {
            const cwd = await processCwd(listener.pid);
            const resolved = cwd ? await realpath(cwd).catch(() => cwd) : null;
            if (resolved !== path && !resolved?.startsWith(`${path}/`)) return { exitCode: 1, stderr: `Cannot adopt a block containing another environment's process.\n${(await describeHolders(listeners, new Set([listener.port]))).join("\n")}\n` };
          }
          const block = await adoptBlock(bb, environment.id, port, new Set(listeners.map((l) => l.port)), config, await persistent.reservedPorts(), listenerOwnership(bb, listeners), await reclaimOptions());
          const listener = inBlock.find((l) => l.port === port)!;
          const key = `assignment:${environment.id}:${port}`;
          const assignment = await bb.storage.kv.get<Assignment>(key);
          const command = await processCommand(listener.pid) ?? listener.processName;
          const name = input.options.name === undefined && assignment?.name ? shortServerName(assignment.name) : await resolveName(input.options.name, command, project?.name, thread);
          await bb.storage.kv.set(key, assignment?.terminalId ? { ...assignment, name } : {
            name,
            environmentId: environment.id, port, terminalId: null, pid: listener.pid,
            command, threadId: context.threadId,
          } satisfies Assignment);
          const result = { name, port, pid: listener.pid, base: block.base, size: block.size, threadId: context.threadId };
          return { exitCode: 0, stdout: input.options.json ? `${JSON.stringify(result)}\n`
            : `Adopted ${listener.processName} (PID ${listener.pid}) on ${port} for thread ${context.threadId}.\nThe existing process keeps its lifetime; adoption does not create a terminal or restart it.\n` };
        });
      },
    }),
    "persist add": cliCommand({
      summary: "Register a machine-local persistent foreground server (no thread required)",
      options: {
        name: nameOption,
        cwd: { type: "string", aliases: ["server-cwd", "directory"], required: true, description: "Absolute directory on the bb SERVER machine, outside managed worktrees" },
        command: { type: "string", required: true, description: "Foreground shell command using the fixed port" },
        port: { type: "integer", required: true, min: 5910, max: 65535, description: "Fixed port outside active worktree blocks and infrastructure denylist; prefer 6360–6378" },
        stopped: { type: "boolean", description: "Register stopped; Start enables automatic startup" },
        tailnet: { type: "boolean", description: "Own a private Tailscale Serve HTTPS rule on the same port" },
        "adopt-tailnet-rule": { type: "boolean", description: "Take ownership of an existing identical private proxy, including its cleanup" },
        "health-path": { type: "string", default: "/", description: "Loopback HTTP health path" },
        "health-status": { type: "integer", min: 100, max: 599, default: 200, description: "Expected HTTP status" },
        "health-content-type": { type: "string", default: "text/html", description: "Expected Content-Type substring" },
        "health-body": { type: "string", default: "", description: "Expected text in the first 64 KiB of the response" },
        json,
      },
      constraints: [{ kind: "requires", option: "adopt-tailnet-rule", needs: ["tailnet"] }],
      async run({ options: o }, context) {
        const project = o.name === undefined && context.projectId ? (await bb.sdk.projects.list({ include: "threads" })).find((p) => p.id === context.projectId) : undefined;
        const thread = projectThreads(project).find((t) => t.id === context.threadId);
        const name = await resolveName(o.name, o.command, project?.name, thread, o.cwd);
        const server = await persistent.add(persistentInputSchema.parse({
          name, cwd: o.cwd, command: o.command, port: o.port, enabled: !o.stopped,
          tailnet: o.tailnet, adoptTailnetRule: o["adopt-tailnet-rule"],
          health: { path: o["health-path"], status: o["health-status"], contentType: o["health-content-type"], bodyIncludes: o["health-body"] },
        }));
        return { exitCode: 0, stdout: `${JSON.stringify(server, null, 2)}\n` };
      },
    }),
    "persist list": cliCommand({
      summary: "List persistent definitions, status, health, uptime and last exit",
      options: { json },
      async run() { return { exitCode: 0, stdout: `${JSON.stringify(await persistent.list(), null, 2)}\n` }; },
    }),
    "persist logs": cliCommand({
      summary: "Read bounded recent stdout, stderr and supervisor logs",
      positionals: [{ name: "name", description: "Persistent server name", required: true }],
      options: { lines: { type: "integer", min: 1, max: 80, default: 40, description: "Recent lines (up to 80)" }, json },
      async run({ positionals, options }) {
        const server = (await persistent.list(options.lines)).find((s) => s.name === positionals.name);
        if (!server) throw new Error(`No persistent server named ${positionals.name}`);
        return { exitCode: 0, stdout: options.json ? `${JSON.stringify(server.logs)}\n`
          : server.logs.map((l) => `${new Date(l.at).toISOString()} [${l.stream}] ${l.line}\n`).join("") };
      },
    }),
  };
  const controls = Object.fromEntries((["start", "stop", "restart", "remove"] as const).map((action) => [
    `persist ${action}`, cliCommand({
      summary: `${action[0].toUpperCase()}${action.slice(1)} a persistent server${action === "remove" ? " and its owned Serve rule" : ""}`,
      positionals: [{ name: "name", description: "Persistent server name", required: true }], options: { json },
      async run({ positionals }) { await persistent.control(positionals.name, action); return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, name: positionals.name, action })}\n` }; },
    }),
  ]));
  const cli = defineCli({ name: "dev-servers", summary: "Manage thread dev servers and persistent machine servers", commands: { ...commands, ...controls } });
  bb.cli.register({ ...cli, run: (argv, context) => cli.run(argv.length ? argv : ["list"], context) });
}
