import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runPrimeCommand } from "./prime-command.js";
import { CommandSourceError } from "./prime-protocol.js";
import { PrimeRepository } from "./prime-repository.js";

export function createPrimeRepository(cwd: string, home = homedir()): PrimeRepository {
  return new PrimeRepository({
    globalDirectory: join(home, ".agents", "share", "prime"),
    projectDirectory: join(cwd, ".agents", "prime"),
  });
}

export default function primeExtension(
  pi: ExtensionAPI,
  repositoryFor: (cwd: string) => PrimeRepository = createPrimeRepository,
): void {
  pi.on("session_start", async (_event, ctx) => {
    try {
      const primes = await repositoryFor(ctx.cwd).compose();
      if (!primes) return;

      pi.sendMessage({
        customType: "prime_session",
        content: primes,
        display: false,
      });
    } catch (error) {
      if (error instanceof CommandSourceError) {
        ctx.ui.notify(`${error.sourceName} had an error.`, "error");
        return;
      }
      throw error;
    }
  });

  pi.on("context", (event) => {
    const primeMessages = event.messages.filter(
      (message) => message.role === "custom" && message.customType === "prime_session",
    );
    if (primeMessages.length === 0) return;

    return {
      messages: [
        ...primeMessages,
        ...event.messages.filter(
          (message) => message.role !== "custom" || message.customType !== "prime_session",
        ),
      ],
    };
  });

  pi.registerCommand("prime", {
    description: "Manage Prime Markdown files; injection requires a matching prime.protocol.toml rule",
    handler: async (args, ctx) => {
      await runPrimeCommand(args, createPrimeRepository(ctx.cwd), {
        hasUI: ctx.hasUI,
        editor: ctx.ui.editor.bind(ctx.ui),
        notify: ctx.ui.notify.bind(ctx.ui),
      });
    },
  });
}
