import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const execFile = promisify(execFileCallback);

const terminalSchema = z.object({ id: z.string(), title: z.string(), status: z.string() });
const serverSchema = z.object({
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
  thread: z.object({ id: z.string(), title: z.string() }).nullable(),
  terminal: terminalSchema.nullable(),
  association: z.enum(["managed", "inferred", "external"]),
});

export const rpcContract = defineRpcContract({
  list: {
    input: z.object({ projectId: z.string().nullable() }).strict(),
    output: z.object({ servers: z.array(serverSchema), scannedAt: z.number() }),
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
type Block = {
  environmentId: string;
  index: number;
  base: number;
};
type PortConfig = {
  portBase: number;
  blockSize: number;
  blockCount: number;
};
type Assignment = {
  environmentId: string;
  port: number;
  terminalId: string;
  command: string;
  threadId?: string;
};
type ProjectThread = { id: string; environmentId: string | null };

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

async function processCwd(pid: number) {
  try {
    const { stdout } = await execFile("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    return stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? null;
  } catch {
    return null;
  }
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
const DEFAULT_BLOCK_SIZE = 10;
const DEFAULT_BLOCK_COUNT = 9;
const blockBase = (config: PortConfig, index: number) => config.portBase + index * config.blockSize;
const lastPort = (config: PortConfig) => blockBase(config, config.blockCount - 1) + config.blockSize - 1;
const PORT_PLACEHOLDER = /\{port(?:\+(\d+))?\}/g;

function parsePortConfig(values: { portBase: string; blockSize: string; blockCount: string }) {
  const config: PortConfig = {
    portBase: Number(values.portBase),
    blockSize: Number(values.blockSize),
    blockCount: Number(values.blockCount),
  };
  if (!Number.isInteger(config.portBase) || config.portBase < 1024 || config.portBase > 65535) {
    return { config: null, error: "First port must be an integer from 1024 to 65535." };
  }
  if (!Number.isInteger(config.blockSize) || config.blockSize < 1 || config.blockSize > 100) {
    return { config: null, error: "Ports per worktree must be an integer from 1 to 100." };
  }
  if (!Number.isInteger(config.blockCount) || config.blockCount < 1 || config.blockCount > 100) {
    return { config: null, error: "Worktree count must be an integer from 1 to 100." };
  }
  if (lastPort(config) > 65535) {
    return { config: null, error: "The configured port blocks extend past port 65535." };
  }
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

// A block is held for the environment's lifetime, not just while a server runs, so that a
// worktree's ports never move under it. That means reclaiming blocks whose worktree is gone —
// otherwise churning through worktrees exhausts the range with nothing running.
async function assignBlock(bb: BbPluginApi, environmentId: string, occupied: Set<number>, config: PortConfig) {
  const prior = await bb.storage.kv.get<Block>(`block:${environmentId}`);
  if (prior && prior.index < config.blockCount && prior.base === blockBase(config, prior.index)) return prior;
  const live = new Set((await projectEnvironments(bb, null)).map((environment) => environment.id));
  const held = new Set<number>();
  for (const key of await bb.storage.kv.list("block:")) {
    const block = await bb.storage.kv.get<Block>(key);
    if (!block) continue;
    const matchesConfig = block.index < config.blockCount && block.base === blockBase(config, block.index);
    if (live.has(block.environmentId) && matchesConfig) held.add(block.index);
    else await bb.storage.kv.delete(key);
  }
  // A server started outside the plugin holds no block record, so a block is also taken if
  // anything is already listening inside it. Without this the first allocation after any manual
  // `pnpm dev --port` hands out a block that is already half occupied and fails on the clash.
  for (let index = 0; index < config.blockCount; index += 1) {
    const base = blockBase(config, index);
    const inUse = Array.from({ length: config.blockSize }, (_, slot) => base + slot).some((port) => occupied.has(port));
    if (inUse) held.add(index);
  }
  const index = Array.from({ length: config.blockCount }, (_, candidate) => candidate)
    .find((candidate) => !held.has(candidate));
  if (index === undefined) return null;
  const block: Block = { environmentId, index, base: blockBase(config, index) };
  await bb.storage.kv.set(`block:${environmentId}`, block);
  return block;
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

async function discoverListeners() {
  const { stdout } = await execFile("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]);
  const candidates = parseListenerRecords(stdout).filter(({ port }) => port >= 1024 && port !== 38886 && port !== 38887);
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
  const { sessions } = await bb.sdk.terminals.list({ scope: { kind: "environment", environmentId: environment.id } });
  if (assignment) {
    const exact = sessions.find((terminal) => terminal.id === assignment.terminalId);
    if (exact) return { terminal: exact, association: "managed" as const };
  }
  for (const terminal of sessions.filter((row) => row.status === "running")) {
    const output = await bb.sdk.terminals.output({ terminalId: terminal.id, tailBytes: 24_000 });
    const text = output.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8")).join("");
    if (text.includes(`:${port}`) || text.includes(`--port ${port}`) || text.includes(`--port=${port}`)) {
      return { terminal, association: "inferred" as const };
    }
  }
  return { terminal: null, association: "external" as const };
}

async function listServers(bb: BbPluginApi, projectId: string | null) {
  const [environments, listeners, assignmentRows] = await Promise.all([
    projectEnvironments(bb, projectId),
    discoverListeners(),
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
  const matched = listeners.flatMap((listener) => {
    const environment = environments
      .filter((candidate) => listener.cwd === candidate.path || listener.cwd.startsWith(`${candidate.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return environment ? [{ listener, environment }] : [];
  });
  const servers = await Promise.all(matched.map(async ({ listener, environment }) => {
    const assignment = assignments.get(`${environment.id}:${listener.port}`) ?? null;
    const association = await terminalForPort(bb, environment, listener.port, assignment);
    return {
      projectId: environment.projectId,
      projectName: environment.projectName,
      environmentId: environment.id,
      environmentName: environment.name ?? environment.branchName ?? environment.id,
      branchName: environment.branchName,
      path: environment.path,
      port: listener.port,
      pid: listener.pid,
      processName: listener.processName,
      command: listener.command,
      hostId: environment.hostId,
      thread: (assignment?.threadId
        ? environment.threads.find((thread) => thread.id === assignment.threadId)
        : null) ?? environment.threads[0] ?? null,
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

  const connectUrlByServer = new Map<string, string>();
  const allPorts = new Set(Array.from(portsByHost.values()).flatMap((ports) => Array.from(ports)));
  const tailnetUrlByPortPromise = tailnetUrls(allPorts);
  await Promise.all(Array.from(portsByHost, async ([hostId, ports]) => {
    try {
      const tunnel = await bb.hosts.ensureSharedPortTunnel(hostId);
      bb.hosts.declareSharedPorts(hostId, Array.from(ports));
      for (const port of ports) {
        connectUrlByServer.set(`${hostId}:${port}`, `https://${tunnel.label}--${port}.${tunnel.baseDomain}`);
      }
    } catch (cause) {
      // Discovery currently runs on the BB server itself. Older server-host Connect setups do not
      // have a machine credential, so use the core Connect command as a compatibility path.
      await Promise.all(Array.from(ports, async (port) => {
        try {
          const { stdout } = await execFile(process.env.BB_CLI ?? "bb", ["connect", "expose", String(port)]);
          const url = stdout.trim();
          if (new URL(url).protocol === "https:") connectUrlByServer.set(`${hostId}:${port}`, url);
        } catch (fallbackCause) {
          bb.log.warn(`Could not expose port ${port} on ${hostId}: ${fallbackCause instanceof Error ? fallbackCause.message : String(fallbackCause)} (native sharing: ${cause instanceof Error ? cause.message : String(cause)})`);
        }
      }));
    }
  }));
  const tailnetUrlByPort = await tailnetUrlByPortPromise;

  return servers.map(({ hostId, ...server }) => {
    return {
      ...server,
      connectUrl: connectUrlByServer.get(`${hostId}:${server.port}`) ?? null,
      tailnetUrl: tailnetUrlByPort.get(server.port) ?? null,
    };
  });
}

function option(argv: string[], name: string) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export default async function plugin(bb: BbPluginApi) {
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
      description: "Maximum number of worktrees that can hold a port block.",
      default: String(DEFAULT_BLOCK_COUNT),
    },
  });

  bb.rpc.register(rpcContract, {
    list: async ({ projectId }) => ({ servers: await listServers(bb, projectId), scannedAt: Date.now() }),
  });

  bb.cli.register({
    name: "dev-servers",
    summary: "Discover and start worktree dev servers",
    commands: [
      { name: "start", summary: "Start a dev server in a BB terminal", usage: "bb dev-servers start --command 'pnpm dev --port {port}' [--port 3000]" },
      { name: "list", summary: "List discovered project dev servers", usage: "bb dev-servers list" },
    ],
    async run(argv, context) {
      const subcommand = argv[0] ?? "list";
      if (!context.projectId) return { exitCode: 2, stderr: "Run this from a BB project thread.\n" };
      if (subcommand === "list") {
        return { exitCode: 0, stdout: `${JSON.stringify(await listServers(bb, context.projectId), null, 2)}\n` };
      }
      if (subcommand !== "start") return { exitCode: 2, stderr: `Unknown command: ${subcommand}\n` };
      if (!context.threadId) return { exitCode: 2, stderr: "Start requires a BB thread.\n" };
      const commandTemplate = option(argv, "--command");
      if (!commandTemplate) return { exitCode: 2, stderr: "Missing --command.\n" };
      const parsedConfig = parsePortConfig(await settings.get());
      if (!parsedConfig.config) return { exitCode: 2, stderr: `${parsedConfig.error}\n` };
      const config = parsedConfig.config;

      const projects = await bb.sdk.projects.list({ include: "threads" });
      const project = projects.find((row) => row.id === context.projectId);
      const thread = projectThreads(project).find((row) => row.id === context.threadId);
      if (!thread?.environmentId) return { exitCode: 2, stderr: "This thread has no environment.\n" };

      const occupied = new Set((await discoverListeners()).map((listener) => listener.port));
      const requestedText = option(argv, "--port");
      const requested = requestedText ? Number(requestedText) : Number.NaN;
      // An explicit --port is the escape hatch out of the blocks, so it is treated as its own
      // base — offsets still resolve relative to it, but nothing is reserved or remembered.
      const base = Number.isInteger(requested) && requested > 0
        ? requested
        : (await assignBlock(bb, thread.environmentId, occupied, config))?.base ?? null;
      if (base === null) {
        return {
          exitCode: 1,
          stderr: `All ${config.blockCount} port blocks (${config.portBase}-${lastPort(config)}) belong to live worktrees.`
            + ` Delete a worktree to release its block or widen the plugin's port range.\n`,
        };
      }
      const { command, ports, overrun } = expandPorts(commandTemplate, base, config.blockSize);
      if (overrun !== null) {
        return { exitCode: 2, stderr: `{port+${overrun}} is past the end of a ${config.blockSize}-port block.\n` };
      }
      const clash = ports.find((candidate) => occupied.has(candidate));
      if (clash !== undefined) return { exitCode: 1, stderr: `Port ${clash} is already in use.\n` };
      const port = ports[0] ?? base;
      const terminal = await bb.sdk.terminals.create({
        cols: 120,
        rows: 32,
        scope: { kind: "thread", threadId: context.threadId },
        start: { mode: "command", command },
        title: `Dev server · ${port}`,
      });
      await bb.storage.kv.set(`assignment:${thread.environmentId}:${port}`, {
        environmentId: thread.environmentId,
        port,
        terminalId: terminal.id,
        command,
        threadId: context.threadId,
      } satisfies Assignment);
      return {
        exitCode: 0,
        stdout: `Started ${command}\nBlock: ${base}-${base + config.blockSize - 1}\nPorts: ${ports.join(", ")}\n`
          + `Terminal: ${terminal.id}\n`,
      };
    },
  });
}
