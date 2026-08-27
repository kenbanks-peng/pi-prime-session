import { PrimeRepository, scopeLabel, type PrimeScope, type PrimeSource, type PrimeSourceType } from "./prime-repository.js";

export interface PrimeCommandUI {
  hasUI: boolean;
  editor(title: string, initialValue: string): Promise<string | undefined>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

const api = "/prime list [global|project] [memory|command]\n/prime add [global|project] [memory|command]\n/prime edit <id> [memory|command]\n/prime delete <id> [memory|command]";
const usage = "Usage: /prime list [global|project] [memory|command] | add [global|project] [memory|command] | edit <id> [memory|command] | delete <id> [memory|command]";
const commandTemplate = "version = 1\nargv = [\"git\", \"status\", \"--short\"]\ncwd = \".\"\n";

export async function runPrimeCommand(args: string, primes: PrimeRepository, ui: PrimeCommandUI): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const [operation, ...arguments_] = tokens;

  try {
    switch (operation) {
      case "list":
        await listPrimes(arguments_, primes, ui);
        return;
      case "add":
        await addPrime(arguments_, primes, ui);
        return;
      case "edit":
        await editPrime(arguments_, primes, ui);
        return;
      case "delete":
        await deletePrime(arguments_, primes, ui);
        return;
      case undefined:
        ui.notify(api);
        return;
      default:
        ui.notify(usage, "error");
    }
  } catch (error) {
    ui.notify(errorMessage(error), "error");
  }
}

async function listPrimes(arguments_: string[], primes: PrimeRepository, ui: PrimeCommandUI): Promise<void> {
  const { scope, type } = parseScopeAndType(arguments_, true);
  const scopes: PrimeScope[] = scope === undefined ? ["global", "project"] : [scope];
  const lists = await Promise.all(scopes.map(async (currentScope) => {
    const sources = (await primes.list(currentScope)).filter((source) => type === undefined || source.type === type);
    const contents = await Promise.all(sources.map(async (source) => ({ source, content: await primes.read(currentScope, source) })));
    return formatPrimeList(currentScope, contents);
  }));
  ui.notify(lists.join("\n\n"));
}

async function addPrime(arguments_: string[], primes: PrimeRepository, ui: PrimeCommandUI): Promise<void> {
  requireInteractiveUI(ui, "Adding");
  const { scope = "project", type = "memory" } = parseScopeAndType(arguments_, true);
  const content = await ui.editor(`Add ${scopeLabel(scope)} ${type} Prime`, type === "command" ? commandTemplate : "");
  if (content === undefined) {
    ui.notify(`${scopeLabel(scope)} ${type} Prime addition cancelled.`);
    return;
  }

  const id = await primes.create(scope, type, content);
  ui.notify(`Added ${scopeLabel(scope)} ${type} Prime "${id}".`);
}

async function editPrime(arguments_: string[], primes: PrimeRepository, ui: PrimeCommandUI): Promise<void> {
  requireInteractiveUI(ui, "Editing");
  const [id, typeArgument] = arguments_;
  if (id === undefined || arguments_.length > 2) throw new Error(usage);
  const source = await sourceForId(id, typeArgument, primes);
  const content = await primes.read(source.scope, source);
  const updatedContent = await ui.editor(`Edit ${scopeLabel(source.scope)} ${source.type} Prime`, content);
  if (updatedContent === undefined) {
    ui.notify(`${scopeLabel(source.scope)} ${source.type} Prime edit cancelled.`);
    return;
  }

  await primes.edit(source.scope, source, updatedContent);
  ui.notify(`Edited ${scopeLabel(source.scope)} ${source.type} Prime "${id}".`);
}

async function deletePrime(arguments_: string[], primes: PrimeRepository, ui: PrimeCommandUI): Promise<void> {
  const [id, typeArgument] = arguments_;
  if (id === undefined || arguments_.length > 2) throw new Error(usage);
  const source = await sourceForId(id, typeArgument, primes);
  await primes.delete(source.scope, source);
  ui.notify(`Deleted ${scopeLabel(source.scope)} ${source.type} Prime "${id}".`);
}

function parseScopeAndType(arguments_: string[], allowEmpty: boolean): { scope?: PrimeScope; type?: PrimeSourceType } {
  if ((!allowEmpty && arguments_.length === 0) || arguments_.length > 2) throw new Error(usage);
  let scope: PrimeScope | undefined;
  let type: PrimeSourceType | undefined;
  for (const value of arguments_) {
    if (value === "global" || value === "project") {
      if (scope !== undefined) throw new Error(usage);
      scope = value;
    } else if (value === "memory" || value === "command") {
      if (type !== undefined) throw new Error(usage);
      type = value;
    } else {
      throw new Error(usage);
    }
  }
  return { scope, type };
}

function requireInteractiveUI(ui: PrimeCommandUI, operation: string): void {
  if (!ui.hasUI) throw new Error(`${operation} a Prime requires interactive UI. ${usage}`);
}

async function sourceForId(id: string, typeArgument: string | undefined, primes: PrimeRepository): Promise<PrimeSource & { scope: PrimeScope }> {
  if (typeArgument !== undefined && typeArgument !== "memory" && typeArgument !== "command") throw new Error(usage);
  const requestedType = typeArgument as PrimeSourceType | undefined;
  const sources = (await Promise.all(
    (["global", "project"] as const).map(async (scope) => (await primes.list(scope))
      .filter((source) => source.id === id && (requestedType === undefined || source.type === requestedType))
      .map((source) => ({ ...source, scope }))),
  )).flat();

  if (sources.length === 0) throw new Error(`Prime "${id}" does not exist.`);
  if (sources.length > 1) throw new Error(`Prime "${id}" is ambiguous. Specify memory or command, or remove the duplicate.`);
  return sources[0]!;
}

function formatPrimeList(scope: PrimeScope, primes: Array<{ source: PrimeSource; content: string }>): string {
  const label = `${scope}:`;
  return primes.length === 0
    ? `${label} none`
    : `${label}\n${primes.map(({ source, content }) => `- ${source.type}: ${content} [${source.id}]`).join("\n")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Prime operation failed.";
}
