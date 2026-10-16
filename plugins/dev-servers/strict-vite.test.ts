import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strictViteCommand } from "./strict-vite";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function project(scripts: Record<string, string>) {
  const cwd = await mkdtemp(join(tmpdir(), "bb-strict-vite-")); dirs.push(cwd);
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts }));
  return cwd;
}

test("Vite commands and package scripts get strictPort while other server CLIs keep their arguments", async () => {
  const cwd = await project({ dev: "vite", nested: "pnpm run dev", next: "next dev", worker: "wrangler dev", cycle: "pnpm run cycle" });
  for (const command of ["vite --port {port}", "npx vite --port {port}", "pnpm exec vite --port {port}", "pnpm dev --port {port}", "bun dev --port {port}", "yarn dev --port {port}", "pnpm nested --port {port}"]) {
    expect(await strictViteCommand(command, cwd)).toBe(`${command} --strictPort`);
  }
  expect(await strictViteCommand("npm run dev", cwd)).toBe("npm run dev -- --strictPort");
  expect(await strictViteCommand("npm run dev -- --port {port}", cwd)).toBe("npm run dev -- --port {port} --strictPort");
  for (const command of ["pnpm next --port {port}", "pnpm worker --port {port}", "python3 -m http.server {port}", "harbor view --port {port}", "echo vite", "pnpm cycle", "pnpm unknown", "vite build", "pnpm exec vite build"]) {
    expect(await strictViteCommand(command, cwd)).toBe(command);
  }
});

test("literal cd, env prefixes, quoted paths, and compound commands preserve their shell meaning", async () => {
  const cwd = await project({ dev: "echo prepare && vite", tail: "vite && echo complete" });
  const child = join(cwd, "nested project"); await mkdir(child);
  await writeFile(join(child, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  const command = `cd 'nested project' && ACCOUNT=example pnpm dev --host 127.0.0.1; echo done`;
  expect(await strictViteCommand(command, cwd)).toBe(`cd 'nested project' && ACCOUNT=example pnpm dev --host 127.0.0.1 --strictPort; echo done`);
  expect(await strictViteCommand("pnpm dev --port {port}", cwd)).toContain("--strictPort");
  expect(await strictViteCommand("pnpm tail", cwd)).toBe("pnpm tail");
  expect(await strictViteCommand("exec node '/some project/node_modules/vite/bin/vite.js' --port {port}", null)).toBe("exec node '/some project/node_modules/vite/bin/vite.js' --port {port} --strictPort");
});

test("strictPort cannot be disabled and complex shell syntax requires an explicit flag", async () => {
  for (const flag of ["--no-strictPort", "--strictPort=false", "--strictPort false"]) {
    await expect(strictViteCommand(`vite ${flag}`, null)).rejects.toThrow("require --strictPort");
  }
  for (const command of ["vite --port {port} > log", "vite --port {port} | cat", "vite --port {port} # comment"]) {
    await expect(strictViteCommand(command, null)).rejects.toThrow("explicitly");
  }
  for (const command of ["vite --strictPort --port {port}", "vite --strictPort=true", "vite --strictPort > log", "vite --strictPort # comment"]) {
    expect(await strictViteCommand(command, null)).toBe(command);
  }
});
