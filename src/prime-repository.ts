import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { installDefaultProtocol, loadProtocol, resolveProtocolMemories } from "./prime-protocol.js";
import type { PrimeSessionEntry } from "./prime-protocol.js";

export type PrimeScope = "global" | "project";
export type PrimeSourceType = "memory" | "command";

export interface PrimeRepositoryDirectories {
  globalDirectory: string;
  projectDirectory: string;
}

export interface PrimeSource {
  id: string;
  type: PrimeSourceType;
}

export class PrimeRepository {
  constructor(readonly directories: PrimeRepositoryDirectories) {}

  async create(scope: PrimeScope, type: PrimeSourceType, content: string): Promise<string> {
    const directory = this.directoryFor(scope);
    await mkdir(directory, { recursive: true });

    for (;;) {
      const id = `prime-${randomUUID().slice(0, 8)}`;
      try {
        await writeFile(this.pathFor(scope, id, type), content, { encoding: "utf8", flag: "wx" });
        return id;
      } catch (error) {
        if (!isFileSystemError(error, "EEXIST")) {
          throw error;
        }
      }
    }
  }

  async read(scope: PrimeScope, source: PrimeSource): Promise<string> {
    try {
      return await readFile(this.pathFor(scope, source.id, source.type), "utf8");
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        throw new Error(`${scopeLabel(scope)} ${source.type} Prime "${source.id}" does not exist.`);
      }
      throw error;
    }
  }

  async edit(scope: PrimeScope, source: PrimeSource, content: string): Promise<void> {
    await this.read(scope, source);
    await writeFile(this.pathFor(scope, source.id, source.type), content, "utf8");
  }

  async delete(scope: PrimeScope, source: PrimeSource): Promise<void> {
    try {
      await unlink(this.pathFor(scope, source.id, source.type));
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        throw new Error(`${scopeLabel(scope)} ${source.type} Prime "${source.id}" does not exist.`);
      }
      throw error;
    }
  }

  async list(scope: PrimeScope): Promise<PrimeSource[]> {
    try {
      const entries = await readdir(this.directoryFor(scope), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry): PrimeSource | undefined => {
          if (entry.name.endsWith(".command.toml")) {
            const id = entry.name.slice(0, -".command.toml".length);
            return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) ? { id, type: "command" } : undefined;
          }
          if (entry.name.endsWith(".md")) {
            const id = entry.name.slice(0, -".md".length);
            return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) ? { id, type: "memory" } : undefined;
          }
          return undefined;
        })
        .filter((source): source is PrimeSource => source !== undefined)
        .sort((left, right) => left.id.localeCompare(right.id) || left.type.localeCompare(right.type));
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
  }

  async compose(): Promise<string> {
    const globalDirectory = this.directoryFor("global");
    await installDefaultProtocol(globalDirectory);
    const globalProtocol = await loadProtocol(globalDirectory, "Global");
    if (!globalProtocol) throw new Error("Global Prime protocol could not be installed.");

    const projectDirectory = this.directoryFor("project");
    const projectProtocol = await loadProtocol(projectDirectory, "Project");
    const projectRoot = dirname(dirname(projectDirectory));
    const global = await resolveProtocolMemories(globalDirectory, "Global", globalProtocol, projectRoot);
    const project = await resolveProtocolMemories(projectDirectory, "Project", projectProtocol ?? globalProtocol, projectRoot);
    const entries = [...global, ...project];

    return entries.length === 0
      ? ""
      : `<prime_session version="1">\n${entries.map(formatSessionEntry).join("\n")}\n</prime_session>`;
  }

  private directoryFor(scope: PrimeScope): string {
    return scope === "global" ? this.directories.globalDirectory : this.directories.projectDirectory;
  }

  private pathFor(scope: PrimeScope, id: string, type: PrimeSourceType): string {
    this.validateId(id);
    return join(this.directoryFor(scope), `${id}${type === "memory" ? ".md" : ".command.toml"}`);
  }

  private validateId(id: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
      throw new Error(`Invalid Prime ID "${id}". Use letters, digits, hyphens, or underscores.`);
    }
  }
}

function formatSessionEntry(entry: PrimeSessionEntry): string {
  if (entry.type === "memory") return `  <memory>${escapeXml(entry.content)}</memory>`;
  return `  <command>\n    <run>${escapeXml(entry.argv.join(" "))}</run>\n    <output>${escapeXml(entry.output)}</output>\n  </command>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function scopeLabel(scope: PrimeScope): "Global" | "Project" {
  return scope === "global" ? "Global" : "Project";
}
