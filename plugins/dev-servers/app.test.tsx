// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { fireEvent, within, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import app from "./app";
import { persistentInputSchema, type PersistentServer } from "./persistent";

let unmount: (() => void) | undefined;
afterEach(() => { unmount?.(); unmount = undefined; });
function viewer(): PersistentServer {
  return { ...persistentInputSchema.parse({ name: "harbor", cwd: "/durable", command: "harbor view --port 5995", port: 5995 }),
    state: "running", pid: 42, startedAt: Date.now() - 65_000, uptimeMs: 65_000, restartAt: null,
    failures: 0, lastExit: { at: Date.now(), code: 42, signal: null, reason: "Process exited" },
    healthResult: { healthy: true, checkedAt: Date.now(), message: "Expected Harbor response" },
    tailnetUrl: "https://fixture.example.ts.net:5995/", logs: [{ at: Date.now(), stream: "stdout", line: "ready" }] };
}

test("left nav shows both sections, observable status and controls without a thread", async () => {
  const definition = await loadPluginApp(app);
  let server = viewer();
  const controls: string[] = [];
  const slot = renderSlot(definition.navPanels[0]!, { subPath: "" }, { rpc: {
    list: () => ({ servers: [], scannedAt: Date.now() }),
    persistentList: () => ({ servers: [server] }),
    persistentControl: (input: any) => { controls.push(input.action); server = { ...server, enabled: input.action !== "stop", state: input.action === "stop" ? "stopped" : "starting" }; return { ok: true }; },
  } });
  unmount = slot.lifecycle.unmount;
  await slot.findByText("harbor");
  expect(slot.getByText("Persistent servers")).toBeDefined();
  expect(slot.getByText("Thread dev servers")).toBeDefined();
  expect(slot.getByText("running")).toBeDefined();
  expect(slot.getByText(/Uptime 1m/)).toBeDefined();
  expect(slot.getByText(/Last exit: code 42/)).toBeDefined();
  fireEvent.click(slot.getByRole("button", { name: "Restart" }));
  await waitFor(() => expect(controls).toEqual(["restart"]));
  await waitFor(() => expect((slot.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(slot.getByRole("button", { name: "Stop" }));
  await slot.findByRole("button", { name: "Start" });
  fireEvent.click(slot.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(controls).toEqual(["restart", "stop", "start"]));
  fireEvent.click(slot.getByText("Details and recent logs"));
  expect(slot.getByText(/\[stdout\] ready/)).toBeDefined();
});

test("promotion asks for durable working directory and a new fixed port then registers the reviewed command", async () => {
  const definition = await loadPluginApp(app);
  const threadServer = { projectId: "p", projectName: "Canvas", environmentId: "env", environmentName: "worktree", branchName: "feature", path: "/disposable/worktree",
    port: 5910, pid: 10, processName: "node", command: "npm run dev -- --port 5910", connectUrl: null, tailnetUrl: null,
    threadIds: ["thread"], thread: { id: "thread", title: "Canvas thread" }, terminal: null, association: "managed" };
  const added: unknown[] = [];
  const slot = renderSlot(definition.navPanels[0]!, { subPath: "" }, { rpc: {
    list: () => ({ servers: [threadServer], scannedAt: Date.now() }), persistentList: () => ({ servers: [] }),
    persistentAdd: (input: any) => { added.push(input); return viewer(); },
  } });
  unmount = slot.lifecycle.unmount;
  fireEvent.click(await slot.findByRole("button", { name: "Promote" }));
  const form = within(slot.getByRole("form", { name: "Promote to persistent server" }));
  const cwd = form.getByLabelText("Working directory on this machine") as HTMLInputElement;
  expect(cwd.value).toBe("");
  expect((form.getByLabelText("Fixed port") as HTMLInputElement).value).toBe("5901");
  expect((form.getByLabelText("Command") as HTMLTextAreaElement).value).toContain("{port}");
  fireEvent.change(cwd, { target: { value: "/durable/canvas" } });
  fireEvent.submit(slot.getByRole("form"));
  await waitFor(() => expect(added).toHaveLength(1));
  expect(added[0]).toMatchObject({ cwd: "/durable/canvas", port: 5901, command: "npm run dev -- --port {port}", enabled: true });
});
