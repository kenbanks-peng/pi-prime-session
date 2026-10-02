import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import primeExtension, { createPrimeRepository } from "../src/index.js";
import { runPrimeCommand } from "../src/prime-command.js";
import { CommandSourceError, PRIME_VERSION } from "../src/prime-protocol.js";
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

function createExtensionHarness(primes: PrimeRepository) {
  const handlers = new Map<string, (event: never, ctx: never) => unknown>();
  const sendMessage = mock(() => {});
  const notify = mock((_message: string, _level?: string) => {});
  primeExtension({
    on(event: string, handler: (event: never, ctx: never) => unknown) {
      handlers.set(event, handler);
    },
    sendMessage,
    registerCommand() {},
  } as never, () => primes);

  return {
    handlers,
    sendMessage,
    notify,
    async startSession() {
      await handlers.get("session_start")!({} as never, { cwd: "/project", ui: { notify } } as never);
    },
    beforeAgentStart(sections: Record<string, string> = {}) {
      handlers.get("before_agent_start")!({ systemPromptOptions: { sections } } as never, {} as never);
      return sections;
    },
  };
}

describe("Prime extension", () => {
  it("adds a session snapshot to system context without sending a message", async () => {
    const primes = await createFixture();
    const id = await primes.create("global", "memory", "Original guidance");
    const compose = spyOn(primes, "compose");
    const extension = createExtensionHarness(primes);

    expect([...extension.handlers.keys()]).toEqual(["session_start", "before_agent_start"]);
    await extension.startSession();
    const first = extension.beforeAgentStart({ unrelated: "Keep this section" });
    expect(first.prime_context).toContain("<prime_session version=\"1\">");
    expect(first.prime_context).toContain("Original guidance");
    expect(first.unrelated).toBe("Keep this section");

    await primes.edit("global", { id, type: "memory" }, "Changed guidance");
    const second = extension.beforeAgentStart();
    expect(second.prime_context).toBe(first.prime_context);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(extension.sendMessage).not.toHaveBeenCalled();

    await extension.startSession();
    expect(extension.beforeAgentStart().prime_context).toContain("Changed guidance");
    expect(compose).toHaveBeenCalledTimes(2);
  });

  it("does not add a section before session start or when no sources exist", async () => {
    const extension = createExtensionHarness(await createFixture());
    expect(extension.beforeAgentStart({ unrelated: "Keep" })).toEqual({ unrelated: "Keep" });
    await extension.startSession();
    expect(extension.beforeAgentStart({ unrelated: "Keep" })).toEqual({ unrelated: "Keep" });
    expect(extension.sendMessage).not.toHaveBeenCalled();
  });

  it("clears the previous snapshot when the next session has no sources", async () => {
    const primes = await createFixture();
    const id = await primes.create("global", "memory", "Guidance");
    const extension = createExtensionHarness(primes);
    await extension.startSession();
    const sections = extension.beforeAgentStart({ unrelated: "Keep" });
    expect(sections.prime_context).toContain("Guidance");

    await primes.delete("global", { id, type: "memory" });
    await extension.startSession();
    expect(extension.beforeAgentStart(sections)).toEqual({ unrelated: "Keep" });
  });

  it.each([
    [new CommandSourceError("status.command.toml", "Failed", 2), "status.command.toml returned error code 2.", undefined],
    [new CommandSourceError("status.command.toml", "Timed out"), "status.command.toml had an error.", "error"],
  ])("reports command errors and clears the previous snapshot: %s", async (error, message, level) => {
    const primes = await createFixture();
    await primes.create("global", "memory", "Guidance");
    const extension = createExtensionHarness(primes);
    await extension.startSession();
    const sections = extension.beforeAgentStart();

    spyOn(primes, "compose").mockRejectedValue(error);
    await extension.startSession();
    expect(extension.beforeAgentStart(sections)).toEqual({});
    if (level) {
      expect(extension.notify).toHaveBeenCalledWith(message, level);
    } else {
      expect(extension.notify).toHaveBeenCalledWith(message);
    }
    expect(extension.sendMessage).not.toHaveBeenCalled();
  });

  it("propagates other errors without retaining the previous snapshot", async () => {
    const primes = await createFixture();
    await primes.create("global", "memory", "Guidance");
    const extension = createExtensionHarness(primes);
    await extension.startSession();
    const sections = extension.beforeAgentStart();
    const error = new Error("Invalid protocol");
    spyOn(primes, "compose").mockRejectedValue(error);

    await expect(extension.startSession()).rejects.toThrow(error);
    expect(extension.beforeAgentStart(sections)).toEqual({});
    expect(extension.notify).not.toHaveBeenCalled();
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

    await expect(primes.compose()).resolves.toBe('<prime_session version="1">\n  <memory>Global</memory>\n  <memory>Project</memory>\n</prime_session>');
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
