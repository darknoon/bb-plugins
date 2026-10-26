// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
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
    sdk: { threads: { experimental_listDescendants: async () => ({ threads: [{ threadId: "thread", descendantIds: [] }] }) } },
    ...extra, rpc: { list: async () => ({ servers: await list(), scannedAt: Date.now() }) },
  });
  cleanups.push(slot.lifecycle.unmount);
  return slot;
}
async function actions(slot: Awaited<ReturnType<typeof mount>>, name: string) {
  fireEvent.keyDown(slot.getByRole("button", { name: `Actions for ${name}` }), { key: "ArrowDown" });
  await screen.findByRole("menu");
}

test("the native Info section shares the preview tab with the existing New tab action", async () => {
  const definition = await loadPluginApp(app);
  expect(definition.threadInfoSections).toMatchObject([{ id: "dev-servers", group: "1_related", order: 0 }]);
  expect(definition.tabs).toEqual(expect.arrayContaining([expect.objectContaining(DEV_SERVER_TAB)]));
  const slot = await mount(() => [server()]);
  await slot.findByRole("region", { name: "Dev Servers" });
  expect(slot.getByText(":5910")).toBeDefined();
  fireEvent.click(slot.getByRole("button", { name: "icon grader" }));
  expect(slot.inspection.experimental_tabOpenCalls).toEqual([{
    surface: { kind: "current" }, tab: DEV_SERVER_TAB, params: { environmentId: "env", port: 5910 }, title: "icon grader · :5910",
  }]);
  await actions(slot, "icon grader");
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy URL" }));
  await waitFor(() => expect(slot.inspection.experimental_clipboardWrites).toEqual([{ text: "https://fixture.example.ts.net:5910/" }]));
  expect(slot.inspection.navigateCalls.filter((call) => call.method === "toThread")).toEqual([]);
});

test("Info only shows this environment, including another thread sharing the same checkout", async () => {
  const slot = await mount(() => [server({ name: "other checkout", environmentId: "foreign" }), server({ name: "shared checkout", threadIds: ["other-thread"], thread: { id: "other-thread", title: "Shared" } })]);
  await slot.findByRole("button", { name: "shared checkout" });
  expect(slot.queryByText("other checkout")).toBeNull();
  expect(slot.inspection.rpcCalls[0]).toMatchObject({ method: "list", input: { projectId: null } });
});

test("a thread without a usable environment makes no discovery request and an empty environment hides its section", async () => {
  const definition = await loadPluginApp(app);
  const noEnvironment = renderSlot(definition.threadInfoSections[0]!, { ...props, environment: null }, {
    sdk: { threads: { experimental_listDescendants: async () => ({ threads: [{ threadId: "thread", descendantIds: [] }] }) } },
  });
  cleanups.push(noEnvironment.lifecycle.unmount);
  await act(async () => {});
  expect(noEnvironment.inspection.rpcCalls).toEqual([]);
  expect(noEnvironment.queryByRole("region", { name: "Dev Servers" })).toBeNull();
  const empty = await mount(() => []);
  await waitFor(() => expect(empty.inspection.rpcCalls).toHaveLength(1));
  expect(empty.queryByRole("region", { name: "Dev Servers" })).toBeNull();
});

test("a live local app without a secure URL stays observable but cannot open or copy a broken preview", async () => {
  const slot = await mount(() => [server({ tailnetUrl: null })]);
  await slot.findByText("icon grader");
  expect(slot.queryByRole("button", { name: "icon grader" })).toBeNull();
  await actions(slot, "icon grader");
  expect(screen.getByRole("menuitem", { name: "Copy URL" }).getAttribute("aria-disabled")).toBe("true");
});

