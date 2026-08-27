import TOML from "@iarna/toml";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, isAbsolute, relative, resolve } from "node:path";

export const COMMAND_TIMEOUT_MS = 1_000;
export const COMMAND_OUTPUT_LIMIT_BYTES = 1_048_576;

export type PrimeAction = "memory" | "command";

export const DEFAULT_PROTOCOL = `version = 1

[[rule]]
glob = "*.md"
action = "memory"

[[rule]]
glob = "*.command.toml"
action = "command"
`;

interface PrimeRuleV1 {
  glob: string;
  action: PrimeAction;
}

export interface PrimeProtocolV1 {
  version: 1;
  rule: PrimeRuleV1[];
}

interface CommandSourceV1 {
  version: 1;
  argv: [string, ...string[]];
  cwd?: string;
}

const protocolFilename = "prime.protocol.toml";
const utf8 = new TextDecoder("utf-8", { fatal: true });

export async function installDefaultProtocol(sourceRoot: string): Promise<void> {
  await mkdir(sourceRoot, { recursive: true });
  try {
    await writeFile(resolve(sourceRoot, protocolFilename), DEFAULT_PROTOCOL, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) throw error;
  }
}

export async function loadProtocol(sourceRoot: string, scopeLabel: string): Promise<PrimeProtocolV1 | undefined> {
  try {
    return parseProtocol(await readUtf8(resolve(sourceRoot, protocolFilename), `${scopeLabel} protocol`), scopeLabel);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function resolveProtocolMemories(sourceRoot: string, scopeLabel: string, protocol: PrimeProtocolV1): Promise<string[]> {
  const entries = await listDirectFiles(sourceRoot, scopeLabel);
  const selected = selectFiles(protocol, entries, scopeLabel);
  const memories: string[] = [];

  for (const { rule, filenames } of selected) {
    for (const filename of filenames) {
      const sourcePath = resolve(sourceRoot, filename);
      if (rule.action === "memory") {
        memories.push(await readUtf8(sourcePath, `${scopeLabel} source "${filename}"`));
      } else {
        memories.push(await runCommandSource(sourcePath, sourceRoot, scopeLabel));
      }
    }
  }

  return memories;
}

function parseProtocol(text: string, scopeLabel: string): PrimeProtocolV1 {
  const value = parseToml(text, `${scopeLabel} protocol`);
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.rule) || value.rule.length === 0) {
    throw new Error(`${scopeLabel} protocol must contain version = 1 and one or more [[rule]] entries.`);
  }

  const rules = value.rule.map((rule, index) => parseRule(rule, index, scopeLabel));
  return { version: 1, rule: rules };
}

function parseRule(value: unknown, index: number, scopeLabel: string): PrimeRuleV1 {
  if (!isRecord(value) || typeof value.glob !== "string" || !isSupportedBasenameGlob(value.glob)) {
    throw new Error(`${scopeLabel} protocol rule ${index + 1} has an unsupported direct-file glob.`);
  }
  if (value.action !== "memory" && value.action !== "command") {
    throw new Error(`${scopeLabel} protocol rule ${index + 1} has invalid action "${String(value.action)}".`);
  }
  if (value.action === "command" && !value.glob.endsWith(".command.toml")) {
    throw new Error(`${scopeLabel} protocol rule ${index + 1} must select *.command.toml files for command.`);
  }
  return { glob: value.glob, action: value.action };
}

function isSupportedBasenameGlob(glob: string): boolean {
  return glob.length > 0
    && !glob.includes("/")
    && !glob.includes("\\")
    && glob !== "."
    && glob !== ".."
    && !glob.includes("**")
    && !/[?\[\]{}]/.test(glob);
}

async function listDirectFiles(sourceRoot: string, scopeLabel: string): Promise<string[]> {
  try {
    const entries = await readdir(sourceRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name !== protocolFilename)
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return [];
    throw new Error(`${scopeLabel} protocol source root "${sourceRoot}" cannot be read: ${errorMessage(error)}`);
  }
}

