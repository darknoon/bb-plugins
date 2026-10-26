import type { Server } from "./servers";

export type ServerGroup = { thread: { id: string; title: string } | null; servers: Server[] };

export function relatedServerGroups(servers: Server[], environmentId: string | null, descendantIds: Set<string>): ServerGroup[] {
  const current: ServerGroup = { thread: null, servers: [] };
  const children = new Map<string, ServerGroup>();
  const seen = new Set<string>();
  for (const server of servers) {
    const key = `${server.environmentId}:${server.port}`;
    if (seen.has(key)) continue;
    // A child sharing this checkout keeps its child label; do not also list
    // that same listener among the parent's environment servers.
    if (server.thread && descendantIds.has(server.thread.id)) {
      const group = children.get(server.thread.id) ?? { thread: server.thread, servers: [] };
      group.servers.push(server);
      children.set(server.thread.id, group);
    } else if (server.environmentId === environmentId) {
      current.servers.push(server);
    } else continue;
    seen.add(key);
  }
  const groups = [current, ...[...children.values()].sort((a, b) => a.thread!.title.localeCompare(b.thread!.title) || a.thread!.id.localeCompare(b.thread!.id))]
    .filter((group) => group.servers.length);
  for (const group of groups) group.servers.sort((a, b) => a.port - b.port);
  return groups;
}
