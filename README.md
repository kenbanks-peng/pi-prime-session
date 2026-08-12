# Pi Prime

A Pi extension for user-managed durable **Primes**: Markdown guidance stored outside the agent's command surface.

## Install

Install the package with Pi, then restart or reload Pi:

```sh
pi install npm:@kenbanks-peng/pi-prime
```

## `/prime` command

Running `/prime` displays its command interface, with one operation per line.

- `/prime list [global|project]` displays Global Primes followed by Project Primes by default. Each Prime ends with its ID in brackets, for example `[prime-5fdd69c9]`. Add a scope to display only that scope. Empty scopes display as `global: none` or `project: none`.
- `/prime add [global|project]` opens the Pi editor to author a Project Prime by default. Add `global` to add a Global Prime.
- `/prime edit <id>` opens the matching Prime in the Pi editor. The ID determines its scope.
- `/prime delete <id>` deletes the matching Prime. The ID determines its scope.

The extension assigns each added Prime a short unique ID such as `prime-5fdd69c9` for its Markdown filename. The ID is shown after addition and identifies the Prime in list output; users never need to define one.

Global Primes live in `~/.agents/prime`; Project Primes live in `.agents/prime` under the current project. Directories are created only when a user adds a Prime.