function selectFiles(protocol: PrimeProtocolV1, filenames: string[], scopeLabel: string): Array<{ rule: PrimeRuleV1; filenames: string[] }> {
  const matched = new Set<string>();
  return protocol.rule.map((rule, index) => {
    const matches = filenames.filter((filename) => matchesGlob(filename, rule.glob));
    for (const filename of matches) {
      if (matched.has(filename)) {
        throw new Error(`${scopeLabel} protocol rules overlap on source "${filename}" (rule ${index + 1}).`);
      }
      matched.add(filename);
    }
    return { rule, filenames: matches };
  });
}

function matchesGlob(filename: string, glob: string): boolean {
  const expression = `^${glob.split("*").map(escapeRegExp).join(".*")}$`;
  return new RegExp(expression).test(filename);
}

async function runCommandSource(sourcePath: string, sourceRoot: string, scopeLabel: string): Promise<string> {
  const sourceName = basename(sourcePath);
  const source = parseCommandSource(await readUtf8(sourcePath, `${scopeLabel} command source "${sourceName}"`), sourceName, scopeLabel);
  const cwd = await commandCwd(source.cwd, sourceRoot, sourceName, scopeLabel);
  const output = await execute(source.argv, cwd, sourceName, scopeLabel);
  try {
    return utf8.decode(output);
  } catch {
    throw new Error(`${scopeLabel} command source "${sourceName}" produced invalid UTF-8 stdout.`);
  }
}

function parseCommandSource(text: string, sourceName: string, scopeLabel: string): CommandSourceV1 {
  const value = parseToml(text, `${scopeLabel} command source "${sourceName}"`);
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.argv) || value.argv.length === 0 || !value.argv.every((part) => typeof part === "string")) {
    throw new Error(`${scopeLabel} command source "${sourceName}" must contain version = 1 and a non-empty argv string array.`);
  }
  if (value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.length === 0)) {
    throw new Error(`${scopeLabel} command source "${sourceName}" has an invalid cwd.`);
  }
  return { version: 1, argv: value.argv as [string, ...string[]], ...(value.cwd === undefined ? {} : { cwd: value.cwd }) };
}

async function commandCwd(cwd: string | undefined, sourceRoot: string, sourceName: string, scopeLabel: string): Promise<string> {
  const requested = cwd ?? ".";
  if (isAbsolute(requested)) {
    throw new Error(`${scopeLabel} command source "${sourceName}" cwd must be relative beneath the source root.`);
  }
  const candidate = resolve(sourceRoot, requested);
  if (!isContained(sourceRoot, candidate)) {
    throw new Error(`${scopeLabel} command source "${sourceName}" cwd must not escape the source root.`);
  }
  try {
    const [root, resolvedCwd] = await Promise.all([realpath(sourceRoot), realpath(candidate)]);
    if (!isContained(root, resolvedCwd)) {
      throw new Error(`${scopeLabel} command source "${sourceName}" cwd must not escape the source root.`);
    }
    return resolvedCwd;
  } catch (error) {
    if (error instanceof Error && error.message.includes("must not escape")) throw error;
    throw new Error(`${scopeLabel} command source "${sourceName}" cwd cannot be resolved: ${errorMessage(error)}`);
  }
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function execute(argv: [string, ...string[]], cwd: string, sourceName: string, scopeLabel: string): Promise<Buffer> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const fail = (message: string) => finish(() => reject(new Error(`${scopeLabel} command source "${sourceName}": ${message}`)));
    const timer = setTimeout(() => {
      fail(`timed out after ${COMMAND_TIMEOUT_MS}ms (limit: ${COMMAND_TIMEOUT_MS}ms).`);
      child.kill();
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > COMMAND_OUTPUT_LIMIT_BYTES) {
        fail(`stdout exceeded ${COMMAND_OUTPUT_LIMIT_BYTES} bytes (limit: ${COMMAND_OUTPUT_LIMIT_BYTES} bytes).`);
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (error) => fail(`execution failed: ${errorMessage(error)}`));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        fail(`exited with status ${code ?? "none"}${signal ? ` (signal ${signal})` : ""}.`);
        return;
      }
      finish(() => resolveOutput(Buffer.concat(chunks)));
    });
  });
}

function parseToml(text: string, label: string): unknown {
  try {
    return TOML.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid TOML: ${errorMessage(error)}`);
  }
}

async function readUtf8(path: string, label: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw error;
  }
  try {
    return utf8.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
