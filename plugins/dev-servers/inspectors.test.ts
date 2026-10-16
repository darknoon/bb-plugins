import { afterEach, expect, test } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portAvailable } from "./persistent";
import plugin from "./server";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture() {
  let base = 6200;
  for (; base < 6350; base += 10) {
    if ((await Promise.all(Array.from({ length: 10 }, (_, i) => portAvailable(base + i)))).every(Boolean)) break;
  }
  expect(base).toBeLessThan(6350);
  const sessions: Array<{ id: string; status: string; threadId: string }> = [];
  const h = createFakePluginHost({ pluginId: "dev-servers", agentSkillIds: ["dev-servers"], sdk: {
    projects: { list: async () => [{ id: "p", name: "inspectors", threads: [{ id: "ta", environmentId: "a" }, { id: "tb", environmentId: "b" }] }] },
    environments: {
      list: async () => [{ id: "a", status: "ready" }, { id: "b", status: "ready" }],
      get: async ({ environmentId }) => ({ id: environmentId, status: "ready", path: process.cwd(), hostId: "host", name: "Checkout", branchName: null }),
    },
    threads: { list: async () => [makeThreadResponse({ id: "ta", projectId: "p", environmentId: "a" })] },
    terminals: {
      create: async ({ scope }) => {
        if (scope.kind !== "thread") throw new Error("Expected a thread-scoped server");
        const terminal = { id: `terminal-${sessions.length}`, status: "starting", threadId: scope.threadId };
        sessions.push(terminal);
        return terminal;
      },
      list: async ({ scope }) => ({ sessions: sessions.filter((s) => scope.kind === "thread" && s.threadId === scope.threadId) }),
    },
  } });
  cleanups.push(() => h.harness.lifecycle.dispose());
  await plugin(h.bb);
  await h.harness.behavior.setSettings({ portBase: String(base), blockSize: "5", blockCount: "2" });
  return { ...h, base, sessions };
}

test("concurrent Wrangler commands lease separate app and inspector ports inside their own blocks", async () => {
  const h = await fixture();
  const starts = await Promise.all(["ta", "tb"].map((threadId) => h.harness.behavior.runCli([
    "start", "--name", "worker viewer", "--command", "pnpm exec wrangler dev --port {port} --inspector-port {port+4}", "--json",
  ], { projectId: "p", threadId })));
  expect(starts.map((s) => s.exitCode)).toEqual([0, 0]);
  for (const [i, start] of starts.entries()) {
    const result = JSON.parse(start.stdout);
    const base = h.base + i * 5;
    expect(result.ports).toEqual([base, base + 4]);
    expect(result.command).toContain(`--port ${base} --inspector-port ${base + 4}`);
    expect(await h.bb.storage.kv.get(`assignment:${i === 0 ? "a" : "b"}:${base + 4}`)).toMatchObject({ terminalId: result.terminalId });
  }
});

