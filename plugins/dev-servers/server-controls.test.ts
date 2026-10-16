import { afterEach, expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portAvailable } from "./persistent";
import plugin from "./server";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const a = { projectId: "p", threadId: "ta" };
const b = { projectId: "p", threadId: "tb" };
const shared = { projectId: "p", threadId: "shared" };
async function fixture() {
  let base = 6200;
  for (; base < 6340; base += 20) if ((await Promise.all(Array.from({ length: 20 }, (_, i) => portAvailable(base + i)))).every(Boolean)) break;
  expect(base).toBeLessThan(6340);
  const path = await mkdtemp(join(tmpdir(), "bb-server-controls-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  await writeFile(join(path, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  const sessions: Array<{ id: string; threadId: string; status: string }> = [];
  const h = createFakePluginHost({ pluginId: "dev-servers", sdk: {
    projects: { list: async () => [{ id: "p", name: "fixture", threads: [{ id: "ta", environmentId: "a" }, { id: "tb", environmentId: "b" }, { id: "shared", environmentId: "a" }] }] },
    threads: { list: async () => [] },
    environments: {
      list: async () => [{ id: "a", path, status: "ready" }, { id: "b", path, status: "ready" }],
      get: async ({ environmentId }) => ({ id: environmentId, path, status: "ready" }),
    },
    terminals: {
      create: async ({ scope }) => {
        if (scope.kind !== "thread") throw new Error("Expected thread scope");
        const session = { id: `terminal-${sessions.length}`, threadId: scope.threadId, status: "starting" };
        sessions.push(session); return session;
      },
      list: async ({ scope }) => ({ sessions: sessions.filter((s) => scope.kind === "thread" && s.threadId === scope.threadId) }),
      close: async ({ terminalId }) => { const s = sessions.find((s) => s.id === terminalId)!; s.status = "exited"; return s; },
    },
  } });
  cleanups.push(() => h.harness.lifecycle.dispose());
  await plugin(h.bb);
  await h.harness.behavior.setSettings({ portBase: String(base), blockSize: "10", blockCount: "2" });
  return { ...h, base, sessions };
}

test("fixed-port starts honor other environments' pending ports and entire active blocks", async () => {
  const h = await fixture();
  const first = await h.harness.behavior.runCli(["start", "--name", "first", "--port", String(h.base), "--command", "pnpm dev --port {port}", "--json"], a);
  expect(first.exitCode).toBe(0);
  expect(JSON.parse(first.stdout).command).toContain("--strictPort");
  const collision = await h.harness.behavior.runCli(["start", "--name", "second", "--port", String(h.base), "--command", "pnpm dev --port {port}"], b);
  expect(collision.exitCode).toBe(1);
  expect(collision.stderr).toContain("thread ta");
  expect(h.harness.inspection.sdk.callsTo("terminals.create")).toHaveLength(1);
  expect((await h.harness.behavior.runCli(["stop"], a)).exitCode).toBe(0);
  const allocated = await h.harness.behavior.runCli(["start", "--name", "first block", "--command", "pnpm dev --port {port}"], a);
  expect(allocated.exitCode).toBe(0);
  const inside = await h.harness.behavior.runCli(["start", "--name", "inside block", "--port", String(h.base + 1), "--command", "pnpm dev --port {port}"], b);
  expect(inside.exitCode).toBe(1);
  expect(inside.stderr).toContain("leased by environment a");
});

test("stop closes all ports of the selected terminal, preserves another thread, and release refuses live leases", async () => {
  const h = await fixture();
  expect((await h.harness.behavior.runCli(["start", "--name", "first", "--inspector-port", "{port+4}", "--command", "pnpm dev --port {port}"], a)).exitCode).toBe(0);
  expect((await h.harness.behavior.runCli(["start", "--name", "shared", "--port", String(h.base), "--inspector-port", "{port+3}", "--command", "pnpm dev --port {port+1}"], shared)).exitCode).toBe(0);
  expect((await h.harness.behavior.runCli(["release"], a)).exitCode).toBe(1);
  const stop = await h.harness.behavior.runCli(["stop", "--port", String(h.base), "--json"], a);
  expect(stop.exitCode).toBe(0);
  expect(JSON.parse(stop.stdout).stoppedTerminals).toEqual(["terminal-0"]);
  expect(h.sessions[1].status).toBe("starting");
  expect(await h.bb.storage.kv.list("assignment:")).toEqual([`assignment:a:${h.base + 1}`, `assignment:a:${h.base + 3}`]);
  expect((await h.harness.behavior.runCli(["release"], a)).exitCode).toBe(1);
  expect((await h.harness.behavior.runCli(["stop"], shared)).exitCode).toBe(0);
  expect((await h.harness.behavior.runCli(["release"], a)).exitCode).toBe(0);
  expect(await h.bb.storage.kv.list("block:")).toEqual([]);
});

test("start moves off an occupied stale block and release clears idle metadata without killing the foreign listener", async () => {
  const h = await fixture();
  const listener = createServer((socket) => socket.end("foreign listener"));
  await new Promise<void>((resolve) => listener.listen(h.base, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
  await h.bb.storage.kv.set("block:a", { environmentId: "a", index: 0, base: h.base, size: 10 });
  await h.bb.storage.kv.set(`assignment:a:${h.base}`, { environmentId: "a", port: h.base, terminalId: "closed", threadId: "ta", command: "pnpm dev" });
  const busyBase = await h.harness.behavior.runCli(["start", "--name", "busy base", "--port", String(h.base), "--command", "pnpm dev --port {port+1}"], b);
  expect(busyBase.exitCode).toBe(1);
  expect(busyBase.stderr).toContain(`Port ${h.base} is already in use`);
  const start = await h.harness.behavior.runCli(["start", "--name", "reallocated", "--command", "pnpm dev --port {port}", "--json"], a);
  expect(start.exitCode).toBe(0);
  expect(JSON.parse(start.stdout).base).toBe(h.base + 10);
  expect(await h.bb.storage.kv.get(`assignment:a:${h.base}`)).toBeUndefined();
  expect(listener.listening).toBe(true);
  expect((await h.harness.behavior.runCli(["stop"], a)).exitCode).toBe(0);
  expect((await h.harness.behavior.runCli(["release"], a)).exitCode).toBe(0);
  expect(listener.listening).toBe(true);
});

test("adopted processes are not killed by stop; release succeeds once their listener exits", async () => {
  const h = await fixture();
  const listener = createServer((socket) => socket.end("manual listener"));
  await new Promise<void>((resolve) => listener.listen(h.base, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
  await h.bb.storage.kv.set("block:a", { environmentId: "a", index: 0, base: h.base, size: 10 });
  await h.bb.storage.kv.set(`assignment:a:${h.base}`, { environmentId: "a", port: h.base, terminalId: null, threadId: "ta", command: "manual" });
  const stop = await h.harness.behavior.runCli(["stop"], a);
  expect(stop.exitCode).toBe(1);
  expect(JSON.parse(stop.stdout).manualPorts).toEqual([h.base]);
  expect(listener.listening).toBe(true);
  expect((await h.harness.behavior.runCli(["release"], a)).exitCode).toBe(1);
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  expect((await h.harness.behavior.runCli(["release"], a)).exitCode).toBe(0);
});

test("literal port arguments cannot escape the allocated block", async () => {
  const h = await fixture();
  const start = await h.harness.behavior.runCli(["start", "--name", "wrong port", "--command", "pnpm dev --port 5960"], a);
  expect(start.exitCode).toBe(2);
  expect(start.stderr).toContain("Hard-coded 59xx ports require an explicit --port");
  expect(h.harness.inspection.sdk.callsTo("terminals.create")).toHaveLength(0);
});

test("automatic starts require {port} and reject literal 59xx ports before creating a lease", async () => {
  const h = await fixture();
  for (const command of ["pnpm dev", "pnpm dev --port {port+1}", "pnpm dev --port 5910", "BASE={port} pnpm dev --port 5920", "pnpm dev --host http://localhost:5930 --port {port}"]) {
    const result = await h.harness.behavior.runCli(["start", "--name", "bad allocation", "--command", command], a);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/requires \{port\}|Hard-coded 59xx/);
  }
  expect(await h.bb.storage.kv.list("block:")).toEqual([]);
  expect(h.harness.inspection.sdk.callsTo("terminals.create")).toHaveLength(0);
  const fixed = await h.harness.behavior.runCli(["start", "--name", "explicit", "--port", String(h.base), "--command", `pnpm dev --port ${h.base}`, "--json"], a);
  expect(fixed.exitCode).toBe(0);
  expect(JSON.parse(fixed.stdout).command).toContain("--strictPort");
});
