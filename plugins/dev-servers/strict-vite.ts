import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

type Word = { value: string; start: number; end: number; operator: boolean };
// Read literal shell words without evaluating substitutions or rewriting their
// quoting. Edits only insert a flag at the end of an identified invocation.
function words(command: string): Word[] {
  const pattern = /(?:'(?:[^']*)'|"(?:\\.|[^"\\])*"|\\.|[^\s;&|<>()`'"\\])+|&&|\|\||[;&|<>()`]/g;
  return Array.from(command.matchAll(pattern), (m) => ({
    value: m[0].replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/g, (_m, single, double, escaped) => single ?? double ?? escaped),
    start: m.index!, end: m.index! + m[0].length, operator: /^(?:&&|\|\||[;&|<>()`])$/.test(m[0]),
  }));
}
const dynamic = (value: string) => /[$`]/.test(value);
const serves = (args: string[]) => !["build", "optimize", "--help", "--version", "-h", "-v"].includes(args[0]);

async function viteInvocation(tokens: Word[], cwd: string | null, depth = 0): Promise<boolean> {
  if (depth > 4) return false;
  const args = tokens.map((t) => t.value);
  while (args[0] === "exec" || args[0] === "env" || /^[A-Za-z_]\w*=/.test(args[0] ?? "")) args.shift();
  const executable = basename(args.shift() ?? "");
  if (executable === "vite" || executable === "vite.js") return serves(args);
  if (["node", "bun"].includes(executable) && /(?:^|\/)vite\/bin\/vite\.js$/.test(args[0] ?? "")) return serves(args.slice(1));
  if (["npx", "bunx"].includes(executable)) return args[0] === "vite" && serves(args.slice(1));
  if (!["npm", "pnpm", "yarn", "bun"].includes(executable)) return false;
  const mode = args[0];
  if (["exec", "dlx", "x"].includes(mode)) {
    args.shift();
    if (args[0] === "--") args.shift();
    return args[0] === "vite" && serves(args.slice(1));
  }
  if (mode === "vite") return executable !== "npm" && serves(args.slice(1));
  if (mode === "run" || mode === "run-script") args.shift();
  else if (executable === "npm") return false;
  const script = args[0];
  if (!cwd || !script || dynamic(script)) return false;
  let pkg: { scripts?: Record<string, string> };
  try { pkg = JSON.parse(await readFile(resolve(cwd, "package.json"), "utf8")); }
  catch { return false; }
  const body = pkg.scripts?.[script];
  if (typeof body !== "string") return false;
  const scriptWords = words(body);
  // Package managers append forwarded arguments to the last command in a
  // script. A wrapper that doesn't forward to Vite needs an explicit flag.
  let lastOperator = -1;
  for (let i = 0; i < scriptWords.length; i++) if (scriptWords[i].operator) lastOperator = i;
  return viteInvocation(scriptWords.slice(lastOperator + 1), cwd, depth + 1);
}

export async function strictViteCommand(command: string, cwd: string | null): Promise<string> {
  const tokens = words(command);
  const insertions: Array<{ at: number; text: string }> = [];
  let segment: Word[] = [];
  for (let i = 0; i <= tokens.length; i++) {
    const token = tokens[i];
    if (token && !token.operator) { segment.push(token); continue; }
    if (segment[0]?.value === "cd" && segment.length === 2 && !dynamic(segment[1].value) && cwd) {
      cwd = resolve(cwd, segment[1].value);
    } else if (segment.length && await viteInvocation(segment, cwd)) {
      const flags = segment.map((word) => word.value);
      const comment = flags.findIndex((flag) => flag.startsWith("#"));
      if (comment >= 0) {
        if (!flags.slice(0, comment).some((flag) => flag === "--strictPort" || flag === "--strictPort=true")) throw new Error("Put --strictPort explicitly before an inline comment in a managed Vite command.");
        flags.splice(comment);
      }
      if (flags.some((flag, index) => flag === "--no-strictPort" || flag === "--strictPort=false" || (flag === "--strictPort" && flags[index + 1] === "false"))) {
        throw new Error("Managed Vite servers require --strictPort; remove the option that disables it.");
      }
      if (!flags.some((flag) => flag === "--strictPort" || flag.startsWith("--strictPort="))) {
        if (token && !["&&", "||", ";"].includes(token.value)) throw new Error("Put --strictPort explicitly inside a Vite command that uses pipes, redirection or a subshell.");
        const npm = flags.findIndex((flag) => basename(flag) === "npm");
        const needsSeparator = npm >= 0 && !flags.slice(npm + 1).includes("--");
        insertions.push({ at: segment[segment.length - 1].end, text: `${needsSeparator ? " --" : ""} --strictPort` });
      }
    }
    segment = [];
    // Complex subshells/redirections cannot be classified safely here.
    if (token && !["&&", "||", ";"].includes(token.value)) break;
  }
  for (const insertion of insertions.reverse()) command = command.slice(0, insertion.at) + insertion.text + command.slice(insertion.at);
  return command;
}
