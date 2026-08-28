# Pi Prime

Pi Prime injects user-authored Prime sources into Pi agent context.

## Install

Install the package with Pi, then restart or reload Pi:

```sh
pi install npm:@kenbanks-peng/pi-prime
```

## Protocol

On its first agent start, the extension creates this Global protocol file if it does not already exist:

```text
~/.agents/share/prime/prime.protocol.toml
```

The installed file is:

```toml
version = 1

[[rule]]
glob = "*.md"
action = "memory"

[[rule]]
glob = "*.command.toml"
action = "command"
```

This Global protocol applies to both scopes:

| Scope | Source root |
| --- | --- |
| Global | `~/.agents/share/prime/` |
| Project | `.agents/prime/` in the current project |

To override the policy for one project, create `.agents/prime/prime.protocol.toml`. The Project protocol applies only to Project sources. The Global protocol continues to apply to Global sources.

Pi reads only direct regular files in each source root. It ignores subdirectories, symbolic links, and files that do not match a rule. Rules run in declaration order. Matching files run in filename order. A file can match only one rule.

## Memory sources

The `memory` action reads the complete UTF-8 contents of matching files and injects each file as one memory.

```text
.agents/prime/review-guidance.md
```

The filename controls order. Pi does not inject the filename.

## Command sources

The `command` action reads matching `*.command.toml` files. Each file gives one direct executable invocation:

```toml
version = 1
argv = ["git", "status", "--short"]
cwd = "."
```

`argv[0]` is the executable. All other values are literal arguments. Pi does not use a shell.

`cwd` is optional. It is relative to the source root and cannot escape it. When omitted, Pi uses the source root.

On success, Pi injects UTF-8 standard output as one memory. Pi reports an error if a command fails, times out, produces invalid UTF-8, or exceeds the output limit. The fixed limits are 1,000 ms and 1,048,576 bytes of standard output.

## `/prime` command

Run `/prime` to show the command interface.

- `/prime list [global|project] [memory|command]` lists Prime sources.
- `/prime add [global|project] [memory|command]` creates a source. The defaults are `project memory`. When it adds a command source, it inserts `version = 1` automatically; the editor does not show this field.
- `/prime edit <id> [memory|command]` edits a source. Add its type if its ID is ambiguous.
- `/prime delete <id> [memory|command]` deletes a source. Add its type if its ID is ambiguous.

Examples:

```text
/prime add global memory
/prime add global command
/prime add project command
```

The extension gives each added source an ID such as `prime-5fdd69c9`. Memory source files end in `.md`. Command source files end in `.command.toml`.

## Context format

Pi resolves Global sources before Project sources. It adds this hidden message before conversation context:

```xml
<prime_memories version="1">
<memory>Global guidance</memory>
<memory>Project guidance</memory>
</prime_memories>
```

Pi XML-escapes memory source text and command output. Source data cannot add XML markup.
