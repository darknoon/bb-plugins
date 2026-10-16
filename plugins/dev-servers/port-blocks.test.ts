import { afterEach, expect, test } from "vitest";
import { createServer } from "node:net";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { adoptBlock, assignBlock, managedPortHolder, reclaimIdleBlocks } from "./port-blocks";
import { portAvailable } from "./persistent";
import plugin from "./server";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const config = { portBase: 5910, blockSize: 5, blockCount: 18 };
function hostFor(ids: string[]) {
  const host = createFakePluginHost({ pluginId: "dev-servers", sdk: {
    environments: { list: async () => ids.map((id) => ({ id, status: "ready" })) },
    terminals: { list: async () => ({ sessions: [] }) },
  } });
  cleanups.push(() => host.harness.lifecycle.dispose());
  return host;
}

test("plugin defaults allocate only CORS-allowed 59x0 app bases, with Harbor's block reserved", async () => {
  const ids = Array.from({ length: 9 }, (_, i) => `env-${i}`);
  const host = hostFor(ids);
  await plugin(host.bb);
  const descriptors = host.harness.inspection.registrations.settingsDescriptors;
  const defaults = {
    portBase: Number(descriptors.portBase.default),
    blockSize: Number(descriptors.blockSize.default),
    blockCount: Number(descriptors.blockCount.default),
  };
  const occupied = new Set<number>();
  const appPorts: number[] = [];
  for (const id of ids.slice(0, 8)) {
    const block = await assignBlock(host.bb, id, occupied, defaults, new Set([5995]));
    expect(block?.size).toBe(10);
    appPorts.push(block!.base);
    occupied.add(block!.base);
  }
  expect(appPorts).toEqual([5910, 5920, 5930, 5940, 5950, 5960, 5970, 5980]);
  expect(await assignBlock(host.bb, ids[8], occupied, defaults, new Set([5995]))).toBeNull();
});

test("plugin reload preserves saved allocation settings instead of resetting them to defaults", async () => {
  const host = hostFor(["env", "a", "b"]);
  const configureSdk = (target: typeof host) => {
    target.harness.inspection.sdk.stub("projects.list", async () => [{ id: "p", threads: [{ id: "t", environmentId: "env" }] }]);
    target.harness.inspection.sdk.stub("threads.list", async () => []);
    target.harness.inspection.sdk.stub("terminals.list", async () => ({ sessions: [{ id: "terminal-a", status: "starting" }, { id: "terminal-b", status: "starting" }] }));
  };
  configureSdk(host);
  await plugin(host.bb);
  await host.harness.behavior.setSettings({ portBase: "6200", blockSize: "3", blockCount: "2" });
  for (const [index, id] of ["a", "b"].entries()) {
    const base = 6200 + index * 3;
    await host.bb.storage.kv.set(`block:${id}`, { environmentId: id, index, base, size: 3 });
    await host.bb.storage.kv.set(`assignment:${id}:${base}`, { environmentId: id, port: base, terminalId: `terminal-${id}`, threadId: `thread-${id}`, command: "dev" });
  }
  const reloaded = await host.harness.lifecycle.reload(plugin);
  cleanups.push(() => reloaded.harness.lifecycle.dispose());
  configureSdk(reloaded);
  const result = await reloaded.harness.behavior.runCli([
    "start", "--name", "saved settings", "--command", "echo {port}",
  ], { projectId: "p", threadId: "t" });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("All 2 port blocks (6200-6205) are active or reserved");
  expect(reloaded.harness.inspection.sdk.callsTo("terminals.create")).toHaveLength(0);
});

test("reclaims all eight idle live environments, including permanent checkouts, with Harbor reserved", async () => {
  const ids = Array.from({ length: 8 }, (_, i) => `idle-${i}`);
  const host = hostFor([...ids, "new"]);
  for (const [i, id] of ids.entries()) await host.bb.storage.kv.set(`block:${id}`, { environmentId: id, index: i, base: 5910 + i * 10 });
  expect(await assignBlock(host.bb, "new", new Set(), { ...config, blockSize: 10, blockCount: 9 }, new Set([5995]))).toMatchObject({ base: 5910 });
  expect(await host.bb.storage.kv.list("block:")).toEqual(["block:new"]);
});

