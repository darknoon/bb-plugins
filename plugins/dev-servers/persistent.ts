import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createServer } from "node:net";
import { Agent, request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { TailnetRules } from "./tailnet";
import { assertPortAllowed, portPolicyError, runtimeInfrastructurePorts } from "./port-policy";

const execFile = promisify(execFileCallback);

export const healthConfigSchema = z.object({
  path: z.string().max(1024).refine((s) => s.startsWith("/") && !s.startsWith("//"), "Use a local HTTP path").default("/"),
  status: z.number().int().min(100).max(599).default(200),
  contentType: z.string().min(1).max(128).default("text/html"),
  bodyIncludes: z.string().max(1024).default(""),
}).strict();
export const persistentInputSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/, "Use 1–64 letters, numbers, dots, underscores or hyphens"),
  cwd: z.string().min(1).max(4096),
  command: z.string().trim().min(1).max(4096),
  port: z.number().int().min(5910).max(65535).refine((port) => portPolicyError(port) === null, { message: "Port is reserved for infrastructure" }),
  enabled: z.boolean().default(true),
  health: healthConfigSchema.prefault({}),
  tailnet: z.boolean().default(false),
  adoptTailnetRule: z.boolean().default(false),
}).strict();
const exitSchema = z.object({ at: z.number(), code: z.number().nullable(), signal: z.string().nullable(), reason: z.string() });
const logSchema = z.object({ at: z.number(), stream: z.enum(["stdout", "stderr", "supervisor"]), line: z.string() });
export const persistentServerSchema = persistentInputSchema.extend({
  // Legacy forbidden definitions remain observable and removable after upgrade.
  port: z.number().int().min(1).max(65535),
  state: z.enum(["stopped", "starting", "running", "crashed", "restarting"]),
  pid: z.number().nullable(),
  startedAt: z.number().nullable(),
  uptimeMs: z.number(),
  restartAt: z.number().nullable(),
  failures: z.number(),
  lastExit: exitSchema.nullable(),
  healthResult: z.object({ healthy: z.boolean(), checkedAt: z.number(), message: z.string() }).nullable(),
  tailnetUrl: z.string().nullable(),
  logs: z.array(logSchema),
});
export type PersistentInput = z.infer<typeof persistentInputSchema>;
export type PersistentServer = z.infer<typeof persistentServerSchema>;
const definitionSchema = persistentInputSchema.extend({
  port: z.number().int().min(1).max(65535),
  rule: z.object({ dnsName: z.string(), port: z.number(), proxy: z.string() }).nullable().default(null),
});
type Definition = z.infer<typeof definitionSchema>;
type Exit = z.infer<typeof exitSchema>;
type Log = z.infer<typeof logSchema>;
type Runtime = {
  definition: Definition;
  state: PersistentServer["state"];
  child: ChildProcess | null;
  done: Promise<void>;
  exit: Exit | null;
  lastExit: Exit | null;
  startedAt: number | null;
  restartAt: number | null;
  failures: number;
  healthySince: number | null;
  unhealthyCount: number;
  lastProbe: number;
  lastRuleCheck: number;
  healthResult: PersistentServer["healthResult"];
  logs: Log[];
  dirty: boolean;
};

// A pipe lease makes children die even if bb is SIGKILLed. The watchdog is a separate
// Node process; it owns a process group for the shell and its descendants and escalates
// to SIGKILL. No thread terminal, launchd job, or detached daemon is required.
const WATCHDOG = String.raw`
const { spawn } = require("node:child_process");
const child = spawn("/bin/sh", ["-c", process.argv[1]], {
  cwd: process.argv[2], detached: true, stdio: ["ignore", "inherit", "inherit"]
});
let stopping = false;
function kill(signal) { if (child.pid) { try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== "ESRCH") throw e; } } }
function stop() {
  if (stopping) return;
  stopping = true;
  kill("SIGTERM");
  setTimeout(() => { kill("SIGKILL"); process.exit(0); }, 3000);
}
process.stdin.resume();
process.stdin.on("end", stop);
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("error", (error) => { console.error(error.message); process.exit(127); });
child.on("exit", (code, signal) => {
  if (process.connected) process.send({ code, signal });
  kill("SIGTERM");
  setTimeout(() => { kill("SIGKILL"); process.exit(code ?? 1); }, 100);
});
`;

