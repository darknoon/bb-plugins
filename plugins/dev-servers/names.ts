import { z } from "zod";

export const MAX_SERVER_NAME = 24;
export const serverNameSchema = z.string().trim()
  .min(1, "Server name cannot be empty")
  .refine((name) => Array.from(name).length <= MAX_SERVER_NAME, "Server name must be at most 24 characters")
  .refine((name) => !/[\u0000-\u001f\u007f]/u.test(name), "Server name must be a single line without control characters");

export function shortServerName(value: string) {
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim())
    .slice(0, MAX_SERVER_NAME).join("").trimEnd() || "dev server";
}

export function defaultServerName(options: { threadTitle?: string | null; projectName?: string | null; cwd?: string; command?: string | null }) {
  if (options.threadTitle?.trim()) return shortServerName(options.threadTitle);
  const project = options.projectName || options.cwd?.replace(/\/+$/, "").split("/").pop() || "server";
  const script = options.command?.match(/\b(?:pnpm|npm|yarn|bun)\s+(?:(?:run|exec)\s+)?([a-zA-Z][\w:-]*)/u)?.[1]
    ?? (/\bharbor\s+view\b/u.test(options.command ?? "") ? "viewer" : "dev");
  return shortServerName(`${project} ${script}`);
}