test("an exited terminal's stale 5960 lease is reclaimed despite a foreign listener, and start gets a free block", async () => {
  const host = hostFor(["jsonl", "fieldlabel"]);
  const grid = { portBase: 5960, blockSize: 10, blockCount: 2 };
  await host.bb.storage.kv.set("block:jsonl", { environmentId: "jsonl", index: 5, base: 5960, size: 10 });
  await host.bb.storage.kv.set("assignment:jsonl:5960", { environmentId: "jsonl", port: 5960, terminalId: "closed", threadId: "jsonl-thread", command: "bun dev --port 5960" });
  await host.bb.storage.kv.set("assignment:jsonl:5961", { environmentId: "jsonl", port: 5961, terminalId: null, threadId: "jsonl-thread", command: "bun dev --port 5960" });
  host.harness.inspection.sdk.stub("terminals.list", async () => ({ sessions: [{ id: "closed", status: "exited" }] }));
  const block = await assignBlock(host.bb, "jsonl", new Set([5960]), grid, new Set(), async () => false);
  expect(block).toMatchObject({ base: 5970, size: 10 });
  expect(await host.bb.storage.kv.list("assignment:")).toEqual([]);
});

test("reconciliation checks orphan explicit/adopted assignments and global startup leases across environments", async () => {
  const host = hostFor(["a", "b"]);
  await host.bb.storage.kv.set("assignment:a:5960", { environmentId: "a", port: 5960, terminalId: "closed", threadId: "ta", command: "dev" });
  await host.bb.storage.kv.set("assignment:a:5961", { environmentId: "a", port: 5961, terminalId: null, threadId: "ta", command: "dev" });
  await host.bb.storage.kv.set("assignment:b:5962", { environmentId: "b", port: 5962, terminalId: "boot", threadId: "tb", command: "dev" });
  host.harness.inspection.sdk.stub("terminals.list", async ({ scope }: { scope: { threadId: string } }) => ({ sessions: scope.threadId === "tb" ? [{ id: "boot", status: "starting" }] : [] }));
  await reclaimIdleBlocks(host.bb, new Set([5960, 5961]), config, async () => false);
  expect(await host.bb.storage.kv.list("assignment:")).toEqual(["assignment:b:5962"]);
  expect(await managedPortHolder(host.bb, null, 5962)).toMatchObject({ threadId: "tb", status: "starting" });
});

test("10→5→10 settings changes never overlap retained live blocks", async () => {
  const host = hostFor(["ten", "five", "new"]);
  await host.bb.storage.kv.set("block:ten", { environmentId: "ten", index: 0, base: 5960, size: 10 });
  const occupied = new Set([5960]);
  const five = await assignBlock(host.bb, "five", occupied, { portBase: 5960, blockSize: 5, blockCount: 6 }, new Set());
  expect(five).toMatchObject({ base: 5970, size: 5 });
  occupied.add(five!.base);
  expect(await assignBlock(host.bb, "new", occupied, { portBase: 5960, blockSize: 10, blockCount: 3 }, new Set())).toMatchObject({ base: 5980, size: 10 });
});

test("startup terminals hold blocks; exit releases the final lease and assignment", async () => {
  const host = hostFor(["a", "b"]);
  await host.bb.storage.kv.set("block:a", { environmentId: "a", index: 0, base: 5910, size: 5 });
  await host.bb.storage.kv.set("assignment:a:5910", { environmentId: "a", port: 5910, terminalId: "boot", threadId: "t", command: "dev" });
  let status = "starting";
  host.harness.inspection.sdk.stub("terminals.list", async () => ({ sessions: [{ id: "boot", status }] }));
  expect(await assignBlock(host.bb, "b", new Set(), config, new Set())).toMatchObject({ base: 5915 });
  status = "running";
  expect(await reclaimIdleBlocks(host.bb, new Set(), config)).toMatchObject([{ environmentId: "a" }]);
  status = "exited";
  expect(await reclaimIdleBlocks(host.bb, new Set(), config)).toEqual([]);
  expect(await host.bb.storage.kv.list("assignment:")).toEqual([]);
  expect(await assignBlock(host.bb, "b", new Set(), config, new Set())).toMatchObject({ base: 5910 });
});