export function restartDelay(failures: number) {
  return Math.min(60_000, 1000 * 2 ** Math.min(Math.max(failures - 1, 0), 6));
}

export async function portAvailable(port: number) {
  if (portPolicyError(port)) return false;
  try {
    // A loopback bind alone misses a listener on ::1 or another interface.
    // Allocation cares about occupancy, independently of the protocol served.
    const { stdout } = await execFile("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"]);
    if (stdout.trim()) return false;
  } catch (cause) {
    const error = cause as { code?: number; stdout?: string };
    if (error.code !== 1 || error.stdout !== "") return false;
  }
  return new Promise<boolean>((resolve) => {
    const socket = createServer();
    socket.once("error", () => resolve(false));
    socket.listen(port, "127.0.0.1", () => socket.close(() => resolve(true)));
  });
}

export async function checkHealth(definition: Pick<PersistentInput, "port" | "health">, timeoutMs = 3000) {
  const { health, port } = definition;
  const checkedAt = Date.now();
  const base = new URL(`http://127.0.0.1:${port}`);
  const url = new URL(health.path, base);
  if (url.origin !== base.origin) return { healthy: false, checkedAt, message: "Health path must stay on loopback" };
  // Each probe owns and closes its connection. A shared fetch pool would leave
  // idle health sockets for the server to close on shutdown, delaying applications
  // whose fixed-port preflight does not permit address reuse (including Harbor).
  return new Promise<NonNullable<PersistentServer["healthResult"]>>((resolve) => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    let complete = false;
    const finish = (healthy: boolean, message: string) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      agent.destroy();
      req.destroy();
      resolve({ healthy, checkedAt, message: message.slice(0, 512) });
    };
    const req = request(url, { agent }, (response) => {
      if (response.statusCode !== health.status) { finish(false, `HTTP ${response.statusCode}; expected ${health.status}`); return; }
      const contentType = response.headers["content-type"] ?? "";
      if (!contentType.includes(health.contentType)) { finish(false, `Content-Type ${contentType || "missing"}; expected ${health.contentType}`); return; }
      const success = () => finish(true, `HTTP ${health.status}; expected response received`);
      if (!health.bodyIncludes) { success(); return; }
      let body = "";
      let bytes = 0;
      const decoder = new TextDecoder();
      response.on("data", (chunk: Buffer) => {
        if (complete) return;
        const bounded = chunk.subarray(0, 65_536 - bytes);
        bytes += bounded.byteLength;
        body += decoder.decode(bounded, { stream: true });
        if (body.includes(health.bodyIncludes)) success();
        else if (bytes >= 65_536) finish(false, "Expected response text missing from first 64 KiB");
      });
      response.on("end", () => {
        body += decoder.decode();
        if (body.includes(health.bodyIncludes)) success();
        else finish(false, "Expected response text missing from first 64 KiB");
      });
      response.on("error", (error) => finish(false, error.message));
    });
    const timer = setTimeout(() => finish(false, "HTTP health request timed out"), timeoutMs);
    req.on("error", (error) => finish(false, error.message));
    req.end();
  });
}

export class PersistentSupervisor {
  private runtimes = new Map<string, Runtime>();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private active = false;
  private disposal: Promise<void> | null = null;
  private ready: Promise<void> | null = null;
  constructor(
    private readonly bb: BbPluginApi,
    private readonly validateLocationAndPort: (cwd: string, port: number) => Promise<void>,
    private readonly rules = new TailnetRules(),
  ) {}
  // A reload candidate must not read runtime history or touch leases while the old
  // generation still owns them. Initialize after activation, on service/handler use.
  private initialize() { return this.ready ??= this.load(); }

