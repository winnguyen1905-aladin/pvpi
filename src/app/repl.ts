import { createInterface } from "node:readline";

export interface Command {
  help: string;
  run: (args: string[]) => void | Promise<void>;
}

// Interactive command loop over stdin. Commands are serialized so async handlers
// never overlap; on EOF (pipe closed), Ctrl-C, or `quit` we run the optional
// onExit hook (e.g. release the Redis lock) before exiting.
export function startRepl(prompt: string, commands: Record<string, Command>, onExit?: () => Promise<void> | void): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt });

  let exiting = false;
  async function shutdown(): Promise<void> {
    if (exiting) return;
    exiting = true;
    try {
      await onExit?.();
    } catch {
      /* best-effort cleanup */
    }
    process.exit(0);
  }

  const all: Record<string, Command> = { ...commands };
  all.help = {
    help: "list commands",
    run: () => {
      for (const [name, c] of Object.entries(all)) console.log(`  ${name.padEnd(14)} ${c.help}`);
    },
  };
  all.quit = { help: "stop this process (releases the Redis lock)", run: () => shutdown() };

  const queue: string[] = [];
  let draining = false;
  let closed = false;

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const parts = queue.shift()!.trim().split(/\s+/).filter(Boolean);
      const name = parts[0];
      if (name) {
        const cmd = all[name];
        if (!cmd) {
          console.log(`unknown command: ${name} (try 'help')`);
        } else {
          try {
            await cmd.run(parts.slice(1));
          } catch (e: any) {
            console.log(`error: ${e?.message ?? e}`);
          }
        }
      }
    }
    draining = false;
    if (closed) {
      void shutdown();
      return;
    }
    rl.prompt();
  }

  rl.prompt();
  rl.on("line", (line) => {
    queue.push(line);
    void drain();
  });
  rl.on("SIGINT", () => void shutdown());
  rl.on("close", () => {
    closed = true;
    if (!draining) void shutdown();
  });
}
