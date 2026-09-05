import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const tailscaleStatusSchema = z.object({
  available: z.boolean(),
  configured: z.boolean(),
  detail: z.string().nullable(),
}).strict();

const keychainStatusSchema = z.object({
  credentialPresent: z.boolean(),
  accessible: z.boolean().nullable(),
  detail: z.string().nullable(),
}).strict();

export const startupStatusSchema = z.object({
  supported: z.boolean(),
  platform: z.string(),
  enabled: z.boolean(),
  loaded: z.boolean(),
  managed: z.boolean(),
  runtimeManaged: z.boolean(),
  launchAgentPath: z.string().nullable(),
  command: z.string().nullable(),
  keychain: keychainStatusSchema,
  tailscale: tailscaleStatusSchema,
  detail: z.string().nullable(),
}).strict();

export const uiStatusSchema = z.object({
  hostId: z.string(),
  status: startupStatusSchema,
}).strict();

const activeThreadSchema = z.object({
  id: z.string(),
  title: z.string(),
  providerId: z.string(),
  status: z.enum(["active", "starting", "stopping"]),
}).strict();

export const hostContract = defineRpcContract({
  status: { input: z.null(), output: startupStatusSchema },
  enable: { input: z.null(), output: startupStatusSchema },
  disable: { input: z.null(), output: startupStatusSchema },
  handoff: {
    input: z.object({ delaySeconds: z.number().int().min(1).max(60) }).strict(),
    output: z.object({ scheduled: z.boolean(), delaySeconds: z.number().int() }).strict(),
  },
});

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: uiStatusSchema },
  enable: { input: z.null(), output: uiStatusSchema },
  disable: { input: z.null(), output: uiStatusSchema },
  handoff: {
    input: z.object({ allowActive: z.boolean() }).strict(),
    output: z.object({
      hostId: z.string(),
      scheduled: z.boolean(),
      delaySeconds: z.number().int(),
      activeThreads: z.array(activeThreadSchema),
    }).strict(),
  },
});

export type StartupStatus = z.infer<typeof startupStatusSchema>;
export type ActiveThread = z.infer<typeof activeThreadSchema>;
