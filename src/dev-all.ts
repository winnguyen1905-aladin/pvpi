// One-terminal launcher for the presentation: starts A, B, C (headless — no REPL,
// driven by the web UI over HTTP) and the static `web/` server, as managed child
// processes. Redis must already be up (npm run redis:up).
//   npm run web
// Ports/redis follow the usual env: AGG_PORT / TRAINER_PORTS / REDIS_URL / PRESENT_PORT.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

const STRIP = "--experimental-strip-types";

interface Def {
  tag: string;
  args: string[];
}
const defs: Def[] = [
  { tag: "A  ", args: ["src/main.ts", "agg"] },
  { tag: "B  ", args: ["src/main.ts", "trainer", "B"] },
  { tag: "C  ", args: ["src/main.ts", "trainer", "C"] },
  { tag: "web", args: ["src/present.ts"] },
];

const kids: ChildProcess[] = [];
for (const d of defs) {
  const child = spawn(process.execPath, [STRIP, ...d.args], {
    env: { ...process.env, NO_REPL: "1" }, // headless: no REPL, just serve
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `[${d.tag}] `;
  child.stdout.on("data", (b: Buffer) => process.stdout.write(prefix + b.toString().replace(/\n(?=.)/g, "\n" + prefix)));
  child.stderr.on("data", (b: Buffer) => process.stderr.write(prefix + b.toString().replace(/\n(?=.)/g, "\n" + prefix)));
  child.on("exit", (code) => process.stdout.write(`${prefix}exited (${code})\n`));
  kids.push(child);
}

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  for (const k of kids) {
    try {
      k.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log("Started A, B, C (headless) + presentation. Redis must be up (npm run redis:up). Ctrl-C to stop.");
console.log("Open the page on the present server's port (default http://localhost:8080).");
