import { PrimeRepository, scopeLabel, type PrimeScope } from "./prime-repository.js";

export interface PrimeCommandUI {
  hasUI: boolean;
  editor(title: string, initialValue: string): Promise<string | undefined>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

const api = "/prime list [global|project]\n/prime add [global|project]\n/prime edit <id>\n/prime delete <id>";
const usage = "Usage: /prime list [global|project] | add [global|project] | edit <id> | delete <id>";

export async function runPrimeCommand(args: string, primes: PrimeRepository, ui: PrimeCommandUI): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const [operation, argument] = tokens;

  try {
    switch (operation) {
      case "list":
        if (tokens.length > 2) throw new Error(usage);
        await listPrimes(argument, primes, ui);
        return;
      case "add":
        if (tokens.length > 2) throw new Error(usage);
        await addPrime(scopeFromArgument(argument), primes, ui);
        return;
      case "edit":
        if (tokens.length !== 2) throw new Error(usage);
        await editPrime(argument, primes, ui);
        return;
      case "delete":
        if (tokens.length !== 2) throw new Error(usage);
        await deletePrime(argument, primes, ui);
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

async function listPrimes(scopeArgument: string | undefined, primes: PrimeRepository, ui: PrimeCommandUI): Promise<void> {
  const scopes: PrimeScope[] = scopeArgument === undefined
    ? ["global", "project"]
    : [scopeFromArgument(scopeArgument)];
  const lists = await Promise.all(scopes.map(async (scope) => {
    const ids = await primes.list(scope);
    const contents = await Promise.all(ids.map(async (id) => ({ id, content: await primes.read(scope, id) })));
    return formatPrimeList(scope, contents);
  }));
  ui.notify(lists.join("\n\n"));
}

async function addPrime(scope: PrimeScope, primes: PrimeRepository, ui: PrimeCommandUI): Promise<void> {
  requireInteractiveUI(ui, "Adding");

  const content = await ui.editor(`Add ${scopeLabel(scope)} Prime`, "");
  if (content === undefined) {
    ui.notify(`${scopeLabel(scope)} Prime addition cancelled.`);
    return;
  }

  const id = await primes.create(scope, content);
  ui.notify(`Added ${scopeLabel(scope)} Prime "${id}".`);
}

async function editPrime(id: string | undefined, primes: PrimeRepository, ui: PrimeCommandUI): Promise<void> {
  requireInteractiveUI(ui, "Editing");
  const scope = await scopeForId(id!, primes);
  const content = await primes.read(scope, id!);
  const updatedContent = await ui.editor(`Edit ${scopeLabel(scope)} Prime`, content);
  if (updatedContent === undefined) {
    ui.notify(`${scopeLabel(scope)} Prime edit cancelled.`);
    return;
  }

  await primes.edit(scope, id!, updatedContent);
  ui.notify(`Edited ${scopeLabel(scope)} Prime "${id}".`);
}

async function deletePrime(id: string | undefined, primes: PrimeRepository, ui: PrimeCommandUI): Promise<void> {
  const scope = await scopeForId(id!, primes);
  await primes.delete(scope, id!);
  ui.notify(`Deleted ${scopeLabel(scope)} Prime "${id}".`);
}

function requireInteractiveUI(ui: PrimeCommandUI, operation: string): void {
  if (!ui.hasUI) {
    throw new Error(`${operation} a Prime requires interactive UI. ${usage}`);
  }
}

async function scopeForId(id: string, primes: PrimeRepository): Promise<PrimeScope> {
  const scopes = (await Promise.all(
    (["global", "project"] as const).map(async (scope) => (await primes.list(scope)).includes(id) ? scope : undefined),
  )).filter((scope): scope is PrimeScope => scope !== undefined);

  if (scopes.length === 0) {
    throw new Error(`Prime "${id}" does not exist.`);
  }
  if (scopes.length > 1) {
    throw new Error(`Prime "${id}" exists in both scopes.`);
  }
  return scopes[0]!;
}

function scopeFromArgument(value: string | undefined): PrimeScope {
  if (value === undefined) return "project";
  if (value === "global" || value === "project") return value;
  throw new Error(`Invalid Prime scope "${value}". Use global, project, or omit the scope to list both.`);
}

function formatPrimeList(scope: PrimeScope, primes: Array<{ id: string; content: string }>): string {
  const label = `${scope}:`;
  return primes.length === 0
    ? `${label} none`
    : `${label}\n${primes.map(({ id, content }) => `- ${content} [${id}]`).join("\n")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Prime operation failed.";
}
