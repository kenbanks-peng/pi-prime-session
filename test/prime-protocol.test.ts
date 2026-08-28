import { afterEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PrimeRepository } from "../src/prime-repository.js";
import { COMMAND_OUTPUT_LIMIT_BYTES, COMMAND_TIMEOUT_MS } from "../src/prime-protocol.js";

const temporaryDirectories: string[] = [];
const markdownProtocol = 'version = 1\n\n[[rule]]\nglob = "*.md"\naction = "memory"\n';
const commandProtocol = 'version = 1\n\n[[rule]]\nglob = "*.command.toml"\naction = "command"\n';
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-prime-protocol-"));
  temporaryDirectories.push(root);
  const globalDirectory = join(root, "global", "prime");
  const projectDirectory = join(root, "project", ".agents", "prime");
  await Promise.all([mkdir(globalDirectory, { recursive: true }), mkdir(projectDirectory, { recursive: true })]);
  return new PrimeRepository({ globalDirectory, projectDirectory });
}

async function protocol(directory: string, content: string): Promise<void> {
  await writeFile(join(directory, "prime.protocol.toml"), content);
}

describe("Prime source action protocol", () => {
  it("installs the Global protocol and uses it for Project sources without an override", async () => {
    const primes = await createFixture();
    await writeFile(join(primes.directories.projectDirectory, "guidance.md"), "active");

    await expect(primes.compose()).resolves.toContain("active");
  });

  it("uses the Global protocol again when a Project override is removed", async () => {
    const primes = await createFixture();
    await protocol(primes.directories.projectDirectory, 'version = 1\n[[rule]]\nglob = "selected-*.md"\naction = "memory"\n');
    await writeFile(join(primes.directories.projectDirectory, "guidance.md"), "active");
    await expect(primes.compose()).resolves.toBe("");

    await rm(join(primes.directories.projectDirectory, "prime.protocol.toml"));
    await expect(primes.compose()).resolves.toContain("active");
  });

  it("injects direct Markdown files in lexicographic order and escapes XML", async () => {
    const primes = await createFixture();
    await protocol(primes.directories.projectDirectory, markdownProtocol);
    await Promise.all([
      writeFile(join(primes.directories.projectDirectory, "z.md"), "Z"),
      writeFile(join(primes.directories.projectDirectory, "a.md"), "<tag>&</memory>"),
      writeFile(join(primes.directories.projectDirectory, "ignore.txt"), "Ignore"),
      symlink(join(primes.directories.projectDirectory, "a.md"), join(primes.directories.projectDirectory, "linked.md")),
      mkdir(join(primes.directories.projectDirectory, "folder.md")),
      mkdir(join(primes.directories.projectDirectory, "nested")),
    ]);
    await writeFile(join(primes.directories.projectDirectory, "nested", "hidden.md"), "Hidden");

    await expect(primes.compose()).resolves.toBe(
      '<prime_memories version="1">\n<memory>&lt;tag&gt;&amp;&lt;/memory&gt;</memory>\n<memory>Z</memory>\n</prime_memories>',
    );
  });

  it("injects Markdown added directly after the protocol exists", async () => {
    const primes = await createFixture();
    await protocol(primes.directories.projectDirectory, markdownProtocol);
    await expect(primes.compose()).resolves.toBe("");

    await writeFile(join(primes.directories.projectDirectory, "later.md"), "Added without slash command");
    await expect(primes.compose()).resolves.toContain("Added without slash command");
  });

  it("runs command sources directly and injects stdout", async () => {
    const primes = await createFixture();
    await protocol(primes.directories.projectDirectory, commandProtocol);
    await writeFile(
      join(primes.directories.projectDirectory, "status.command.toml"),
      `version = 1\nargv = [${JSON.stringify(process.execPath)}, "-e", "process.stdout.write(process.argv[1])", "literal; $HOME <tag>&"]\ncwd = "."\n`,
    );

    await expect(primes.compose()).resolves.toContain("literal; $HOME &lt;tag&gt;&amp;");
  });

  it("runs Global command sources from the current project root", async () => {
    const primes = await createFixture();
    const projectRoot = join(primes.directories.projectDirectory, "..", "..");
    await writeFile(join(projectRoot, "tracked.md"), "tracked");
    await execFileAsync("git", ["init", "--quiet"], { cwd: projectRoot });
    await execFileAsync("git", ["add", "tracked.md"], { cwd: projectRoot });
    await protocol(primes.directories.globalDirectory, commandProtocol);
    await writeFile(
      join(primes.directories.globalDirectory, "tracked.command.toml"),
      'version = 1\nargv = ["git", "ls-files"]\n',
    );

    await expect(primes.compose()).resolves.toContain("tracked.md");
  });

  it("rejects failed commands without returning partial scope output", async () => {
    const primes = await createFixture();
    await protocol(primes.directories.projectDirectory, `${markdownProtocol}\n[[rule]]\nglob = "*.command.toml"\naction = "command"\n`);
    await writeFile(join(primes.directories.projectDirectory, "first.md"), "must not be returned");
    await writeFile(join(primes.directories.projectDirectory, "bad.command.toml"), `version = 1\nargv = [${JSON.stringify(process.execPath)}, "-e", "process.exit(7)"]\n`);

    await expect(primes.compose()).rejects.toThrow("exited with status 7");
  });

  it("reports command timeout, output limit, malformed source, and escaping cwd", async () => {
    const primes = await createFixture();
    await protocol(primes.directories.projectDirectory, commandProtocol);
    const command = (body: string) => writeFile(join(primes.directories.projectDirectory, "case.command.toml"), body);

    await command(`version = 1\nargv = [${JSON.stringify(process.execPath)}, "-e", "setTimeout(() => {}, 10000)"]\n`);
    await expect(primes.compose()).rejects.toThrow(`timed out after ${COMMAND_TIMEOUT_MS}ms (limit: ${COMMAND_TIMEOUT_MS}ms)`);

    await command(`version = 1\nargv = [${JSON.stringify(process.execPath)}, "-e", "process.stdout.write('x'.repeat(${COMMAND_OUTPUT_LIMIT_BYTES + 1}))"]\n`);
    await expect(primes.compose()).rejects.toThrow(`stdout exceeded ${COMMAND_OUTPUT_LIMIT_BYTES} bytes (limit: ${COMMAND_OUTPUT_LIMIT_BYTES} bytes)`);

    await command("version = 1\nargv = []\n");
    await expect(primes.compose()).rejects.toThrow("non-empty argv string array");

    await command(`version = 1\nargv = [${JSON.stringify(process.execPath)}, "-e", ""]\ncwd = "../outside"\n`);
    await expect(primes.compose()).rejects.toThrow("cwd must not escape the current project root");
  });

  it("rejects invalid protocol TOML, unsupported globs, actions, and overlapping matches", async () => {
    const primes = await createFixture();
    await protocol(primes.directories.projectDirectory, "version =");
    await expect(primes.compose()).rejects.toThrow("not valid TOML");

    await protocol(primes.directories.projectDirectory, 'version = 1\n[[rule]]\nglob = "**/*.md"\naction = "memory"\n');
    await expect(primes.compose()).rejects.toThrow("unsupported direct-file glob");

    await protocol(primes.directories.projectDirectory, 'version = 1\n[[rule]]\nglob = "*.md"\naction = "unknown"\n');
    await expect(primes.compose()).rejects.toThrow('invalid action "unknown"');

    await protocol(primes.directories.projectDirectory, `${markdownProtocol}\n[[rule]]\nglob = "guide*"\naction = "memory"\n`);
    await writeFile(join(primes.directories.projectDirectory, "guide.md"), "ambiguous");
    await expect(primes.compose()).rejects.toThrow('rules overlap on source "guide.md"');
  });

  it("resolves Global source output before Project output", async () => {
    const primes = await createFixture();
    await Promise.all([protocol(primes.directories.globalDirectory, markdownProtocol), protocol(primes.directories.projectDirectory, markdownProtocol)]);
    await Promise.all([writeFile(join(primes.directories.globalDirectory, "a.md"), "Global"), writeFile(join(primes.directories.projectDirectory, "a.md"), "Project")]);

    await expect(primes.compose()).resolves.toBe('<prime_memories version="1">\n<memory>Global</memory>\n<memory>Project</memory>\n</prime_memories>');
  });
});
