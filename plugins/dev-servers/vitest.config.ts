import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { fileParallelism: false, testTimeout: 15_000, hookTimeout: 15_000 },
});
