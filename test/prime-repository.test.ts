import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import primeExtension, { createPrimeRepository } from "../src/index.js";
import { runPrimeCommand } from "../src/prime-command.js";
import { PRIME_VERSION } from "../src/prime-protocol.js";
import { PrimeRepository } from "../src/prime-repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-prime-"));
  temporaryDirectories.push(root);
  return new PrimeRepository({
    globalDirectory: join(root, "global", "prime"),
    projectDirectory: join(root, "project", ".agents", "prime"),
  });
}

describe("Prime extension", () => {
  it("composes Primes once when the session starts", async () => {
    let contextHandler: ((event: { messages: Array<Record<string, unknown>> }) => unknown) | undefined;
    const events: string[] = [];
    const pi = {
      on(event: string, handler: (event: { messages: Array<Record<string, unknown>> }) => unknown) {
        events.push(event);
        if (event === "context") contextHandler = handler;
      },
      sendMessage() {},
      registerCommand() {},
    };
    primeExtension(pi as never);

    expect(events).toContain("session_start");
    expect(events).not.toContain("before_agent_start");
    const result = await contextHandler!({
      messages: [
        { role: "user", content: "First request" },
        { role: "custom", customType: "prime_memories", content: "<prime_memories />" },
        { role: "assistant", content: "First response" },
      ],
    }) as { messages: Array<Record<string, unknown>> };

    expect(result.messages.map((message) => message.content)).toEqual(["<prime_memories />", "First request", "First response"]);
  });
});

describe("PrimeRepository", () => {
  it("creates, reads, and lists memory and command Prime sources", async () => {
    const primes = await createFixture();
    const memoryId = await primes.create("global", "memory", "Use tabs.");
    const commandId = await primes.create("global", "command", 'version = 1\nargv = ["git", "status"]\n');
    const memory = { id: memoryId, type: "memory" as const };
    const command = { id: commandId, type: "command" as const };

    await expect(primes.read("global", memory)).resolves.toBe("Use tabs.");
    await expect(primes.read("global", command)).resolves.toContain("argv");
    await expect(primes.list("global")).resolves.toEqual(expect.arrayContaining([memory, command]));
  });

  it("installs the default Global protocol and applies it to Project sources", async () => {
    const primes = await createFixture();
    await Promise.all([
      mkdir(primes.directories.globalDirectory, { recursive: true }),
      mkdir(primes.directories.projectDirectory, { recursive: true }),
    ]);
    await writeFile(join(primes.directories.globalDirectory, "global.md"), "Global");
    await writeFile(join(primes.directories.projectDirectory, "project.md"), "Project");

    await expect(primes.compose()).resolves.toBe('<prime_memories version="1">\n<memory>Global</memory>\n<memory>Project</memory>\n</prime_memories>');
    await expect(Bun.file(join(primes.directories.globalDirectory, "prime.protocol.toml")).text()).resolves.toContain('action = "memory"');
  });

  it("uses a Project protocol instead of the Global protocol for Project sources", async () => {
    const primes = await createFixture();
    await mkdir(primes.directories.projectDirectory, { recursive: true });
    await writeFile(join(primes.directories.projectDirectory, "prime.protocol.toml"), 'version = 1\n[[rule]]\nglob = "only-*.md"\naction = "memory"\n');
    await Promise.all([
      writeFile(join(primes.directories.projectDirectory, "only-one.md"), "Selected"),
      writeFile(join(primes.directories.projectDirectory, "other.md"), "Ignored"),
    ]);

    await expect(primes.compose()).resolves.toContain("Selected");
    await expect(primes.compose()).resolves.not.toContain("Ignored");
  });

  it("adds memory and command Prime sources through the Prime command", async () => {
    const primes = await createFixture();
    const notifications: string[] = [];
    const editorValues = ["Keep pull requests small.", 'argv = ["git", "status"]\n'];
    const editorInitialValues: string[] = [];
    const ui = {
      hasUI: true,
      editor: async (_title: string, initialValue: string) => {
        editorInitialValues.push(initialValue);
        return editorValues.shift();
      },
      notify: (message: string) => notifications.push(message),
    };

    await runPrimeCommand("add global memory", primes, ui);
    await runPrimeCommand("add global command", primes, ui);

    expect(notifications[0]).toMatch(/^Added Global memory Prime "prime-[0-9a-f]{8}"\.$/);
    expect(notifications[1]).toMatch(/^Added Global command Prime "prime-[0-9a-f]{8}"\.$/);
    expect(editorInitialValues[1]).not.toContain("version");
    await runPrimeCommand("list global", primes, ui);
    expect(notifications[2]).toContain("memory: Keep pull requests small.");
    expect(notifications[2]).toContain(`command: version = ${PRIME_VERSION}`);
  });

  it("resolves Global and Project Prime storage independently", () => {
    const primes = createPrimeRepository("/workspace/product", "/home/user");
    expect(primes.directories).toEqual({
      globalDirectory: "/home/user/.agents/share/prime",
      projectDirectory: "/workspace/product/.agents/prime",
    });
  });
});
