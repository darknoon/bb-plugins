import { afterEach, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { assertPortAllowed, assertPortRange, PORT_DENYLIST } from "./port-policy";
import { adoptBlock, assignBlock } from "./port-blocks";
import { PersistentSupervisor, persistentInputSchema, portAvailable } from "./persistent";
import { TailnetRules } from "./tailnet";
import plugin from "./server";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function host(options: Parameters<typeof createFakePluginHost>[0] = {}) {
  const result = createFakePluginHost({ pluginId: "dev-servers", ...options });
  cleanups.push(() => result.harness.lifecycle.dispose());
  return result;
}
const config = { portBase: 5910, blockSize: 10, blockCount: 9 };

test("5900–5909 can never be allocated, explicitly started, adopted, or registered persistently", async () => {
  const h = host({ sdk: { projects: { list: async () => [{ id: "p", threads: [{ id: "t", environmentId: "env" }] }] } } });
  await plugin(h.bb);
  for (let port = 5900; port <= 5909; port++) {
    expect(PORT_DENYLIST).toContain(port);
    expect(await portAvailable(port)).toBe(false);
    await expect(assignBlock(h.bb, "env", new Set(), { portBase: port, blockSize: 1, blockCount: 1 }, new Set())).rejects.toThrow("denylist");
    await expect(adoptBlock(h.bb, "env", port, new Set([port]), config, new Set())).rejects.toThrow("infrastructure");
    expect(persistentInputSchema.safeParse({ name: "blocked", cwd: "/tmp", command: "echo", port }).success).toBe(false);
    const result = await h.harness.behavior.runCli(["start", "--port", String(port), "--command", "echo {port}"], { projectId: "p", threadId: "t" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("infrastructure");
  }
  expect(h.harness.inspection.sdk.callsTo("terminals.create")).toHaveLength(0);
  expect(await h.bb.storage.kv.list("block:")).toEqual([]);
  const offset = await h.harness.behavior.runCli(["start", "--port", "6378", "--command", "echo {port+1}"], { projectId: "p", threadId: "t" });
  expect(offset.exitCode).not.toBe(0);
  expect(offset.stderr).toContain("6379");
});

test("all infrastructure ports are blocked and ranges fail rather than skip them", () => {
  for (const port of [22, 80, 443, 3389, 5432, 6379, 8080, 38886, 38887, 41641]) {
    expect(PORT_DENYLIST).toContain(port);
    expect(() => assertPortAllowed(port)).toThrow("infrastructure");
    expect(() => assertPortRange({ portBase: port - 1, blockSize: 3, blockCount: 1 })).toThrow("denylist");
  }
  expect(() => assertPortRange(config)).not.toThrow();
  expect(() => assertPortAllowed(5899)).toThrow("5910");
});

test("plugin startup refuses overlapping settings and non-default bb server/daemon ports", async () => {
  const invalid = host({ settings: { portBase: "6375", blockSize: "5", blockCount: "1" } });
  await expect(plugin(invalid.bb)).rejects.toThrow("6379");
  const server = host({ loopbackBaseUrl: "http://127.0.0.1:5923" });
  await expect(plugin(server.bb)).rejects.toThrow("5923");
  vi.stubEnv("BB_HOST_DAEMON_PORT", "5924");
  const daemon = host();
  await expect(plugin(daemon.bb)).rejects.toThrow("5924");
});

test("an old active block in the Screen Sharing span cannot be returned after upgrade", async () => {
  const h = host({ sdk: { environments: { list: async () => [{ id: "env", status: "ready" }] } } });
  await h.bb.storage.kv.set("block:env", { environmentId: "env", base: 5900, index: 0, size: 10 });
  await expect(assignBlock(h.bb, "env", new Set([5905]), config, new Set())).rejects.toThrow("denylist");
});

test("a factory may precede loopback binding, but services strictly check the actual server port before starting", async () => {
  const h = host();
  let bound = false;
  const bb = { ...h.bb, server: new Proxy(h.bb.server, { get(target, key) {
    if (key === "loopbackBaseUrl" && !bound) throw new Error("Loopback is not bound yet");
    if (key === "loopbackBaseUrl") return "http://127.0.0.1:5923";
    return Reflect.get(target, key);
  } }) };
  await plugin(bb);
  bound = true;
  const service = h.harness.behavior.runService("persistent-servers");
  await expect(service.done).rejects.toThrow("5923");
});

test("a legacy persistent definition is disabled and its exact private rule removed, with Start refused", async () => {
  const h = host();
  const remove = vi.fn(async () => {});
  const rules = { remove } as unknown as TailnetRules;
  const rule = { dnsName: "fixture.example.ts.net", port: 5909, proxy: "http://127.0.0.1:5909" };
  await h.bb.storage.kv.set("persistent:legacy", { name: "legacy", cwd: "/tmp", command: "echo", port: 5909,
    enabled: true, health: { path: "/", status: 200, contentType: "text/html", bodyIncludes: "" }, tailnet: true, adoptTailnetRule: false, rule });
  const supervisor = new PersistentSupervisor(h.bb, async () => {}, rules);
  cleanups.push(() => supervisor.dispose());
  expect(await supervisor.list()).toMatchObject([{ name: "legacy", enabled: false, state: "crashed", pid: null, lastExit: { reason: expect.stringContaining("infrastructure") } }]);
  expect(remove).toHaveBeenCalledWith(rule);
  expect(await h.bb.storage.kv.get("persistent:legacy")).toMatchObject({ enabled: false, rule: null });
  await expect(supervisor.control("legacy", "start")).rejects.toThrow("infrastructure");
  await supervisor.control("legacy", "remove");
  expect(await supervisor.list()).toEqual([]);
});

test("Serve creation refuses every denylisted port before executing a command, but owned legacy cleanup remains possible", async () => {
  const execute = vi.fn(async () => "");
  const rules = new TailnetRules(execute);
  for (const port of PORT_DENYLIST) {
    await expect(rules.inspect(port)).rejects.toThrow("infrastructure");
    await expect(rules.ensure({ dnsName: "fixture.example.ts.net", port, proxy: `http://127.0.0.1:${port}` })).rejects.toThrow("infrastructure");
  }
  expect(execute).not.toHaveBeenCalled();
});
