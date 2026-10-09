import { afterEach, describe, expect, test } from "vitest";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFakePluginHost, experimental_scanPublicSdkOnly, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { checkHealth, PersistentSupervisor, persistentInputSchema, portAvailable, restartDelay } from "./persistent";
import plugin, { assignBlock } from "./server";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function waitFor(check: () => Promise<boolean>, timeout = 10_000) {
  const until = Date.now() + timeout;
  while (!(await check())) { if (Date.now() > until) throw new Error("Timed out"); await delay(50); }
}
async function freePort() {
  for (let port = 6360; port <= 6368; port++) if (await portAvailable(port)) return port;
  throw new Error("No spare persistent test port in 6360–6368");
}
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "persistent-test-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const host = createFakePluginHost({ pluginId: "dev-servers", sdk: { environments: { list: async () => [] } } });
  cleanups.push(() => host.harness.lifecycle.dispose());
  return { cwd, host, port: await freePort() };
}
function command(port: number) {
  const script = `require('http').createServer((q,r)=>{r.setHeader('Content-Type','text/html');r.end('<html>persistent-test</html>')}).listen(${port},'127.0.0.1'); console.log('ready');`;
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  return `${quote(process.execPath)} -e ${quote(script)}`;
}

describe("persistent process lifecycle", () => {
  test("IPv6-only non-HTTP listeners also make a persistent port unavailable", async () => {
    const port = await freePort();
    const server = createTcpServer((socket) => socket.end("binary service"));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "::1", resolve); });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    expect(await portAvailable(port)).toBe(false);
  });
  test("starts on service startup, checks HTTP, restarts, stops durably, and releases the process group", async () => {
    const { cwd, host, port } = await fixture();
    const supervisor = new PersistentSupervisor(host.bb, async () => {});
    cleanups.push(() => supervisor.dispose());
    await supervisor.add(persistentInputSchema.parse({ name: "viewer", cwd, command: command(port), port, health: { bodyIncludes: "persistent-test" } }));
    expect((await supervisor.list())[0].state).toBe("stopped");
    const controller = new AbortController();
    const run = supervisor.run(controller.signal);
    cleanups.push(async () => { controller.abort(); await run; });
    await waitFor(async () => (await supervisor.list())[0].state === "running");
    const first = (await supervisor.list())[0];
    expect(first.healthResult?.healthy).toBe(true);
    expect(first.uptimeMs).toBeGreaterThan(0);
    process.kill(first.pid!, "SIGTERM");
    await waitFor(async () => (await supervisor.list())[0].state === "restarting");
    expect((await supervisor.list())[0].lastExit).not.toBeNull();
    await waitFor(async () => (await supervisor.list())[0].state === "running");
    expect((await supervisor.list())[0].pid).not.toBe(first.pid);
    await supervisor.control("viewer", "stop");
    expect((await supervisor.list())[0].enabled).toBe(false);
    expect(await portAvailable(port)).toBe(true);
    await delay(1200);
    expect((await supervisor.list())[0].state).toBe("stopped");
    expect((await host.bb.storage.kv.get<{ enabled: boolean }>("persistent:viewer"))?.enabled).toBe(false);
    expect((await supervisor.list(80))[0].logs.some((l) => l.line === "ready")).toBe(true);
    await supervisor.control("viewer", "start");
    await waitFor(async () => (await supervisor.list())[0].state === "running");
    controller.abort(); await run;
    expect(await portAvailable(port)).toBe(true);
    const replacement = new PersistentSupervisor(host.bb, async () => {});
    cleanups.push(() => replacement.dispose());
    const nextController = new AbortController();
    const nextRun = replacement.run(nextController.signal);
    cleanups.push(async () => { nextController.abort(); await nextRun; });
    await waitFor(async () => (await replacement.list())[0].state === "running");
    expect((await replacement.list())[0].lastExit?.reason).toBe("bb supervisor stopped");
    await replacement.control("viewer", "remove");
    expect(await replacement.list()).toEqual([]);
    expect(await portAvailable(port)).toBe(true);
  });

  test("keeps a failing command in capped backoff; removal cancels a pending restart", async () => {
    const { cwd, host, port } = await fixture();
    const supervisor = new PersistentSupervisor(host.bb, async () => {});
    cleanups.push(() => supervisor.dispose());
    await supervisor.add(persistentInputSchema.parse({ name: "broken", cwd, command: "echo broken >&2; exit 42", port }));
    const controller = new AbortController(); const run = supervisor.run(controller.signal);
    cleanups.push(async () => { controller.abort(); await run; });
    await waitFor(async () => (await supervisor.list())[0].failures >= 2);
    const server = (await supervisor.list(80))[0];
    expect(server.lastExit?.code).toBe(42);
    expect(server.logs.some((l) => l.stream === "stderr" && l.line === "broken")).toBe(true);
    expect(restartDelay(1)).toBe(1000); expect(restartDelay(2)).toBe(2000); expect(restartDelay(20)).toBe(60_000);
    await supervisor.control("broken", "remove");
    await delay(1200);
    expect(await supervisor.list()).toEqual([]);
  });

  test("refuses to supervise an occupied port, even if its response matches", async () => {
    const { cwd, host, port } = await fixture();
    const external = createServer((_q, r) => { r.setHeader("Content-Type", "text/html"); r.end("external"); });
    await new Promise<void>((resolve) => external.listen(port, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => external.close(() => resolve())));
    const supervisor = new PersistentSupervisor(host.bb, async () => {});
    cleanups.push(() => supervisor.dispose());
    const controller = new AbortController(); const run = supervisor.run(controller.signal);
    cleanups.push(async () => { controller.abort(); await run; });
    await supervisor.add(persistentInputSchema.parse({ name: "occupied", cwd, command: command(port), port }));
    await waitFor(async () => (await supervisor.list())[0].failures > 0);
    expect((await supervisor.list())[0].lastExit?.reason).toContain("unrelated process");
    expect((await supervisor.list())[0].pid).toBeNull();
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("external");
  });

  test("HTTP health requires expected status, type and body; bounded reads reject stalls", async () => {
    const port = await freePort();
    const external = createServer((q, r) => {
      if (q.url === "/stall") { r.setHeader("Content-Type", "text/html"); r.write("prefix"); return; }
      if (q.url === "/redirect") { r.writeHead(302, { location: "https://example.com" }); r.end(); return; }
      r.setHeader("Content-Type", "text/html"); r.end("expected viewer");
    });
    await new Promise<void>((resolve) => external.listen(port, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { external.closeAllConnections(); external.close(() => resolve()); }));
    const health = persistentInputSchema.parse({ name: "health", cwd: "/tmp", command: "true", port, health: { bodyIncludes: "expected viewer" } }).health;
    expect((await checkHealth({ port, health })).healthy).toBe(true);
    expect((await checkHealth({ port, health: { ...health, status: 201 } })).healthy).toBe(false);
    expect((await checkHealth({ port, health: { ...health, contentType: "application/json" } })).healthy).toBe(false);
    expect((await checkHealth({ port, health: { ...health, bodyIncludes: "wrong viewer" } })).healthy).toBe(false);
    expect((await checkHealth({ port, health: { ...health, path: "/redirect" } })).healthy).toBe(false);
    expect((await checkHealth({ port, health: { ...health, path: "/stall" } }, 100)).healthy).toBe(false);
  });

  test("health probes release their own sockets rather than leaving idle connections", async () => {
    const port = await freePort();
    const external = createServer((_q, r) => { r.setHeader("Content-Type", "text/html"); r.end("viewer"); });
    let connections = 0;
    external.on("connection", (socket) => { connections++; socket.once("close", () => connections--); });
    await new Promise<void>((resolve) => external.listen(port, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { external.closeAllConnections(); external.close(() => resolve()); }));
    const health = persistentInputSchema.parse({ name: "health", cwd: "/tmp", command: "true", port, health: { bodyIncludes: "viewer" } }).health;
    expect((await checkHealth({ port, health })).healthy).toBe(true);
    await waitFor(async () => connections === 0);
    expect((await checkHealth({ port, health: { ...health, bodyIncludes: "" } })).healthy).toBe(true);
    await waitFor(async () => connections === 0);
  });
});