test("unknown terminal status never frees a lease, and deleted environments still leave occupied ports protected", async () => {
  const host = hostFor(["a", "b"]);
  await host.bb.storage.kv.set("block:a", { environmentId: "a", index: 0, base: 5910, size: 5 });
  await host.bb.storage.kv.set("assignment:a:5910", { environmentId: "a", port: 5910, terminalId: "unreachable", threadId: "t", command: "dev" });
  host.harness.inspection.sdk.stub("terminals.list", async () => { throw new Error("host unavailable"); });
  expect(await assignBlock(host.bb, "b", new Set(), config, new Set())).toMatchObject({ base: 5915 });
  host.harness.inspection.sdk.stub("environments.list", async () => [{ id: "b", status: "ready" }]);
  expect(await assignBlock(host.bb, "b", new Set([5911]), config, new Set())).toMatchObject({ base: 5915 });
  expect(await host.bb.storage.kv.get("block:a")).toBeUndefined();
});

test("running legacy blocks retain all ten ports with a custom five-port configuration", async () => {
  const host = hostFor(["legacy", "new"]);
  await host.bb.storage.kv.set("block:legacy", { environmentId: "legacy", index: 0, base: 5910 });
  await reclaimIdleBlocks(host.bb, new Set([5917]), { ...config, blockSize: 10, blockCount: 9 });
  expect(await assignBlock(host.bb, "legacy", new Set([5917]), config, new Set())).toMatchObject({ base: 5910, size: 10 });
  expect(await assignBlock(host.bb, "new", new Set([5917]), config, new Set([5995]))).toMatchObject({ base: 5920, size: 5 });
  await reclaimIdleBlocks(host.bb, new Set(), config);
  expect(await assignBlock(host.bb, "legacy", new Set(), config, new Set())).toMatchObject({ base: 5910, size: 5 });
});

test("the first upgrade recognizes legacy size under a custom five-port configuration", async () => {
  const host = hostFor(["legacy", "new"]);
  await host.bb.storage.kv.set("block:legacy", { environmentId: "legacy", index: 0, base: 5910 });
  expect(await assignBlock(host.bb, "new", new Set([5917]), config, new Set())).toMatchObject({ base: 5920, size: 5 });
  expect(await host.bb.storage.kv.get("block:legacy")).toMatchObject({ size: 10 });
});

test("seventeen concurrent five-port blocks fit beside Harbor, and adoption respects other leases and reservations", async () => {
  const ids = Array.from({ length: 18 }, (_, i) => `env-${i}`);
  const host = hostFor(ids);
  const occupied = new Set<number>();
  for (let i = 0; i < 17; i++) {
    const block = await assignBlock(host.bb, ids[i], occupied, config, new Set([5995]));
    expect(block?.base).toBe(5910 + i * 5);
    occupied.add(block!.base);
  }
  expect(await assignBlock(host.bb, ids[17], occupied, config, new Set([5995]))).toBeNull();
  await expect(adoptBlock(host.bb, ids[17], 5911, occupied, config, new Set())).rejects.toThrow("another active environment");
  await expect(adoptBlock(host.bb, ids[17], 5996, occupied, config, new Set([5995]))).rejects.toThrow("persistent");
});

test("wire start refuses a non-HTTP listener with its PID/thread, and adopt records the existing process", async () => {
  let port = 6360;
  while (port <= 6368 && !(await portAvailable(port))) port++;
  expect(port).toBeLessThanOrEqual(6368);
  const server = createServer((socket) => socket.end("binary protocol"));
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const host = hostFor(["env"]);
  host.harness.inspection.sdk.stub("projects.list", async () => [{ id: "p", name: "Project", threads: [{ id: "t", environmentId: "env" }] }]);
  host.harness.inspection.sdk.stub("threads.list", async () => [makeThreadResponse({ id: "t", projectId: "p", environmentId: "env" })]);
  host.harness.inspection.sdk.stub("environments.get", async () => ({ id: "env", path: process.cwd(), status: "ready", hostId: "host", branchName: null, name: "Checkout" }));
  await plugin(host.bb);
  await host.harness.behavior.setSettings({ portBase: String(port), blockSize: "1", blockCount: "1" });
  const ctx = { threadId: "t", projectId: "p" };
  const start = await host.harness.behavior.runCli(["start", "--command", "echo {port}"], ctx);
  expect(start.exitCode).toBe(1);
  expect(start.stderr).toContain(`PID ${process.pid}`);
  expect(start.stderr).toContain("thread t");
  expect(start.stderr).toContain("unmanaged");
  expect(host.harness.inspection.sdk.callsTo("terminals.create")).toHaveLength(0);
  host.harness.inspection.sdk.stub("environments.get", async () => ({ id: "env", path: "/private/tmp", status: "ready" }));
  expect((await host.harness.behavior.runCli(["adopt", "--port", String(port)], ctx)).stderr).toContain("another environment's process");
  host.harness.inspection.sdk.stub("environments.get", async () => ({ id: "env", path: process.cwd(), status: "ready" }));
  const adopt = await host.harness.behavior.runCli(["adopt", "--port", String(port), "--json"], ctx);
  expect(adopt.exitCode).toBe(0);
  expect(JSON.parse(adopt.stdout)).toMatchObject({ port, pid: process.pid, threadId: "t" });
  expect(await host.bb.storage.kv.get(`assignment:env:${port}`)).toMatchObject({ terminalId: null, threadId: "t" });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect((await host.harness.behavior.runCli(["adopt", "--port", String(port)], ctx)).stderr).toContain("Nothing is listening");
  await reclaimIdleBlocks(host.bb, new Set(), { portBase: port, blockSize: 1, blockCount: 1 });
  expect(await host.bb.storage.kv.list("block:")).toEqual([]);
});

