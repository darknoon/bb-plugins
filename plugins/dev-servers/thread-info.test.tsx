// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import app from "./app";
import { DEV_SERVER_TAB, type Server } from "./servers";
import { INFO_REFRESH_MS } from "./thread-info";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach((dispose) => dispose()); vi.useRealTimers(); vi.restoreAllMocks(); });
const props = { threadId: "thread", projectId: "project", environment: { id: "env" } };
function server(overrides: Partial<Server> = {}): Server {
  return { name: "icon grader", projectId: "project", projectName: "Icons", environmentId: "env", environmentName: "checkout", branchName: "main", path: "/icons", port: 5910, pid: 42,
    processName: "node", command: "vite", connectUrl: null, tailnetUrl: "https://fixture.example.ts.net:5910/", threadIds: ["thread"], thread: { id: "thread", title: "Icons" }, terminal: null, association: "managed", ...overrides };
}
async function mount(list: () => Promise<Server[]> | Server[], extra: Parameters<typeof renderSlot>[2] = {}) {
  const definition = await loadPluginApp(app);
  const slot = renderSlot(definition.threadInfoSections[0]!, props, {
    ...extra, rpc: { list: async () => ({ servers: await list(), scannedAt: Date.now() }) },
  });
  cleanups.push(slot.lifecycle.unmount);
  return slot;
}

test("the native Info section shares the preview tab with the existing New tab action", async () => {
  const definition = await loadPluginApp(app);
  expect(definition.threadInfoSections).toMatchObject([{ id: "dev-servers", group: "1_related", order: 0 }]);
  expect(definition.tabs).toEqual(expect.arrayContaining([expect.objectContaining(DEV_SERVER_TAB)]));
  const slot = await mount(() => [server()]);
  await slot.findByRole("region", { name: "Dev Servers" });
  expect(slot.getByText(":5910")).toBeDefined();
  fireEvent.click(slot.getByRole("button", { name: "Open icon grader preview" }));
  expect(slot.inspection.experimental_tabOpenCalls).toEqual([{
    surface: { kind: "current" }, tab: DEV_SERVER_TAB, params: { environmentId: "env", port: 5910 }, title: "icon grader · :5910",
  }]);
  fireEvent.click(slot.getByRole("button", { name: "Copy icon grader URL" }));
  await waitFor(() => expect(slot.inspection.experimental_clipboardWrites).toEqual([{ text: "https://fixture.example.ts.net:5910/" }]));
  expect(slot.inspection.navigateCalls.filter((call) => call.method === "toThread")).toEqual([]);
});

test("Info only shows this environment, including another thread sharing the same checkout", async () => {
  const slot = await mount(() => [server({ name: "other checkout", environmentId: "foreign" }), server({ name: "shared checkout", threadIds: ["other-thread"], thread: { id: "other-thread", title: "Shared" } })]);
  await slot.findByRole("button", { name: "shared checkout" });
  expect(slot.queryByText("other checkout")).toBeNull();
  expect(slot.inspection.rpcCalls[0]).toMatchObject({ method: "list", input: { projectId: "project" } });
});

test("a thread without a usable environment makes no discovery request and an empty environment hides its section", async () => {
  const definition = await loadPluginApp(app);
  const noEnvironment = renderSlot(definition.threadInfoSections[0]!, { ...props, environment: null });
  cleanups.push(noEnvironment.lifecycle.unmount);
  expect(noEnvironment.inspection.rpcCalls).toEqual([]);
  expect(noEnvironment.queryByRole("region", { name: "Dev Servers" })).toBeNull();
  const empty = await mount(() => []);
  await waitFor(() => expect(empty.inspection.rpcCalls).toHaveLength(1));
  expect(empty.queryByRole("region", { name: "Dev Servers" })).toBeNull();
});

test("a live local app without a secure URL stays observable but cannot open or copy a broken preview", async () => {
  const slot = await mount(() => [server({ tailnetUrl: null })]);
  await slot.findByText("icon grader");
  expect((slot.getByRole("button", { name: "Open icon grader preview" }) as HTMLButtonElement).disabled).toBe(true);
  expect((slot.getByRole("button", { name: "Copy icon grader URL" }) as HTMLButtonElement).disabled).toBe(true);
});

test("a discovery failure is observable and Retry restores the list", async () => {
  let fail = true;
  const slot = await mount(() => { if (fail) throw new Error("offline"); return [server()]; });
  await slot.findByText("Couldn’t check dev servers.");
  fail = false;
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  await slot.findByRole("button", { name: "Open icon grader preview" });
  expect(slot.queryByRole("status")).toBeNull();
});

test("polling follows server start and stop and unmount cancels further discovery", async () => {
  vi.useFakeTimers();
  let servers = [server()];
  const slot = await mount(() => servers);
  await act(async () => {});
  expect(slot.getByText("icon grader")).toBeDefined();
  servers = [];
  await act(async () => { await vi.advanceTimersByTimeAsync(INFO_REFRESH_MS); });
  expect(slot.queryByRole("region", { name: "Dev Servers" })).toBeNull();
  servers = [server({ name: "restarted" })];
  await act(async () => { await vi.advanceTimersByTimeAsync(INFO_REFRESH_MS); });
  expect(slot.getByText("restarted")).toBeDefined();
  slot.lifecycle.unmount();
  const calls = slot.inspection.rpcCalls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(INFO_REFRESH_MS * 3); });
  expect(slot.inspection.rpcCalls).toHaveLength(calls);
});