  private async load() {
    for (const key of await this.bb.storage.kv.list("persistent:")) {
      const definition = definitionSchema.parse(await this.bb.storage.kv.get(key));
      const history = z.object({ lastExit: exitSchema.nullable(), logs: z.array(logSchema), failures: z.number().int().nonnegative() })
        .safeParse(await this.bb.storage.kv.get(`persistent-history:${definition.name}`));
      const runtime: Runtime = {
        definition, state: "stopped", child: null, done: Promise.resolve(), exit: null,
        lastExit: history.success ? history.data.lastExit : null,
        logs: history.success ? history.data.logs.slice(-80) : [],
        failures: history.success ? history.data.failures : 0,
        startedAt: null, restartAt: null, healthySince: null, unhealthyCount: 0,
        lastProbe: 0, lastRuleCheck: 0, healthResult: null, dirty: false,
      };
      this.runtimes.set(definition.name, runtime);
      const error = portPolicyError(definition.port, runtimeInfrastructurePorts(this.bb));
      if (error) {
        definition.enabled = false;
        runtime.state = "crashed";
        runtime.lastExit = { at: Date.now(), code: null, signal: null, reason: error };
        this.log(runtime, "supervisor", `Disabled: ${error}`);
        await this.save(runtime);
        // Cleanup must still accept an old forbidden port, otherwise its orphaned
        // private Serve listener would recreate the Screen Sharing failure.
        try { await this.removeRule(runtime); }
        catch (cause) { this.log(runtime, "supervisor", `Serve cleanup: ${String(cause)}`); }
      }
    }
  }

  // Controls, reservations, and background reconciliation share a queue. Stop/removal
  // cannot race a delayed restart or a concurrent add/start on the same port.
  exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      await this.initialize();
      if (this.disposed) throw new Error("Persistent supervisor is stopping");
      return action();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  async reservedPorts() { await this.initialize(); return new Set([...this.runtimes.values()].map((r) => r.definition.port)); }
  async list(logLines = 10): Promise<PersistentServer[]> {
    await this.initialize();
    return [...this.runtimes.values()].sort((a, b) => a.definition.name.localeCompare(b.definition.name)).map((r) => {
      const { rule, ...definition } = r.definition;
      return { ...definition, state: r.state, pid: r.child?.pid ?? null, startedAt: r.startedAt,
        uptimeMs: r.child && r.startedAt ? Date.now() - r.startedAt : 0,
        restartAt: r.restartAt, failures: r.failures, lastExit: r.lastExit, healthResult: r.healthResult,
        tailnetUrl: rule && r.state === "running" ? `https://${rule.dnsName}:${rule.port}/` : null,
        logs: logLines ? r.logs.slice(-logLines) : [],
      };
    });
  }
  private get(name: string) {
    const runtime = this.runtimes.get(name);
    if (!runtime) throw new Error(`No persistent server named ${name}`);
    return runtime;
  }
  private log(r: Runtime, stream: Log["stream"], line: string) {
    r.logs.push({ at: Date.now(), stream, line: line.slice(0, 1024) });
    r.logs = r.logs.slice(-80);
    r.dirty = true;
  }
  private changed() { this.bb.realtime.publish("persistent-changed", {}); }
  private async save(r: Runtime) {
    await this.bb.storage.kv.set(`persistent:${r.definition.name}`, r.definition);
  }
  private async flush(r: Runtime) {
    if (!r.dirty) return;
    await this.bb.storage.kv.set(`persistent-history:${r.definition.name}`, { lastExit: r.lastExit, logs: r.logs, failures: r.failures });
    r.dirty = false;
  }

