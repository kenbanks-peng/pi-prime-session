# Pi Prime

A Pi extension that lets the user explicitly manage durable memories while preventing the agent from authoring them.

## Language

**Prime**:
A durable, user-authored memory managed through the Pi Prime extension. A Prime is never authored or modified by the agent and is automatically injected into the agent context.
_Avoid_: agent memory, note

**Prime command**:
A user-facing slash-command operation that creates, reads, updates, or deletes a Prime.
_Avoid_: agent tool, memory tool

**Global Prime**:
A Prime stored under `~/.agents/share/prime`, available to every Pi project.

**Project Prime**:
A Prime stored under `.agents/prime` at the current project root, available only in that project.

**Prime composition**:
The automatic injection of Global Primes followed by Project Primes for agent context. The extension reads the current files when context is prepared; no locking or session snapshot is needed.

**Prime ID**:
A required URL-safe identifier that names a Prime and maps to its individual Markdown filename. It is unique only within a scope.
