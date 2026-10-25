export const DEV_SERVER_TAB = {
  id: "dev-server",
  context: { kind: "thread" },
  availability: "action",
} as const;

export type Server = {
  name: string;
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  branchName: string | null;
  path: string;
  port: number;
  pid: number;
  processName: string;
  command: string | null;
  connectUrl: string | null;
  tailnetUrl: string | null;
  threadIds: string[];
  thread: { id: string; title: string } | null;
  terminal: { id: string; title: string; status: string } | null;
  association: "managed" | "inferred" | "external";
};

export function serverIdentity(server: Server) {
  return { environmentId: server.environmentId, port: server.port };
}

export function serverTitle(server: Server) {
  return `${server.name} · :${server.port}`;
}

export function serverUrl(server: Server) {
  const isTailnetOrigin = window.location.protocol === "https:"
    && window.location.hostname.endsWith(".ts.net");
  return isTailnetOrigin && server.tailnetUrl
    ? server.tailnetUrl
    : server.connectUrl ?? server.tailnetUrl;
}
