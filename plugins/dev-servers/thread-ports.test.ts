import { afterEach, expect, test } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { TailnetRules } from "./tailnet";
import { ThreadPortManager, type PortListener, type PortSnapshot } from "./thread-ports";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const A = "thr_aaaaaaaaaa", B = "thr_bbbbbbbbbb";
function fixture() {
  let now = 10 * 3_600_000;
  const threads = [makeThreadResponse({ id: A, environmentId: "a", title: "App A", updatedAt: now - 2 * 3_600_000 }),
    makeThreadResponse({ id: B, environmentId: "b", title: "App B", updatedAt: now - 6 * 3_600_000 })];
  const processes = new Map<number, { cwd: string | null; command: string | null }>([
    [11, { cwd: "/projects/a", command: "node vite --port 5910" }], [22, { cwd: "/projects/b", command: "node vite --port 5920" }],
  ]);
  const h = createFakePluginHost({ pluginId: "dev-servers", sdk: {
    environments: { list: async () => [{ id: "a", path: "/projects/a", status: "ready" }, { id: "b", path: "/projects/b", status: "ready" }] },
    threads: {
      get: async ({ threadId }) => { const found = threads.find((t) => t.id === threadId); if (!found) throw new Error("Missing thread"); return found; },
      list: async (args) => threads.filter((t) => t.environmentId === args?.environmentId),
      send: async () => ({ status: "sent" }),
    },
    terminals: { list: async () => ({ sessions: [{ id: "terminal-a", status: "running" }, { id: "terminal-b", status: "running" }] }) },
  } });
  cleanups.push(() => h.harness.lifecycle.dispose());
  const dnsName = "fixture.example.ts.net";
  const serve = { TCP: {} as Record<string, { HTTPS: boolean }>, Web: {} as Record<string, { Handlers: Record<string, { Proxy: string }> }>, AllowFunnel: {} as Record<string, boolean> };
  const mutations: string[][] = [];
  const rules = new TailnetRules(async (args) => {
    if (args[0] === "status") return JSON.stringify({ BackendState: "Running", Self: { DNSName: `${dnsName}.` } });
    if (args[1] === "status") return JSON.stringify(serve);
    mutations.push(args);
    const port = args.find((a) => a.startsWith("--https="))!.split("=")[1];
    if (args.at(-1) === "off") { delete serve.TCP[port]; delete serve.Web[`${dnsName}:${port}`]; }
    else { serve.TCP[port] = { HTTPS: true }; serve.Web[`${dnsName}:${port}`] = { Handlers: { "/": { Proxy: args.at(-1)! } } }; }
    return "";
  });
  const existing = (port: number, proxy = `http://127.0.0.1:${port}`) => {
    serve.TCP[port] = { HTTPS: true }; serve.Web[`${dnsName}:${port}`] = { Handlers: { "/": { Proxy: proxy } } };
  };
  let healthy = true;
  const deps = { rules, processInfo: async (pid: number) => processes.get(pid) ?? { cwd: null, command: null }, probe: async () => healthy, now: () => now };
  const manager = new ThreadPortManager(h.bb, deps);
  const listener = (port: number, pid = 11): PortListener => ({ port, pid, processName: "node" });
  const snapshot = (listeners: PortListener[], reserved = new Set<number>()): PortSnapshot => ({ listeners, reserved, config: { portBase: 5910, blockSize: 10, blockCount: 2 } });
  return { ...h, manager, deps, processes, listener, snapshot, existing, mutations, serve, dnsName,
    advance: (ms: number) => { now += ms; }, unhealthy: () => { healthy = false; } };
}

