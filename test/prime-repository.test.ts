import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrimeRepository } from "../src/index.js";
import { runPrimeCommand } from "../src/prime-command.js";
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

describe("PrimeRepository", () => {
  it("creates a Global Prime as Markdown and reads it back", async () => {
    const primes = await createFixture();

    const id = await primes.create("global", "Use tabs.");

    expect(id).toMatch(/^prime-[0-9a-f]{8}$/);
    await expect(primes.read("global", id)).resolves.toBe("Use tabs.");
  });

  it("assigns a distinct extension-managed ID to each Prime", async () => {
    const primes = await createFixture();
    const firstId = await primes.create("project", "Original guidance.");
    const secondId = await primes.create("project", "Replacement guidance.");

    expect(firstId).not.toBe(secondId);
    await expect(primes.read("project", firstId)).resolves.toBe("Original guidance.");
    await expect(primes.read("project", secondId)).resolves.toBe("Replacement guidance.");
  });

  it("composes Prime memories without IDs, ordered Global before Project", async () => {
    const primes = await createFixture();
    await Promise.all([
      mkdir(primes.directories.globalDirectory, { recursive: true }),
      mkdir(primes.directories.projectDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(primes.directories.globalDirectory, "zebra.md"), "Global zebra"),
      writeFile(join(primes.directories.globalDirectory, "alpha.md"), "Global alpha"),
      writeFile(join(primes.directories.projectDirectory, "beta.md"), "Project beta"),
    ]);

    await expect(primes.compose()).resolves.toBe(
      "## Prime memories\n\n- Global alpha\n- Global zebra\n- Project beta",
    );
  });

  it("lists only direct Markdown Primes in ID order within the requested scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-prime-"));
    temporaryDirectories.push(root);
    const globalDirectory = join(root, "global", "prime");
    const projectDirectory = join(root, "project", ".agents", "prime");
    const primes = new PrimeRepository({ globalDirectory, projectDirectory });
    await Promise.all([
      mkdir(globalDirectory, { recursive: true }),
      mkdir(projectDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(globalDirectory, "zebra.md"), "Zebra"),
      writeFile(join(globalDirectory, "alpha.md"), "Alpha"),
      writeFile(join(globalDirectory, "ignore.txt"), "Ignore"),
      mkdir(join(globalDirectory, "directory.md")),
      writeFile(join(projectDirectory, "project-only.md"), "Project"),
    ]);

    await expect(primes.list("global")).resolves.toEqual(["alpha", "zebra"]);
    await expect(primes.list("project")).resolves.toEqual(["project-only"]);
  });

  it("adds and lists a Project Prime through the Prime command adapter", async () => {
    const primes = await createFixture();
    const notifications: string[] = [];
    const ui = {
      hasUI: true,
      editor: async () => "Keep pull requests small.",
      notify: (message: string) => notifications.push(message),
    };

    await runPrimeCommand("add", primes, ui);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatch(/^Added Project Prime "prime-[0-9a-f]{8}"\.$/);
    await runPrimeCommand("list project", primes, ui);
    expect(notifications[1]).toMatch(/^project:\n- Keep pull requests small\. \[prime-[0-9a-f]{8}\]$/);
  });

  it("edits and deletes a Prime by ID without a scope", async () => {
    const primes = await createFixture();
    const id = await primes.create("global", "Original guidance.");
    const notifications: string[] = [];
    const editorCalls: Array<{ title: string; initialValue: string }> = [];
    const ui = {
      hasUI: true,
      editor: async (title: string, initialValue: string) => {
        editorCalls.push({ title, initialValue });
        return "Updated guidance.";
      },
      notify: (message: string) => notifications.push(message),
    };

    await runPrimeCommand(`edit ${id}`, primes, ui);

    expect(editorCalls).toEqual([{ title: "Edit Global Prime", initialValue: "Original guidance." }]);
    await expect(primes.read("global", id)).resolves.toBe("Updated guidance.");
    expect(notifications).toEqual([`Edited Global Prime "${id}".`]);

    await runPrimeCommand(`delete ${id}`, primes, ui);

    await expect(primes.read("global", id)).rejects.toThrow(`Global Prime "${id}" does not exist.`);
    expect(notifications).toEqual([`Edited Global Prime "${id}".`, `Deleted Global Prime "${id}".`]);
  });

  it("lists the Prime command interface when no operation is specified", async () => {
    const primes = await createFixture();
    const notifications: Array<{ message: string; level?: "info" | "warning" | "error" }> = [];
    const ui = {
      hasUI: true,
      editor: async () => undefined,
      notify: (message: string, level?: "info" | "warning" | "error") => notifications.push({ message, level }),
    };

    await runPrimeCommand("", primes, ui);

    expect(notifications).toEqual([
      {
        message: "/prime list [global|project]\n/prime add [global|project]\n/prime edit <id>\n/prime delete <id>",
        level: undefined,
      },
    ]);
  });

  it("lists Global Primes before Project Primes when no scope is specified", async () => {
    const primes = await createFixture();
    await primes.create("project", "Project guidance.");
    await primes.create("global", "Global guidance.");
    const notifications: string[] = [];
    const ui = {
      hasUI: true,
      editor: async () => undefined,
      notify: (message: string) => notifications.push(message),
    };

    await runPrimeCommand("list", primes, ui);

    expect(notifications).toEqual([
      expect.stringMatching(/^global:\n- Global guidance\. \[prime-[0-9a-f]{8}\]\n\nproject:\n- Project guidance\. \[prime-[0-9a-f]{8}\]$/),
    ]);
  });

  it("labels empty Global and Project Prime lists", async () => {
    const primes = await createFixture();
    const notifications: string[] = [];
    const ui = {
      hasUI: true,
      editor: async () => undefined,
      notify: (message: string) => notifications.push(message),
    };

    await runPrimeCommand("list", primes, ui);

    expect(notifications).toEqual(["global: none\n\nproject: none"]);
  });

  it("resolves Global and Project Prime storage independently", async () => {
    const primes = createPrimeRepository("/workspace/product", "/home/user");

    expect(primes.directories).toEqual({
      globalDirectory: "/home/user/.agents/share/prime",
      projectDirectory: "/workspace/product/.agents/prime",
    });
  });

  it("reports unavailable add UI without claiming success", async () => {
    const primes = await createFixture();
    const notifications: Array<{ message: string; level?: "info" | "warning" | "error" }> = [];
    const ui = {
      hasUI: false,
      editor: async () => undefined,
      notify: (message: string, level?: "info" | "warning" | "error") => notifications.push({ message, level }),
    };

    await runPrimeCommand("add global", primes, ui);

    expect(notifications).toEqual([
      {
        message: "Adding a Prime requires interactive UI. Usage: /prime list [global|project] | add [global|project] | edit <id> | delete <id>",
        level: "error",
      },
    ]);
  });

  it("rejects extra command arguments with concise usage guidance", async () => {
    const primes = await createFixture();
    const notifications: string[] = [];
    const ui = {
      hasUI: true,
      editor: async () => "ignored",
      notify: (message: string) => notifications.push(message),
    };

    await runPrimeCommand("list global unexpected", primes, ui);

    expect(notifications).toEqual([
      "Usage: /prime list [global|project] | add [global|project] | edit <id> | delete <id>",
    ]);
  });

  it("uses the global keyword for a Global Prime", async () => {
    const primes = await createFixture();
    const notifications: string[] = [];
    const ui = {
      hasUI: true,
      editor: async () => "Created through the Prime command.",
      notify: (message: string) => notifications.push(message),
    };

    await runPrimeCommand("add global", primes, ui);

    expect(notifications).toHaveLength(1);
    await runPrimeCommand("list global", primes, ui);
    expect(notifications[1]).toMatch(/^global:\n- Created through the Prime command\. \[prime-[0-9a-f]{8}\]$/);
    expect(notifications[0]).toMatch(/^Added Global Prime "prime-[0-9a-f]{8}"\.$/);
  });

  it("reports storage failures without claiming that a Prime was created", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-prime-"));
    temporaryDirectories.push(root);
    const globalDirectory = join(root, "blocked");
    await writeFile(globalDirectory, "not a directory");
    const primes = new PrimeRepository({ globalDirectory, projectDirectory: join(root, "project", "prime") });
    const notifications: Array<{ message: string; level?: "info" | "warning" | "error" }> = [];
    const ui = {
      hasUI: true,
      editor: async () => "Content",
      notify: (message: string, level?: "info" | "warning" | "error") => notifications.push({ message, level }),
    };

    await runPrimeCommand("add global", primes, ui);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.level).toBe("error");
    expect(notifications[0]?.message).not.toContain("Created");
  });
});
