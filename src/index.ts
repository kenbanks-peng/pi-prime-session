import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runPrimeCommand } from "./prime-command.js";
import { PrimeRepository } from "./prime-repository.js";

export function createPrimeRepository(cwd: string, home = homedir()): PrimeRepository {
  return new PrimeRepository({
    globalDirectory: join(home, ".agents", "prime"),
    projectDirectory: join(cwd, ".agents", "prime"),
  });
}

export default function primeExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const primes = await createPrimeRepository(ctx.cwd).compose();
    if (!primes) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n## Primes\n\n${primes}`,
    };
  });

  pi.registerCommand("prime", {
    description: "Add, list, edit, and delete Global and Project Primes",
    handler: async (args, ctx) => {
      await runPrimeCommand(args, createPrimeRepository(ctx.cwd), {
        hasUI: ctx.hasUI,
        editor: ctx.ui.editor.bind(ctx.ui),
        notify: ctx.ui.notify.bind(ctx.ui),
      });
    },
  });
}