  async add(input: PersistentInput) {
    return this.exclusive(async () => {
      const definition = definitionSchema.parse(persistentInputSchema.parse(input));
      assertPortAllowed(definition.port, runtimeInfrastructurePorts(this.bb));
      definition.command = definition.command.replaceAll("{port}", String(definition.port));
      if (this.runtimes.has(definition.name)) throw new Error(`Persistent server ${definition.name} already exists`);
      if (this.runtimes.size >= 32) throw new Error("At most 32 persistent servers are supported");
      if ([...this.runtimes.values()].some((r) => r.definition.port === definition.port)) throw new Error(`Port ${definition.port} is reserved by a persistent server`);
      if (!isAbsolute(definition.cwd)) throw new Error("Working directory must be an absolute path on the bb server machine");
      definition.cwd = await realpath(definition.cwd);
      if (!(await stat(definition.cwd)).isDirectory()) throw new Error("Working directory must be a directory");
      await this.validateLocationAndPort(definition.cwd, definition.port);
      if (definition.adoptTailnetRule && !definition.tailnet) throw new Error("Adopting a Serve rule requires --tailnet");
      // Validate exposure now, but claim/create it only once a healthy process is running.
      if (definition.tailnet) await this.rules.inspect(definition.port, definition.adoptTailnetRule);
      const r: Runtime = { definition, state: "stopped", child: null, done: Promise.resolve(), exit: null,
        lastExit: null, logs: [], failures: 0, startedAt: null, restartAt: null, healthySince: null,
        unhealthyCount: 0, lastProbe: 0, lastRuleCheck: 0, healthResult: null, dirty: false };
      await this.save(r);
      this.runtimes.set(definition.name, r);
      if (this.active && definition.enabled) await this.launch(r);
      this.changed();
      return (await this.list()).find((s) => s.name === definition.name)!;
    });
  }

  async control(name: string, action: "start" | "stop" | "restart" | "remove") {
    return this.exclusive(async () => {
      const r = this.get(name);
      if (action === "start" || action === "restart") assertPortAllowed(r.definition.port, runtimeInfrastructurePorts(this.bb));
      if (action === "start" && r.definition.enabled && r.child) return;
      r.definition.enabled = action === "start" || action === "restart";
      await this.save(r); // Stop intent survives bb restart, including cleanup failures.
      await this.halt(r, action);
      await this.removeRule(r);
      r.restartAt = null;
      r.state = "stopped";
      if (action === "remove") {
        await this.bb.storage.kv.delete(`persistent:${name}`);
        await this.bb.storage.kv.delete(`persistent-history:${name}`);
        this.runtimes.delete(name);
      } else if (r.definition.enabled && this.active) {
        r.failures = 0;
        await this.launch(r);
      }
      this.changed();
    });
  }