test("concurrent wire starts reserve separate blocks before either server binds", async () => {
  let port = 6360;
  while (port <= 6367 && (!(await portAvailable(port)) || !(await portAvailable(port + 1)))) port++;
  expect(port).toBeLessThanOrEqual(6367);
  const host = hostFor(["a", "b"]);
  const sessions: Array<{ id: string; status: string; threadId: string }> = [];
  host.harness.inspection.sdk.stub("projects.list", async () => [{ id: "p", name: "Project", threads: [{ id: "ta", environmentId: "a" }, { id: "tb", environmentId: "b" }] }]);
  host.harness.inspection.sdk.stub("terminals.create", async ({ scope }: { scope: { threadId: string } }) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const terminal = { id: scope.threadId, status: "starting", threadId: scope.threadId };
    sessions.push(terminal);
    return terminal;
  });
  host.harness.inspection.sdk.stub("terminals.list", async ({ scope }: { scope: { threadId: string } }) => ({ sessions: sessions.filter((s) => s.threadId === scope.threadId) }));
  await plugin(host.bb);
  await host.harness.behavior.setSettings({ portBase: String(port), blockSize: "1", blockCount: "2" });
  const results = await Promise.all(["ta", "tb"].map((threadId) => host.harness.behavior.runCli(["start", "--command", "echo {port}", "--json"], { projectId: "p", threadId })));
  expect(results.map((r) => r.exitCode)).toEqual([0, 0]);
  expect(results.map((r) => JSON.parse(r.stdout).base)).toEqual([port, port + 1]);
  const duplicate = await host.harness.behavior.runCli(["start", "--command", "echo {port}"], { projectId: "p", threadId: "ta" });
  expect(duplicate.exitCode).toBe(1);
  expect(duplicate.stderr).toContain("terminal ta");
  expect(duplicate.stderr).toContain("thread ta");
  host.harness.inspection.sdk.stub("terminals.list", async () => ({ sessions: [] }));
  const invalid = await host.harness.behavior.runCli(["start", "--command", "echo {port+1}"], { projectId: "p", threadId: "ta" });
  expect(invalid.exitCode).toBe(2);
  expect(await host.bb.storage.kv.list("block:")).toEqual([]);
  expect(host.harness.inspection.sdk.callsTo("terminals.create")).toHaveLength(2);
});

test("the background lease service releases an idle block and shuts down promptly", async () => {
  const host = hostFor(["idle"]);
  let port = 6360;
  while (port <= 6368 && !(await portAvailable(port))) port++;
  expect(port).toBeLessThanOrEqual(6368);
  await host.bb.storage.kv.set("block:idle", { environmentId: "idle", index: 0, base: port, size: 1 });
  await plugin(host.bb);
  const service = host.harness.behavior.runService("port-block-leases");
  cleanups.push(async () => { service.controller.abort(); await service.done; });
  for (let attempt = 0; await host.bb.storage.kv.get("block:idle"); attempt++) {
    if (attempt > 100) throw new Error("Idle lease was not released");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  service.controller.abort();
  await service.done;
  expect(await host.bb.storage.kv.list("block:")).toEqual([]);
});