test("a discovery failure is observable and Retry restores the list", async () => {
  let fail = true;
  const slot = await mount(() => { if (fail) throw new Error("offline"); return [server()]; });
  await slot.findByText("Couldn’t check dev servers.");
  fail = false;
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  await slot.findByRole("button", { name: "icon grader" });
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

const children = (...ids: string[]): Parameters<typeof renderSlot>[2] => ({
  sdk: { threads: { experimental_listDescendants: async () => ({ threads: [{ threadId: "thread", descendantIds: ids }] }) } },
});

test("parent Info uses one compact list with child labels, preview actions and child navigation in the menu", async () => {
  const child = server({ name: "canvas", environmentId: "child-env", port: 5920, thread: { id: "child", title: "Canvas viewer" } });
  const nested = server({ name: "api", projectId: "another-project", environmentId: "nested-env", port: 5930, thread: { id: "nested", title: "API work" } });
  const sibling = server({ name: "unrelated", environmentId: "sibling-env", port: 5940, thread: { id: "sibling", title: "Other work" } });
  const slot = await mount(() => [sibling, nested, child, server()], children("child", "nested"));
  await slot.findByRole("button", { name: "canvas" });
  expect(slot.getByRole("button", { name: "api" })).toBeDefined();
  expect(slot.getAllByText("child")).toHaveLength(2);
  expect(slot.queryByText("Canvas viewer")).toBeNull();
  expect(slot.queryByText("unrelated")).toBeNull();
  const lists = slot.getAllByRole("list");
  expect(lists).toHaveLength(1);
  expect(lists[0].textContent).toContain("icon grader");
  fireEvent.click(slot.getByRole("button", { name: "canvas" }));
  expect(slot.inspection.experimental_tabOpenCalls[0]).toMatchObject({ surface: { kind: "current" }, params: { environmentId: "child-env", port: 5920 } });
  expect(slot.inspection.navigateCalls.filter((call) => call.method === "toThread")).toHaveLength(0);
  await actions(slot, "canvas");
  expect(screen.getByText("Canvas viewer")).toBeDefined();
  fireEvent.click(screen.getByRole("menuitem", { name: "Open child thread Canvas viewer" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "child" });
});

test("a child sharing the parent's checkout is labeled once, with one server in the count", async () => {
  const child = server({ thread: { id: "child", title: "Shared child" } });
  const slot = await mount(() => [child, child], children("child"));
  await slot.findByText("child");
  expect(slot.getAllByRole("button", { name: "icon grader" })).toHaveLength(1);
  expect(slot.getByRole("heading", { name: "Dev Servers 1" })).toBeDefined();
});

test("an orchestration parent without its own environment still shows its children's servers", async () => {
  const definition = await loadPluginApp(app);
  const slot = renderSlot(definition.threadInfoSections[0]!, { ...props, environment: null }, {
    ...children("child"), rpc: { list: () => ({ servers: [server({ environmentId: "child-env", thread: { id: "child", title: "Child checkout" } })], scannedAt: Date.now() }) },
  });
  cleanups.push(slot.lifecycle.unmount);
  await slot.findByText("child");
  expect(slot.getByText("icon grader")).toBeDefined();
});

test("polling removes a child's group when it is no longer in this parent's subtree", async () => {
  vi.useFakeTimers();
  let descendantIds = ["child"];
  const slot = await mount(() => [server({ environmentId: "child-env", thread: { id: "child", title: "Reparented" } })], {
    sdk: { threads: { experimental_listDescendants: async () => ({ threads: [{ threadId: "thread", descendantIds }] }) } },
  });
  await act(async () => {});
  expect(slot.getByText("child")).toBeDefined();
  descendantIds = [];
  await act(async () => { await vi.advanceTimersByTimeAsync(INFO_REFRESH_MS); });
  expect(slot.queryByRole("region", { name: "Dev Servers" })).toBeNull();
});

test("a child does not inherit its parent's or sibling's servers", async () => {
  const slot = await mount(() => [server({ name: "parent app", environmentId: "parent-env", thread: { id: "parent", title: "Parent" } }),
    server({ name: "sibling app", environmentId: "sibling-env", thread: { id: "sibling", title: "Sibling" } }), server()]);
  await slot.findByText("icon grader");
  expect(slot.queryByText("parent app")).toBeNull();
  expect(slot.queryByText("sibling app")).toBeNull();
});

test("unmount during subtree lookup prevents an obsolete scan from starting", async () => {
  let finish!: (result: { threads: Array<{ threadId: string; descendantIds: string[] }> }) => void;
  const slot = await mount(() => [server()], {
    sdk: { threads: { experimental_listDescendants: () => new Promise((resolve) => { finish = resolve; }) } },
  });
  slot.lifecycle.unmount();
  await act(async () => { finish({ threads: [{ threadId: "thread", descendantIds: ["child"] }] }); });
  expect(slot.inspection.rpcCalls).toEqual([]);
});