  private async removeRule(r: Runtime) {
    if (!r.definition.rule) return;
    await this.rules.remove(r.definition.rule);
    r.definition.rule = null;
    await this.save(r);
  }
  private async launch(r: Runtime) {
    try {
      assertPortAllowed(r.definition.port, runtimeInfrastructurePorts(this.bb));
      await this.validateLocationAndPort(r.definition.cwd, r.definition.port);
      if (!(await portAvailable(r.definition.port))) throw new Error(`Port ${r.definition.port} is in use; refusing to supervise an unrelated process`);
      const child = spawn(process.execPath, ["-e", WATCHDOG, r.definition.command, r.definition.cwd], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
      r.child = child;
      r.state = "starting";
      r.startedAt = Date.now();
      r.restartAt = null;
      r.exit = null;
      r.healthySince = null;
      r.unhealthyCount = 0;
      r.lastProbe = 0;
      r.lastRuleCheck = 0;
      r.healthResult = null;
      let code: number | null = null;
      let signal: string | null = null;
      child.on("message", (message) => {
        if (message && typeof message === "object" && "code" in message && "signal" in message) {
          code = typeof message.code === "number" ? message.code : null;
          signal = typeof message.signal === "string" ? message.signal : null;
        }
      });
      for (const stream of ["stdout", "stderr"] as const) {
        let pending = "";
        const output = child[stream]!;
        output.setEncoding("utf8");
        output.on("data", (chunk: string) => {
          pending += chunk;
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() ?? "";
          for (const line of lines) this.log(r, stream, line);
          while (pending.length > 1024) { this.log(r, stream, pending.slice(0, 1024)); pending = pending.slice(1024); }
        });
        output.on("end", () => { if (pending) this.log(r, stream, pending); });
      }
      child.on("error", (error) => this.log(r, "supervisor", error.message));
      r.done = new Promise((resolve) => child.once("close", (exitCode, exitSignal) => {
        r.exit = { at: Date.now(), code: signal ? code : code ?? exitCode, signal: signal ?? exitSignal, reason: "Process exited" };
        r.child = null;
        resolve();
      }));
      this.log(r, "supervisor", "Starting server");
    } catch (error) {
      await this.failed(r, error instanceof Error ? error.message : String(error));
    }
    this.changed();
  }

  private async halt(r: Runtime, reason: string) {
    if (r.child) {
      r.child.stdin?.end();
      await r.done;
    }
    if (r.exit) {
      r.lastExit = { ...r.exit, reason };
      r.exit = null;
      r.dirty = true;
    }
    r.startedAt = null;
    r.healthResult = null;
    await this.flush(r);
  }

  private async failed(r: Runtime, reason: string) {
    const hadProcess = Boolean(r.child || r.exit);
    await this.halt(r, reason);
    r.lastExit = hadProcess && r.lastExit ? { ...r.lastExit, reason } : { at: Date.now(), code: null, signal: null, reason };
    r.failures += 1;
    r.state = "crashed";
    r.restartAt = Date.now() + restartDelay(r.failures);
    this.log(r, "supervisor", `${reason}; retry in ${restartDelay(r.failures) / 1000}s`);
    await this.flush(r);
    // Preserve the ownership record on failure so removal can be retried safely.
    try { await this.removeRule(r); } catch (error) { this.log(r, "supervisor", `Serve cleanup: ${String(error)}`); }
    this.changed();
  }

  private async reconcile(r: Runtime) {
    if (!r.definition.enabled) {
      if (r.restartAt && r.restartAt > Date.now()) return;
      if (r.definition.rule) await this.removeRule(r);
      if (r.state !== "stopped") { r.state = "stopped"; r.restartAt = null; this.changed(); }
      return;
    }
    if (r.exit) { await this.failed(r, "Process exited"); return; }
    if (!r.child) {
      if (r.restartAt && r.restartAt > Date.now()) {
        if (r.state !== "restarting") { r.state = "restarting"; this.changed(); }
        return;
      }
      await this.launch(r);
      return;
    }
    if (Date.now() - r.lastProbe < 5000) return;
    r.lastProbe = Date.now();
    r.healthResult = await checkHealth(r.definition);
    if (r.healthResult.healthy) {
      if (r.definition.tailnet && (r.state !== "running" || Date.now() - r.lastRuleCheck >= 60_000)) {
        const rule = await this.rules.inspect(r.definition.port, r.definition.adoptTailnetRule, r.definition.rule);
        // Durable claim precedes the external mutation, so a bb crash cannot orphan a rule.
        r.definition.rule = rule;
        await this.save(r);
        await this.rules.ensure(rule);
        r.lastRuleCheck = Date.now();
      }
      if (r.state !== "running") { r.state = "running"; this.changed(); }
      r.unhealthyCount = 0;
      r.healthySince ??= Date.now();
      if (Date.now() - r.healthySince >= 60_000 && r.failures) { r.failures = 0; r.dirty = true; }
    } else {
      r.healthySince = null;
      r.unhealthyCount += 1;
      const starting = r.state === "starting" && Date.now() - (r.startedAt ?? 0) < 30_000;
      if (!starting && r.unhealthyCount >= 3) await this.failed(r, `Health check failed: ${r.healthResult.message}`);
    }
  }

  async run(signal: AbortSignal) {
    await this.initialize();
    this.active = true;
    try {
      while (!signal.aborted) {
        await this.exclusive(async () => {
          await Promise.all([...this.runtimes.values()].map(async (r) => {
            try { await this.reconcile(r); } catch (error) { await this.failed(r, String(error)); }
            await this.flush(r);
          }));
        });
        await delay(250, undefined, { signal }).catch(() => {});
      }
    } finally { await this.dispose(); }
  }
  dispose() {
    return this.disposal ??= this.shutdown();
  }
  private async shutdown() {
    this.active = false;
    if (this.disposed) return;
    await this.queue;
    this.disposed = true;
    if (!this.ready) return;
    await this.ready;
    await Promise.all([...this.runtimes.values()].map(async (r) => {
      await this.halt(r, "bb supervisor stopped");
      try { await this.removeRule(r); } catch (error) { this.bb.log.warn(`Persistent ${r.definition.name} Serve cleanup failed: ${String(error)}`); }
      r.state = "stopped";
    }));
  }
}