describe("plugin wire contracts and reservations", () => {
  test("worktree allocation skips persistent ports and preserves a worktree's existing block", async () => {
    const { host } = await fixture();
    const config = { portBase: 5910, blockSize: 10, blockCount: 9 };
    host.harness.sdk.stub("projects.list", async () => [{ id: "p", name: "Project" }]);
    host.harness.sdk.stub("threads.list", async () => [makeThreadResponse({ id: "t", environmentId: "env", projectId: "p" })]);
    host.harness.sdk.stub("environments.get", async () => ({ id: "env", path: "/durable", status: "ready", hostId: "host", branchName: "branch", name: "Worktree" }));
    host.harness.sdk.stub("environments.list", async () => [{ id: "env", status: "ready" }]);
    const occupied = new Set([5910, 5920, 5930, 5940, 5950, 5960, 5970, 5980]);
    expect(await assignBlock(host.bb, "env", occupied, config, new Set([5995]))).toBeNull();
    const assigned = await assignBlock(host.bb, "env", new Set(), config, new Set([5915]));
    expect(assigned?.base).toBe(5920);
    // Another thread server in the same block keeps the original allocation.
    expect((await assignBlock(host.bb, "env", new Set([5920]), config, new Set([5915])))?.base).toBe(5920);
    await expect(assignBlock(host.bb, "env", new Set([5920]), config, new Set([5925]))).rejects.toThrow("overlaps");
  });

  test("CLI works without a thread, validates flags and persists stop intent across reload", async () => {
    const { cwd, host, port } = await fixture();
    await plugin(host.bb);
    const cli = host.harness.behavior.runCli;
    expect((await cli(["persist", "add", "--name", "cli", "--cwd", cwd, "--command", command(port), "--port", String(port), "--stopped", "--json"])).exitCode).toBe(0);
    expect(await host.harness.behavior.callRpc("persistentList", {})).toMatchObject({ servers: [{ enabled: false }] });
    expect((await cli(["persist", "add", "--nmae", "bad"])).exitCode).not.toBe(0);
    expect((await cli(["persist", "restart", "--help"])).stdout).toContain("name");
    const replacement = await host.harness.lifecycle.reload(plugin);
    cleanups.push(() => replacement.harness.lifecycle.dispose());
    expect(await replacement.harness.behavior.callRpc("persistentList", {})).toMatchObject({ servers: [{ name: "cli" }] });
    const removed = await replacement.harness.behavior.runCli(["persist", "remove", "cli"]);
    expect(removed.stderr).toBe("");
    expect(removed.exitCode).toBe(0);
  });

  test("reservations reject duplicate and invalid ports, and worktree directories cannot graduate", async () => {
    const { cwd, host, port } = await fixture();
    await plugin(host.bb);
    const add = (name: string, fixed = port, directory = cwd) => host.harness.behavior.callRpc("persistentAdd", { name, cwd: directory, command: "true", port: fixed, enabled: false });
    await add("one");
    await expect(add("two")).rejects.toThrow("reserved");
    await expect(add("vnc", 5900)).rejects.toThrow();
    await expect(add("public-port", 3000)).rejects.toThrow();
    const next = port === 6368 ? 6367 : port + 1;
    host.harness.inspection.sdk.stub("environments.list", async () => [{ id: "worktree", path: cwd, status: "ready", workspaceProvisionType: "managed-worktree" }]);
    await expect(add("worktree", next)).rejects.toThrow("durable checkout");
    host.harness.inspection.sdk.stub("environments.list", async () => [{ id: "live", path: "/other", status: "ready", workspaceProvisionType: "managed-worktree" }]);
    await host.bb.storage.kv.set("block:live", { environmentId: "live", index: 8, base: 5990, size: 10 });
    await host.bb.storage.kv.set("assignment:live:5995", { environmentId: "live", port: 5995, terminalId: "starting", command: "harbor", threadId: "live-thread" });
    host.harness.inspection.sdk.stub("terminals.list", async () => ({ sessions: [{ id: "starting", status: "starting" }] }));
    await expect(add("harbor", 5995)).rejects.toThrow("live worktree block");
  });

  test("uses only public SDK imports", async () => {
    const result = await experimental_scanPublicSdkOnly(new URL(".", import.meta.url).pathname, { allow: [/^vitest(?:\/config)?$/, /^@testing-library\/react$/, /^react(?:-dom)?$/, /^@hugeicons\//, /^sonner$/, /^@\/components\//, /^@radix-ui\//, /^(?:class-variance-authority|clsx|tailwind-merge)$/, /^http$/] });
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
