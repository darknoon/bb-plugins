import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type StartupStatus } from "./contract.js";

const execFileAsync = promisify(execFile);
const LABEL = "app.getbb.startup";
const PORT = 38886;
const MARKER = "BBStartupPluginManaged";
const SYSTEM_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const HANDOFF_WAIT_SECONDS = 30;

function uid(): number {
  if (!process.getuid) throw new Error("A POSIX user id is required");
  return process.getuid();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

async function executable(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

function runtimeNpxPath(): string {
  return path.join(path.dirname(process.execPath), "npx");
}

async function requireRuntimeNpx(): Promise<string> {
  const candidate = runtimeNpxPath();
  const npx = await executable([candidate]);
  if (npx) return npx;
  throw new Error(
    `npx was not found beside bb's Node executable. Checked ${candidate}. `
    + "Start bb with a Node installation that includes npm/npx, then retry.",
  );
}

function paths() {
  const home = os.homedir();
  const startupDir = path.join(home, ".bb", "startup");
  return {
    home,
    startupDir,
    script: path.join(startupDir, "start-bb.sh"),
    handoffScript: path.join(startupDir, "handoff.sh"),
    handoffLog: path.join(home, ".bb", "logs", "startup.handoff.log"),
    keychainStatus: path.join(startupDir, "keychain-status"),
    plist: path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
    stdout: path.join(home, ".bb", "logs", "startup.stdout.log"),
    stderr: path.join(home, ".bb", "logs", "startup.stderr.log"),
  };
}

async function run(file: string, args: string[], timeout = 10_000) {
  return execFileAsync(file, args, { timeout, maxBuffer: 1024 * 1024 });
}

async function launchctlState(): Promise<{ loaded: boolean; pid: number | null }> {
  try {
    const { stdout } = await run("/bin/launchctl", ["print", `gui/${uid()}/${LABEL}`]);
    const pidMatch = stdout.match(/^\s*pid = (\d+)$/m);
    return { loaded: true, pid: pidMatch ? Number(pidMatch[1]) : null };
  } catch {
    return { loaded: false, pid: null };
  }
}

async function runtimeIsManaged(agentPid: number | null): Promise<boolean> {
  if (!agentPid) return false;
  let pid = process.pid;
  for (let depth = 0; depth < 24 && pid > 1; depth += 1) {
    if (pid === agentPid) return true;
    try {
      const { stdout } = await run("/bin/ps", ["-o", "ppid=", "-p", String(pid)]);
      const parent = Number(stdout.trim());
      if (!Number.isInteger(parent) || parent <= 0 || parent === pid) return false;
      pid = parent;
    } catch {
      return false;
    }
  }
  return false;
}

async function readManaged(plist: string): Promise<{ exists: boolean; managed: boolean }> {
  try {
    const contents = await readFile(plist, "utf8");
    return { exists: true, managed: contents.includes(`<key>${MARKER}</key>`) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, managed: false };
    throw error;
  }
}

async function tailscaleStatus() {
  const binary = await executable(["/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
  if (!binary) return { available: false, configured: false, detail: "tailscale CLI not found" };
  try {
    const { stdout, stderr } = await run(binary, ["serve", "status"], 15_000);
    const output = `${stdout}\n${stderr}`.trim();
    const blocks = output.split(/\n\s*\n/);
    const relevant = blocks.find((block) => block.includes(`127.0.0.1:${PORT}`) || block.includes(`localhost:${PORT}`) || block.includes(`:${PORT}`));
    return { available: true, configured: Boolean(relevant), detail: relevant ?? (output || null) };
  } catch (error) {
    return { available: true, configured: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function keychainStatus(file: string) {
  try {
    const result = (await readFile(file, "utf8")).trim();
    if (result === "accessible") return { credentialPresent: true, accessible: true, detail: null };
    if (result === "absent") return { credentialPresent: false, accessible: null, detail: "Claude Code credential was not found" };
    if (result.startsWith("inaccessible:")) {
      return { credentialPresent: true, accessible: false, detail: `LaunchAgent keychain probe exited ${result.slice("inaccessible:".length)}` };
    }
    return { credentialPresent: false, accessible: null, detail: "LaunchAgent keychain probe has not completed" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { credentialPresent: false, accessible: null, detail: "LaunchAgent keychain probe has not run" };
    }
    throw error;
  }
}

async function status(detail: string | null = null): Promise<StartupStatus> {
  const p = paths();
  const files = await readManaged(p.plist);
  const launchctl = process.platform === "darwin" ? await launchctlState() : { loaded: false, pid: null };
  const npx = await executable([runtimeNpxPath()]);
  return {
    supported: process.platform === "darwin",
    platform: process.platform,
    enabled: files.exists && files.managed,
    loaded: launchctl.loaded,
    managed: files.managed,
    runtimeManaged: await runtimeIsManaged(launchctl.pid),
    launchAgentPath: process.platform === "darwin" ? p.plist : null,
    command: npx ? `${npx} --yes bb-app@latest start` : null,
    keychain: await keychainStatus(p.keychainStatus),
    tailscale: await tailscaleStatus(),
    detail: process.platform === "darwin" ? detail : "Automatic startup currently supports macOS LaunchAgents only.",
  };
}

async function atomicWrite(file: string, contents: string, mode: number) {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { encoding: "utf8", mode });
  await chmod(temporary, mode);
  await rename(temporary, file);
}

async function commandExitCode(file: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: "ignore" });
    child.once("error", () => resolve(null));
    child.once("exit", (code) => resolve(code));
  });
}

async function probeKeychain(file: string): Promise<void> {
  const username = os.userInfo().username;
  const query = ["find-generic-password", "-s", "Claude Code-credentials", "-a", username];
  const present = await commandExitCode("/usr/bin/security", query);
  if (present !== 0) {
    await atomicWrite(file, "absent\n", 0o600);
    return;
  }
  const accessible = await commandExitCode("/usr/bin/security", ["find-generic-password", "-w", "-s", "Claude Code-credentials", "-a", username]);
  await atomicWrite(file, accessible === 0 ? "accessible\n" : `inaccessible:${accessible ?? "spawn"}\n`, 0o600);
}

function releaseGuardShell(runtimeFile: string): string {
  return `bb_is_running() {
  if /usr/sbin/lsof -nP -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
    return 0
  fi
  if [[ -f ${shellQuote(runtimeFile)} ]]; then
    runtime_pid=$(/usr/bin/plutil -extract pid raw -o - ${shellQuote(runtimeFile)} 2>/dev/null || true)
    if [[ "$runtime_pid" =~ '^[0-9]+$' ]] && /bin/kill -0 "$runtime_pid" >/dev/null 2>&1; then
      return 0
    fi
  fi
  return 1
}
`;
}

function wrapperScript(npx: string, tailscale: string | null): string {
  const p = paths();
  const username = os.userInfo().username;
  const tailscaleCommand = tailscale ? `${shellQuote(tailscale)} serve --bg ${PORT} || true` : `echo "tailscale CLI not found; skipping Serve reconciliation" >&2`;
  return `#!/bin/zsh
set -u
umask 077

# Managed by the bb Startup plugin. Never writes credential contents.
npx_path=${shellQuote(npx)}
if [[ ! -x "$npx_path" ]]; then
  npx_path=$(/bin/zsh -lic 'command -v npx' 2>/dev/null | /usr/bin/tail -n 1)
fi
if [[ -z "$npx_path" || ! -x "$npx_path" ]]; then
  echo "the configured npx is unavailable and the login shell could not find a replacement" >&2
  exit 127
fi
export PATH="\${npx_path:h}:${SYSTEM_PATH}"

${releaseGuardShell(path.join(p.home, ".bb", "bb-app-runtime.json"))}
while bb_is_running; do
  /bin/sleep 1
done

if /usr/bin/security find-generic-password -s 'Claude Code-credentials' -a ${shellQuote(username)} >/dev/null 2>&1; then
  if /usr/bin/security find-generic-password -w -s 'Claude Code-credentials' -a ${shellQuote(username)} >/dev/null 2>&1; then
    echo accessible > ${shellQuote(p.keychainStatus)}
  else
    probe_exit=$?
    echo "inaccessible:$probe_exit" > ${shellQuote(p.keychainStatus)}
  fi
else
  echo absent > ${shellQuote(p.keychainStatus)}
fi
/bin/chmod 600 ${shellQuote(p.keychainStatus)}

# Let the previous launcher remove its runtime record before claiming it.
/bin/sleep 3
${tailscaleCommand}
exec "$npx_path" --yes bb-app@latest start
`;
}

function launchAgentPlist(p: ReturnType<typeof paths>, nodeDirectory: string): string {
  const environmentPath = xmlEscape(`${nodeDirectory}:${SYSTEM_PATH}`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>${MARKER}</key>
  <true/>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(p.script)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(p.home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(p.home)}</string>
    <key>PATH</key>
    <string>${environmentPath}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(p.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(p.stderr)}</string>
</dict>
</plist>
`;
}

async function enable(): Promise<StartupStatus> {
  if (process.platform !== "darwin") return status();
  const p = paths();
  const existing = await readManaged(p.plist);
  if (existing.exists && !existing.managed) throw new Error(`Refusing to overwrite unmanaged LaunchAgent: ${p.plist}`);
  const npx = await requireRuntimeNpx();
  const tailscale = await executable(["/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
  await mkdir(p.startupDir, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(p.plist), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(p.stdout), { recursive: true, mode: 0o700 });
  await rm(p.handoffScript, { force: true });
  await probeKeychain(p.keychainStatus);
  await atomicWrite(p.script, wrapperScript(npx, tailscale), 0o700);
  await atomicWrite(p.plist, launchAgentPlist(p, path.dirname(process.execPath)), 0o600);
  await run("/usr/bin/plutil", ["-lint", p.plist]);
  await run("/bin/launchctl", ["enable", `gui/${uid()}/${LABEL}`]);
  const launchctl = await launchctlState();
  if (tailscale) {
    try {
      await run(tailscale, ["serve", "--bg", String(PORT)], 20_000);
    } catch {
      // Startup remains valid; status reports the Serve failure.
    }
  }
  return status(launchctl.loaded
    ? "LaunchAgent files updated. The current loaded job remains in place."
    : "LaunchAgent staged. Run the managed handoff or log in again to start it.");
}

async function disable(): Promise<StartupStatus> {
  if (process.platform !== "darwin") return status();
  const p = paths();
  const existing = await readManaged(p.plist);
  if (existing.exists && !existing.managed) throw new Error(`Refusing to remove unmanaged LaunchAgent: ${p.plist}`);
  await run("/bin/launchctl", ["disable", `gui/${uid()}/${LABEL}`]);
  await rm(p.plist, { force: true });
  await rm(p.handoffScript, { force: true });
  const current = await launchctlState();
  if (!current.loaded) {
    await rm(p.script, { force: true });
    await rm(p.keychainStatus, { force: true });
  }
  return status(current.loaded
    ? "Startup is disabled for future logins. The current bb remains managed until this login session ends."
    : "Startup is disabled and managed files were removed.");
}

async function scheduleHandoff(delaySeconds: number) {
  if (process.platform !== "darwin") throw new Error("Managed handoff is supported only on macOS.");
  const p = paths();
  const current = await status();
  if (!current.enabled) throw new Error("Startup is not enabled; run `bb startup enable --no-handoff` first.");
  if (current.keychain.credentialPresent && current.keychain.accessible !== true) {
    throw new Error(`Refusing handoff because the LaunchAgent cannot read the existing Claude credential (${current.keychain.detail ?? "unknown error"}).`);
  }
  const npx = await requireRuntimeNpx();
  const bootstrap = current.loaded
    ? ""
    : `/bin/launchctl bootstrap gui/${uid()} ${shellQuote(p.plist)}\n`;
  const runtimeFile = path.join(p.home, ".bb", "bb-app-runtime.json");
  const script = `#!/bin/zsh
set -u
umask 077
trap '/bin/rm -f "$0"' EXIT
exec >> ${shellQuote(p.handoffLog)} 2>&1
/bin/sleep ${delaySeconds}
if ! ${shellQuote(npx)} --yes bb-app@latest stop; then
  echo "bb-app stop failed; refusing to start a second instance" >&2
  exit 1
fi
${releaseGuardShell(runtimeFile)}
deadline=$((SECONDS + ${HANDOFF_WAIT_SECONDS}))
while bb_is_running && (( SECONDS < deadline )); do
  /bin/sleep 1
done
if bb_is_running; then
  echo "bb did not release port ${PORT} and its runtime record within ${HANDOFF_WAIT_SECONDS} seconds; refusing handoff" >&2
  exit 1
fi
${bootstrap}`;
  await atomicWrite(p.handoffScript, script, 0o700);
  const child = spawn(p.handoffScript, [], { detached: true, stdio: "ignore" });
  child.unref();
  return { scheduled: true, delaySeconds };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    status: () => status(),
    enable: () => enable(),
    disable: () => disable(),
    handoff: ({ delaySeconds }) => scheduleHandoff(delaySeconds),
  },
});
