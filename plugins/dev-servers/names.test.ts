import { afterEach, expect, test } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createServer } from "node:http";
import { defaultServerName, serverNameSchema, shortServerName } from "./names";
import { PersistentSupervisor, persistentInputSchema } from "./persistent";
import { TailnetRules } from "./tailnet";
import plugin from "./server";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const h = createFakePluginHost({ pluginId: "dev-servers", agentSkillIds: ["dev-servers"], sharedPortTunnelIdentities: { host: { label: "fixture", baseDomain: "example.test" } }, sdk: {
    projects: { list: async () => [{ id: "p", name: "fieldlabel", threads: [{ id: "t", environmentId: "env", title: "Grade icons for the new settings interface" }] }] },
    environments: { list: async () => [{ id: "env", status: "ready" }] },
    terminals: { create: async () => ({ id: "terminal" }), list: async () => ({ sessions: [] }), get: async () => ({ id: "terminal", environmentId: "env", status: "running", title: "icon grader" }) },
  } });
  cleanups.push(() => h.harness.lifecycle.dispose());
  return h;
}

test("explicit names accept spaces and 24 Unicode characters, and reject longer or multiline names", () => {
  expect(serverNameSchema.parse("icon grader")).toBe("icon grader");
  expect(serverNameSchema.parse("x".repeat(24))).toHaveLength(24);
  expect(serverNameSchema.parse("🎨".repeat(24))).toBe("🎨".repeat(24));
  expect(() => serverNameSchema.parse("x".repeat(25))).toThrow("at most 24 characters");
  expect(() => serverNameSchema.parse("first\nsecond")).toThrow("single line");
  expect(() => serverNameSchema.parse(" ")).toThrow("cannot be empty");
  expect(defaultServerName({ projectName: "fieldlabel", command: "pnpm dev --port {port}" })).toBe("fieldlabel dev");
  expect(defaultServerName({ cwd: "/durable/canvas", command: "npm run preview" })).toBe("canvas preview");
  expect(defaultServerName({ threadTitle: "A very long thread title that must fit" })).toBe("A very long thread title");
  expect(Array.from(shortServerName("🎨".repeat(30)))).toHaveLength(24);
});

test("start persists the purpose name and uses a short thread-title default; overlength fails before allocation", async () => {
  const h = fixture();
  await plugin(h.bb);
  // Fixed ports avoid interacting with another user's block during this wire test.
  const available = await import("./persistent");
  let port = 6361;
  while (port < 6378 && !(await available.portAvailable(port))) port++;
  expect(port).toBeLessThan(6378);
  const ctx = { projectId: "p", threadId: "t" };
  const invalid = await h.harness.behavior.runCli(["start", "--name", "x".repeat(25), "--command", "pnpm dev --port {port}"], ctx);
  expect(invalid.exitCode).not.toBe(0);
  expect(invalid.stderr).toContain("at most 24 characters");
  expect(await h.bb.storage.kv.list("block:")).toEqual([]);
  expect(h.harness.inspection.sdk.callsTo("terminals.create")).toHaveLength(0);
  const named = await h.harness.behavior.runCli(["start", "--name", "icon grader", "--port", String(port), "--command", "pnpm dev --port {port}", "--json"], ctx);
  expect(named.exitCode).toBe(0);
  expect(JSON.parse(named.stdout).name).toBe("icon grader");
  expect(await h.bb.storage.kv.get(`assignment:env:${port}`)).toMatchObject({ name: "icon grader" });
  expect(h.harness.inspection.sdk.callsTo("terminals.create")[0][0]).toMatchObject({ title: `icon grader · ${port}` });
  await h.bb.storage.kv.delete(`assignment:env:${port}`);
  const unnamed = await h.harness.behavior.runCli(["start", "--port", String(port), "--command", "pnpm dev --port {port}", "--json"], ctx);
  expect(unnamed.exitCode).toBe(0);
  expect(JSON.parse(unnamed.stdout).name).toBe(shortServerName("Grade icons for the new settings interface"));
});

test("persistent definitions accept short labels with spaces and derive meaningful names when omitted", async () => {
  const h = fixture();
  const supervisor = new PersistentSupervisor(h.bb, async () => {});
  cleanups.push(() => supervisor.dispose());
  const named = await supervisor.add(persistentInputSchema.parse({ name: "icon grader", cwd: "/private/tmp", command: "echo", port: 6361, enabled: false }));
  expect(named).toMatchObject({ name: "icon grader", displayName: "icon grader" });
  await expect(supervisor.add({ ...persistentInputSchema.parse({ cwd: "/private/tmp", command: "echo", port: 6362, enabled: false }), name: "x".repeat(25) })).rejects.toThrow("at most 24 characters");
  const fallback = await supervisor.add(persistentInputSchema.parse({ cwd: "/private/tmp", command: "npm run preview", port: 6362, enabled: false }));
  expect(fallback.name).toBe("tmp preview");
  await supervisor.control("icon grader", "remove");
  expect((await supervisor.list()).map((s) => s.name)).toEqual(["tmp preview"]);
});