test("unmanaged app bases and same-owner helpers are adopted, named, and served privately only on the base", async () => {
  const h = fixture();
  await h.manager.sweep(h.snapshot([h.listener(5910), h.listener(5914)]));
  expect(await h.bb.storage.kv.get("block:a")).toMatchObject({ base: 5910, size: 10 });
  expect(await h.bb.storage.kv.get("assignment:a:5910")).toMatchObject({ name: "App A", terminalId: null, pid: 11, threadId: A });
  expect(await h.bb.storage.kv.get("assignment:a:5914")).toMatchObject({ pid: 11 });
  expect(h.mutations).toEqual([["serve", "--bg", "--yes", "--https=5910", "http://127.0.0.1:5910"]]);
  expect(h.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  expect(h.harness.inspection.sdk.callsTo("terminals.close")).toHaveLength(0);
  await h.bb.storage.kv.set("assignment:a:5910", { ...await h.bb.storage.kv.get<object>("assignment:a:5910"), name: "custom app" });
  await h.manager.sweep(h.snapshot([h.listener(5910), h.listener(5914)]), true);
  expect(await h.bb.storage.kv.get("assignment:a:5910")).toMatchObject({ name: "custom app" });
});

test("rules wait for the expected HTTP response and stop removes only the owning thread's route", async () => {
  const h = fixture(); h.unhealthy();
  await h.manager.sweep(h.snapshot([h.listener(5910), h.listener(5920, 22)]));
  expect(h.mutations).toEqual([]);
  const ready = new ThreadPortManager(h.bb, { ...h.deps, probe: async () => true });
  await ready.sweep(h.snapshot([h.listener(5910), h.listener(5920, 22)]));
  await ready.removeForPorts([5910, 5920], A);
  expect(h.serve.Web[`${h.dnsName}:5910`]).toBeUndefined();
  expect(h.serve.Web[`${h.dnsName}:5920`]).toBeDefined();
  await ready.dispose();
  expect(h.serve.Web[`${h.dnsName}:5920`]).toBeUndefined();
});

test("a stopped app loses its private rule, while a reload can recreate it from durable assignment metadata", async () => {
  const h = fixture();
  await h.manager.sweep(h.snapshot([h.listener(5910)]));
  await h.manager.dispose();
  expect(h.serve.Web[`${h.dnsName}:5910`]).toBeUndefined();
  const next = new ThreadPortManager(h.bb, h.deps);
  await next.sweep(h.snapshot([h.listener(5910)]));
  expect(h.serve.Web[`${h.dnsName}:5910`]).toBeDefined();
  await h.bb.storage.kv.delete("assignment:a:5910");
  await next.sweep(h.snapshot([]));
  expect(h.serve.Web[`${h.dnsName}:5910`]).toBeUndefined();
});

test("orphan cleanup protects VNC, infrastructure, persistent definitions, live backends, Funnel and custom handlers", async () => {
  const h = fixture();
  for (const port of [5900, 5909, 5910, 6155, 6165, 6360, 6379, 6255, 6265, 6275]) h.existing(port);
  h.serve.Web[`${h.dnsName}:6255`].Handlers["/custom"] = { Proxy: "http://127.0.0.1:6255" };
  h.serve.AllowFunnel[`${h.dnsName}:6265`] = true;
  h.existing(6275, "http://127.0.0.1:6276");
  // The Serve daemon itself listening is not evidence of a live loopback app.
  await h.manager.sweep(h.snapshot([h.listener(6165), { port: 6155, pid: 999, processName: "tailscaled" }], new Set([6360])), true);
  expect(h.serve.Web[`${h.dnsName}:5910`]).toBeUndefined();
  expect(h.serve.Web[`${h.dnsName}:6155`]).toBeUndefined();
  for (const port of [5900, 5909, 6165, 6360, 6379, 6255, 6265, 6275]) expect(h.serve.Web[`${h.dnsName}:${port}`]).toBeDefined();
  expect(h.mutations.every((args) => !args.some((a) => /--https=590\d/.test(a)))).toBe(true);
});

test("off-grid listeners notify their owner once per episode, including across reload and PID changes", async () => {
  const h = fixture();
  await h.manager.sweep(h.snapshot([h.listener(6011)]));
  expect(h.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  expect(h.harness.inspection.sdk.callsTo("threads.send")[0][0]).toMatchObject({ threadId: A });
  const reloaded = await h.harness.lifecycle.reload(async () => {});
  cleanups.push(() => reloaded.harness.lifecycle.dispose());
  h.processes.set(33, { cwd: "/projects/a", command: "node vite --port 6011" });
  const next = new ThreadPortManager(reloaded.bb, h.deps);
  await next.sweep(h.snapshot([h.listener(6011, 33)]));
  expect(reloaded.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  await next.sweep(h.snapshot([]), true);
  await next.sweep(h.snapshot([h.listener(6011, 33)]), true);
  expect(reloaded.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  expect(reloaded.harness.inspection.sdk.callsTo("terminals.close")).toHaveLength(0);
});

test("unmanaged discovery repeats every two minutes while owned-rule stop cleanup remains immediate", async () => {
  const h = fixture();
  await h.manager.sweep(h.snapshot([]));
  h.advance(119_999);
  await h.manager.sweep(h.snapshot([h.listener(6111)]));
  expect(h.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  h.advance(1);
  await h.manager.sweep(h.snapshot([h.listener(6111)]));
  expect(h.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
});

test("command thread IDs resolve owners outside known cwd paths, while unknown processes and persistent helpers stay quiet", async () => {
  const h = fixture();
  h.processes.set(44, { cwd: "/unregistered", command: `node /tmp/${A}/viewer.js --port 6111` });
  h.processes.set(55, { cwd: "/unregistered", command: "node unrelated.js" });
  h.processes.set(66, { cwd: "/projects/b", command: "node persistent.js" });
  await h.manager.sweep(h.snapshot([h.listener(6111, 44), h.listener(6121, 55), h.listener(6360, 66), h.listener(6364, 66)], new Set([6360])));
  expect(h.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  expect(h.harness.inspection.sdk.callsTo("threads.send")[0][0]).toMatchObject({ threadId: A });
  expect(await h.bb.storage.kv.list("block:")).toEqual([]);
});

test("adoption refuses an active foreign lease and never closes another thread's terminal", async () => {
  const h = fixture();
  await h.bb.storage.kv.set("block:b", { environmentId: "b", base: 5910, index: 0, size: 10 });
  await h.bb.storage.kv.set("assignment:b:5910", { environmentId: "b", threadId: B, terminalId: "terminal-b", port: 5910, command: "dev" });
  await h.manager.sweep(h.snapshot([h.listener(5910)]));
  expect(await h.bb.storage.kv.get("block:b")).toBeDefined();
  expect(await h.bb.storage.kv.get("block:a")).toBeUndefined();
  expect(h.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  expect(h.harness.inspection.sdk.callsTo("threads.send")[0][0]).toMatchObject({ threadId: A });
  expect(h.harness.inspection.sdk.callsTo("terminals.close")).toHaveLength(0);
  expect(h.mutations).toEqual([]);
});

test("shared checkouts require an explicit owner instead of guessing the newest thread", async () => {
  const h = fixture();
  h.harness.inspection.sdk.stub("threads.list", async () => [
    makeThreadResponse({ id: A, environmentId: "a" }), makeThreadResponse({ id: "thr_cccccccccc", environmentId: "a" }),
  ]);
  await h.manager.sweep(h.snapshot([h.listener(5910), h.listener(6111)]));
  expect(await h.bb.storage.kv.list("assignment:")).toEqual([]);
  expect(h.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  expect(h.mutations).toEqual([]);
  h.processes.set(11, { cwd: "/projects/a", command: `node /tmp/${A}/viewer.js --port 5910` });
  await h.manager.sweep(h.snapshot([h.listener(5910)]), true);
  expect(await h.bb.storage.kv.get("assignment:a:5910")).toMatchObject({ threadId: A });
});

test("a persistent reservation supersedes old thread rule ownership without removing its endpoint", async () => {
  const h = fixture();
  await h.manager.sweep(h.snapshot([h.listener(5910)]));
  await h.manager.sweep(h.snapshot([h.listener(5910)], new Set([5910])), true);
  await h.manager.dispose();
  expect(h.serve.Web[`${h.dnsName}:5910`]).toBeDefined();
  expect(h.mutations.filter((args) => args.at(-1) === "off")).toEqual([]);
});

test("scarcity lists holders and idle durations and offers only the longest-idle owner a release, once", async () => {
  const h = fixture();
  for (const [environmentId, threadId, base] of [["a", A, 5910], ["b", B, 5920]] as const) {
    await h.bb.storage.kv.set(`block:${environmentId}`, { environmentId, base, index: (base - 5910) / 10, size: 10 });
    await h.bb.storage.kv.set(`assignment:${environmentId}:${base}`, { environmentId, threadId, terminalId: `terminal-${environmentId}`, port: base, command: "vite" });
  }
  const snapshot = h.snapshot([h.listener(5910), h.listener(5920, 22)]);
  const pressure = await h.manager.pressure(snapshot, "thr_requestxxx");
  expect(pressure.holders.join("\n")).toContain("thread idle 2h");
  expect(pressure.holders.join("\n")).toContain("thread idle 6h");
  expect(pressure.holders.join("\n")).toContain("PID 22 :5920");
  expect(pressure.offer).toContain(B);
  await h.manager.pressure(snapshot, "thr_requestxxx");
  expect(h.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  const sent = h.harness.inspection.sdk.callsTo("threads.send")[0][0] as { threadId: string; input: Array<{ text: string }> };
  expect(sent.threadId).toBe(B); expect(sent.input[0].text).toContain("bb dev-servers release");
  expect(h.harness.inspection.sdk.callsTo("terminals.close")).toHaveLength(0);
  await h.bb.storage.kv.delete("block:b"); await h.bb.storage.kv.delete("assignment:b:5920");
  await h.manager.sweep(h.snapshot([h.listener(5910)]));
  expect(await h.bb.storage.kv.list("pressure-notice:")).toEqual([]);
});
