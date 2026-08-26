import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PrimeScope = "global" | "project";

export interface PrimeRepositoryDirectories {
  globalDirectory: string;
  projectDirectory: string;
}

export class PrimeRepository {
  constructor(readonly directories: PrimeRepositoryDirectories) {}

  async create(scope: PrimeScope, content: string): Promise<string> {
    const directory = this.directoryFor(scope);
    await mkdir(directory, { recursive: true });

    for (;;) {
      const id = `prime-${randomUUID().slice(0, 8)}`;
      try {
        await writeFile(this.pathFor(scope, id), content, { encoding: "utf8", flag: "wx" });
        return id;
      } catch (error) {
        if (!isFileSystemError(error, "EEXIST")) {
          throw error;
        }
      }
    }
  }

  async read(scope: PrimeScope, id: string): Promise<string> {
    this.validateId(id);
    try {
      return await readFile(this.pathFor(scope, id), "utf8");
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        throw new Error(`${scopeLabel(scope)} Prime "${id}" does not exist.`);
      }
      throw error;
    }
  }

  async edit(scope: PrimeScope, id: string, content: string): Promise<void> {
    await this.read(scope, id);
    await writeFile(this.pathFor(scope, id), content, "utf8");
  }

  async delete(scope: PrimeScope, id: string): Promise<void> {
    this.validateId(id);
    try {
      await unlink(this.pathFor(scope, id));
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        throw new Error(`${scopeLabel(scope)} Prime "${id}" does not exist.`);
      }
      throw error;
    }
  }

  async list(scope: PrimeScope): Promise<string[]> {
    try {
      const entries = await readdir(this.directoryFor(scope), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name.slice(0, -3))
        .filter((id) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))
        .sort();
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
  }

  async compose(): Promise<string> {
    const [global, project] = await Promise.all([
      this.readAll("global"),
      this.readAll("project"),
    ]);
    const memories = [...global, ...project].map(({ content }) => `- ${content.replace(/\n/g, "\n  ")}`);

    return memories.length === 0 ? "" : `<prime_memories>\n${memories.join("\n")}\n</prime_memories>`;
  }

  private async readAll(scope: PrimeScope): Promise<Array<{ scope: PrimeScope; id: string; content: string }>> {
    return Promise.all(
      (await this.list(scope)).map(async (id) => ({ scope, id, content: await this.read(scope, id) })),
    );
  }

  private directoryFor(scope: PrimeScope): string {
    return scope === "global" ? this.directories.globalDirectory : this.directories.projectDirectory;
  }

  private pathFor(scope: PrimeScope, id: string): string {
    return join(this.directoryFor(scope), `${id}.md`);
  }

  private validateId(id: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
      throw new Error(`Invalid Prime ID "${id}". Use letters, digits, hyphens, or underscores.`);
    }
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function scopeLabel(scope: PrimeScope): "Global" | "Project" {
  return scope === "global" ? "Global" : "Project";
}