test("list includes the persisted name and derives one for previously unnamed listeners", async () => {
  const h = fixture();
  const available = await import("./persistent");
  let port = 6361;
  while (port < 6378 && !(await available.portAvailable(port))) port++;
  expect(port).toBeLessThan(6378);
  const server = createServer((_q, r) => { r.setHeader("Content-Type", "text/html"); r.end("named test viewer"); });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  h.harness.inspection.sdk.stub("threads.list", async () => [makeThreadResponse({ id: "t", projectId: "p", environmentId: "env", title: "Grade icons" })]);
  h.harness.inspection.sdk.stub("environments.get", async () => ({ id: "env", status: "ready", path: process.cwd(), hostId: "host", name: "checkout", branchName: "main" }));
  await plugin(h.bb);
  await h.bb.storage.kv.set(`assignment:env:${port}`, { name: "icon grader", environmentId: "env", port, terminalId: "terminal", command: "pnpm dev", threadId: "t" });
  const ctx = { projectId: "p", threadId: "t" };
  const named = await h.harness.behavior.runCli(["list", "--json"], ctx);
  expect(named.exitCode).toBe(0);
  expect(JSON.parse(named.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ name: "icon grader", port })]));
  await h.bb.storage.kv.delete(`assignment:env:${port}`);
  expect((await h.harness.behavior.callRpc("list", { projectId: "p" }) as { servers: Array<{ name: string; port: number }> }).servers).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Grade icons", port })]));
});

test("legacy persistent identifiers remain usable while display labels stay short", async () => {
  const h = fixture();
  const oldName = "existing-persistent-viewer-with-a-long-id";
  await h.bb.storage.kv.set("persistent:" + oldName, { name: oldName, cwd: "/private/tmp", command: "echo", port: 6361, enabled: false,
    health: { path: "/", status: 200, contentType: "text/html", bodyIncludes: "" }, tailnet: false, adoptTailnetRule: false });
  const supervisor = new PersistentSupervisor(h.bb, async () => {});
  cleanups.push(() => supervisor.dispose());
  expect(await supervisor.list()).toMatchObject([{ name: oldName, displayName: shortServerName(oldName) }]);
  await supervisor.control(oldName, "remove");
  expect(await supervisor.list()).toEqual([]);
});

test("persistent CLI accepts quoted multiword names, rejects overlength, and defaults from thread context", async () => {
  const h = fixture();
  await plugin(h.bb);
  const add = ["persist", "add", "--cwd", "/private/tmp", "--command", "npm run preview", "--port", "6361", "--stopped", "--json"];
  const named = await h.harness.behavior.runCli([...add, "--name", "icon grader"]);
  expect(named.exitCode).toBe(0);
  expect(JSON.parse(named.stdout).name).toBe("icon grader");
  const invalid = await h.harness.behavior.runCli([...add, "--name", "x".repeat(25)]);
  expect(invalid.exitCode).not.toBe(0);
  expect(invalid.stderr).toContain("at most 24 characters");
  expect((await h.harness.behavior.runCli(["persist", "remove", "icon grader"])).exitCode).toBe(0);
  const fallback = await h.harness.behavior.runCli(add, { projectId: "p", threadId: "t" });
  expect(fallback.exitCode).toBe(0);
  expect(JSON.parse(fallback.stdout).name).toBe(shortServerName("Grade icons for the new settings interface"));
});

test("owned tailnet metadata carries the label without changing the proxy, and agent instructions require short names", async () => {
  const rules = new TailnetRules(async (args) => args[0] === "status" ? JSON.stringify({ BackendState: "Running", Self: { DNSName: "fixture.example.ts.net." } }) : "{}");
  expect(await rules.inspect(6361, false, null, "icon grader")).toMatchObject({ description: "icon grader", proxy: "http://127.0.0.1:6361" });
  const h = fixture();
  await plugin(h.bb);
  const config = await h.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
  expect(config.instructions).toContain('--name "icon grader"');
  expect(config.instructions).toContain("24 characters");
  expect(config.skills).toContain("dev-servers");
});
