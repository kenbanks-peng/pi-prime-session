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
  let primeSnapshot = "";

  pi.on("session_start", async (_event, ctx) => {
    primeSnapshot = "";
    try {
      primeSnapshot = await repositoryFor(ctx.cwd).compose();
    } catch (error) {
      if (error instanceof CommandSourceError) {
        if (error.exitCode !== undefined) {
          ctx.ui.notify(`${error.sourceName} returned error code ${error.exitCode}.`);
        } else {
          ctx.ui.notify(`${error.sourceName} had an error.`, "error");
        }
        return;
      }
      throw error;
    }
  });

  pi.on("before_agent_start", (event) => {
    if (primeSnapshot) {
      event.systemPromptOptions.sections.prime = primeSnapshot;
    } else {
      delete event.systemPromptOptions.sections.prime;
    }
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
