# Plan: Prime Source Action Protocol v1

## Goal

Replace the current implicit behavior—injecting every direct `*.md` file in a Prime directory—with a deterministic, protocol-gated source-action protocol.

The protocol is activated only by a `prime.protocol.toml` file. Without that file, the extension must not inspect or inject any Markdown or command files in that scope. This makes existing files inert when the protocol is absent or removed.

The extension, not the agent, parses the protocol, matches files, executes supported actions, and builds the injected context.

## Locations

Each scope has an independent optional protocol file and source root:

| Scope   | Protocol file                               | Source root              |
| ------- | ------------------------------------------- | ------------------------ |
| Global  | `~/.agents/share/prime/prime.protocol.toml` | `~/.agents/share/prime/` |
| Project | `<cwd>/.agents/prime/prime.protocol.toml`   | `<cwd>/.agents/prime/`   |

Files are considered only when they are direct children of the associated source root. The v1 protocol does not recurse into subdirectories.

## Protocol file: `prime.protocol.toml`

```toml
version = 1

[[rule]]
glob = "*.md"
action = "inject-text"

[[rule]]
glob = "*.command.toml"
action = "run-command-inject-output"
```

The ordered `[[rule]]` array is the complete processing policy for a scope. A user may add Markdown or command files directly; they do not need to use `/prime` or edit the protocol file after adding a file.

### Rule schema

```ts
type PrimeProtocolV1 = {
  version: 1;
  rule: PrimeRuleV1[];
};

type PrimeRuleV1 = {
  glob: string;
  action: "inject-text" | "run-command-inject-output";
};
```

### Rule validation and matching

- `version` must be exactly `1`.
- `rule` must be an array of one or more rules.
- `glob` is a non-empty direct-file basename glob. It must not contain `/`, `\\`, `.` or `..` path segments.
- v1 must support at least `*.md` and `*.command.toml`.
- `action` must be one of the two action names defined in this plan.
- Rules are applied in declaration order.
- For each rule, matching files are sorted lexicographically by filename before the action runs.
- A regular file may match at most one rule. Overlapping rules are a validation error, rather than duplicating or ambiguously processing a source.
- Directories, symbolic links, nested files, and non-matching files are ignored.
- `prime.protocol.toml` is never a source file, even if a future rule pattern would otherwise match it.

An unreadable or malformed protocol file, invalid rule, ambiguous file match, unreadable selected file, or invalid selected command file is an actionable configuration error. The extension must not silently infer another action or source.

## Action: `inject-text`

`inject-text` accepts matching UTF-8 files and injects their complete contents as text memories.

For the standard Markdown rule:

```toml
[[rule]]
glob = "*.md"
action = "inject-text"
```

a user can add this file directly:

```text
.agents/prime/review-guidance.md
```

Its entire Markdown body is injected. The filename controls ordering only; it is not included in the memory content.

## Action: `run-command-inject-output`

`run-command-inject-output` accepts matching `*.command.toml` files. Each file describes exactly one command invocation.

Example source file: `worktree.command.toml`

```toml
version = 1
argv = ["git", "status", "--short"]
cwd = "."
```

### Command source schema

```ts
type CommandSourceV1 = {
  version: 1;
  argv: [string, ...string[]];
  cwd?: string;
};
```

### Command execution rules

- `version` must be exactly `1`.
- `argv` must be a non-empty array of strings. It is executed directly: `argv[0]` is the executable and the remaining strings are literal arguments.
- The action must not invoke a shell or concatenate `argv` into a shell command.
- `cwd`, when supplied, is a relative path beneath the scope source root. It must not be absolute or escape that root.
- Omitted `cwd` means the scope source root.
- The action captures stdout as UTF-8 text. On a zero exit status, stdout is injected as the memory content.
- A non-zero exit status, timeout, execution error, invalid UTF-8 output, or output exceeding the configured implementation limit is an actionable error and injects no command output.
- v1 uses implementation-defined fixed limits for execution time and captured output size. The implementation must expose those limits in its error messages and tests; per-command overrides are out of scope for v1.

The command source file is input to the action and is never itself injected as text.

## Enablement and absence semantics

| State                                        | Required behavior                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `prime.protocol.toml` absent                 | Contribute no Prime memories. Do not scan the source root.                                                      |
| Protocol file removed                        | On the next agent start, contribute no Prime memories. Existing `*.md` and `*.command.toml` files remain inert. |
| Protocol file present with no matching files | Contribute no Prime memories.                                                                                   |
| Protocol file present and valid              | Process exactly the files matched by its rules.                                                                 |
| Protocol file or selected source invalid     | Raise an actionable error and inject no partial output from that scope.                                         |

There is no `enabled` field. Presence of the protocol file opts a scope in; absence opts it out.

## Resolution and context injection

At `before_agent_start`:

1. Attempt to read the Global and Project protocol files.
2. Treat `ENOENT` for either protocol file as an inactive scope with zero memories.
3. Parse and validate each present TOML protocol.
4. For each rule in declaration order, list the direct regular files in its source root, match and sort them, then run the rule's action.
5. Resolve all Global memories before all Project memories.
6. If both scopes produce zero memories, return nothing from the hook. There must be no `prime_memories` custom message.
7. Otherwise, return the existing hidden Pi custom message:

```ts
{
  message: {
    customType: "prime_memories",
    content: renderedMemories,
    display: false,
  },
}
```

The existing `context` hook remains responsible only for moving the resulting `prime_memories` custom message ahead of conversation messages.

## Context representation

The resolved values are serialized in resolution order:

```xml
<prime_memories version="1">
<memory>Markdown guidance.</memory>
<memory>M src/index.ts</memory>
</prime_memories>
```

The serializer must XML-escape every memory value. Source text and command output are data, not XML markup: values containing `<`, `&`, or `</memory>` must remain literal content.

## Implementation steps

1. Add a TOML parser compatible with the Pi extension runtime and a dedicated protocol parser/validator module.
2. Change `PrimeRepository` from unconditional `.md` discovery to optional `prime.protocol.toml` loading for each scope.
3. Implement direct-file glob matching, deterministic sorting, overlap detection, and path containment checks.
4. Implement the `inject-text` action for UTF-8 file content.
5. Implement the `run-command-inject-output` action using direct executable invocation, fixed resource limits, stdout capture, and deterministic error reporting.
6. Compose action results as XML-escaped `<memory>` elements, Global before Project, and return no Pi message for an empty result.
7. Update `/prime` so it is clearly optional: it may create a Markdown file, but injection depends solely on a matching protocol rule.
8. Update the README with the TOML protocol, direct-file workflow, command source format, and absent-protocol behavior.

## Required tests

- Protocol absent in both scopes while `*.md` and `*.command.toml` files exist: no directory scan and no `prime_memories` message.
- Protocol removed while source files remain: no memory is injected on the next agent start.
- `*.md` with `inject-text`: direct Markdown files are injected in lexicographic filename order.
- A Markdown file added directly after the protocol is created is injected without `/prime` or protocol edits.
- Nested Markdown files, directories ending in `.md`, symbolic links, and non-matching files are ignored.
- `*.command.toml` with `run-command-inject-output`: a successful direct command injects its stdout.
- Command arguments are passed literally, without a shell.
- Command failure, timeout, output-limit overflow, malformed command TOML, and invalid `cwd` fail with useful errors and inject no command output.
- Global outputs precede Project outputs.
- Invalid TOML, invalid action names, unsupported globs, and overlapping rule matches fail deterministically.
- XML-sensitive Markdown and command output remain literal memory content after serialization.
- A valid protocol with no matching files returns no Pi custom message.