test("the Vite bridge exports distinct inspector ports to real children with working HTTP and inspector responses", async () => {
  const h = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "bb-inspectors-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "server.mjs");
  // Consume the variable just as the documented cloudflare({ inspectorPort })
  // bridge does. Node's inspector gives us a real protocol endpoint to verify.
  await writeFile(script, `import { open } from 'node:inspector';
import { createServer } from 'node:http';
open(Number(process.env.BB_DEV_SERVER_INSPECTOR_PORT), '127.0.0.1');
createServer((_req, res) => res.end('managed inspector fixture')).listen(Number(process.argv[2]), '127.0.0.1');
`);
  h.harness.inspection.sdk.stub("terminals.create", async ({ scope, start }: { scope: { threadId: string }; start: { command: string } }) => {
    const child = spawn("/bin/sh", ["-c", start.command], { stdio: "ignore" });
    const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exit; });
    const terminal = { id: String(child.pid), status: "running", threadId: scope.threadId };
    h.sessions.push(terminal);
    return terminal;
  });
  const starts = await Promise.all(["ta", "tb"].map((threadId) => h.harness.behavior.runCli([
    "start", "--name", "inspector fixture", "--inspector-port", "{port+4}", "--command", `exec ${quote(process.execPath)} ${quote(script)} {port}`, "--json",
  ], { projectId: "p", threadId })));
  expect(starts.map((s) => s.exitCode)).toEqual([0, 0]);
  const results = starts.map((s) => JSON.parse(s.stdout));
  expect(results.map((r) => r.inspectorPort)).toEqual([h.base + 4, h.base + 9]);
  for (const result of results) {
    expect(result.ports).toEqual([result.base, result.inspectorPort]);
    for (let attempt = 0; ; attempt++) {
      try {
        const app = await fetch(`http://127.0.0.1:${result.base}`, { signal: AbortSignal.timeout(500) });
        expect(await app.text()).toBe("managed inspector fixture");
        const response = await fetch(`http://127.0.0.1:${result.inspectorPort}/json/list`, { signal: AbortSignal.timeout(500) });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([expect.objectContaining({ webSocketDebuggerUrl: expect.stringContaining(`127.0.0.1:${result.inspectorPort}`) })]);
        break;
      } catch (cause) {
        if (attempt >= 30) throw cause;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
});

test("invalid, shared, occupied, and pending inspector slots fail before another terminal starts", async () => {
  const h = await fixture();
  const ctx = { projectId: "p", threadId: "ta" };
  const args = ["start", "--name", "worker viewer", "--command", "pnpm dev --port {port}"];
  for (const value of ["{port+9}", "9231", "{port}", "{port+4}; echo unsafe"]) {
    const result = await h.harness.behavior.runCli([...args, "--inspector-port", value], ctx);
    expect(result.exitCode).toBe(2);
  }
  expect(h.harness.inspection.sdk.callsTo("terminals.create")).toHaveLength(0);
  expect(await h.bb.storage.kv.list("block:")).toEqual([]);

  const first = await h.harness.behavior.runCli([...args, "--inspector-port", "{port+4}", "--json"], ctx);
  expect(first.exitCode).toBe(0);
  const duplicate = await h.harness.behavior.runCli([
    "start", "--name", "second viewer", "--command", "pnpm dev --port {port+1}", "--inspector-port", "{port+4}",
  ], ctx);
  expect(duplicate.exitCode).toBe(1);
  expect(duplicate.stderr).toContain(`Port ${h.base + 4}: managed terminal`);
  expect(duplicate.stderr).toContain("thread ta");

  const listener = createServer((socket) => socket.end("not an inspector"));
  await new Promise<void>((resolve) => listener.listen(h.base + 3, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
  const occupied = await h.harness.behavior.runCli([
    "start", "--name", "second viewer", "--command", "pnpm dev --port {port+1}", "--inspector-port", "{port+3}",
  ], ctx);
  expect(occupied.exitCode).toBe(1);
  expect(occupied.stderr).toContain(`Port ${h.base + 3}`);
  expect(occupied.stderr).toContain(`PID ${process.pid}`);
  expect(h.harness.inspection.sdk.callsTo("terminals.create")).toHaveLength(1);

  await h.harness.behavior.callRpc("persistentAdd", { name: "reserved", cwd: tmpdir(), command: "echo", port: h.base + 7, enabled: false });
  const reserved = await h.harness.behavior.runCli([
    "start", "--name", "fixed viewer", "--port", String(h.base + 5), "--command", "pnpm dev --port {port}", "--inspector-port", "{port+2}",
  ], ctx);
  expect(reserved.exitCode).toBe(1);
  expect(reserved.stderr).toContain("reserved by a persistent server");
  expect(h.harness.inspection.sdk.callsTo("terminals.create")).toHaveLength(1);
});

test("agent instructions direct Wrangler and Vite to their supported inspector configuration", async () => {
  const h = await fixture();
  const config = await h.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
  expect(config.instructions).toContain("--inspector-port {port+4}");
  expect(config.instructions).toContain("BB_DEV_SERVER_INSPECTOR_PORT");
  expect(config.instructions).toContain("cloudflare({ inspectorPort })");
  expect(config.instructions).toContain("{port+9} overruns");
});
