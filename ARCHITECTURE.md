# Architecture

`server.js` is small enough to read in one sitting. This document explains the
non-obvious decisions in it — the ones a reader would look at and ask "why this
way?"

## The shape

```
Executor (claude in your editor)
    |
    | MCP stdio  (JSON-RPC over stdin/stdout)
    v
server.js   ── reads ──>  ~/.claude/PLANNER.md
    |
    | spawn("claude", ["-p"], { shell: false })
    | writes PLANNER.md + separator + user prompt to stdin
    v
Planner (claude -p, stdin-driven, one-shot)
```

The bridge process is the only long-lived piece. The Planner is a one-shot
child process per call.

## What did not work

**Passing the prompt as a CLI argument.** The natural first attempt was
`spawn("claude", ["-p", combinedPrompt])`. This failed for two related reasons:

1. **Shell quoting.** When the prompt contained quotes, backticks, dollar
   signs, or newlines — which it always did, because reviews contain code —
   the argument had to be escaped per-platform. The bug surface for quoting
   issues was large.
2. **Argv length limits.** Even with `shell: false`, Windows imposes a
   ~32k character limit on the combined command line. Real handoff reports
   plus the planner system prompt blew past this regularly.

**Passing the prompt through a shell.** `spawn(..., { shell: true })` was
briefly considered to dodge argv-list parsing. It made the quoting problem
strictly worse, opened a shell-injection path through user-supplied prompt
content, and was abandoned the same day.

**Sourcing the planner system prompt from an env var.** Same argv/length
limit on Windows; also leaks into child process listings.

## What works: stdin-only, no shell

The current design:

- `spawn("claude", ["-p"], { shell: false, windowsHide: true })` — no shell
  interpreter ever sees the prompt, and no prompt content is on the command
  line.
- The combined input — planner system prompt, a `---` separator, then the
  Executor's user prompt — is written to the child's stdin and stdin is
  closed.
- The Planner's stdout is captured and returned. Stderr is captured for
  error reporting.

This makes the prompt content opaque to anything between the bridge and the
Planner. No shell. No argv. No injection surface beyond what the prompt
itself contains, which is bounded by what the Executor would normally produce.

## The PLANNER.md memory file

`server.js` reads `~/.claude/PLANNER.md` **once at startup** and caches it in
memory for the life of the process. If the file is missing, the process exits
with a fatal error before any MCP traffic.

Why a file, not a constant in the source:

- The planner role is user-tunable. The same bridge serves different users
  with different planner rules.
- It lives next to `~/.claude/CLAUDE.md`, which is the Executor role file.
  The two are meant to be edited together.
- Caching at startup means MCP clients pick up changes by restarting the
  bridge (which they do whenever the MCP config changes), not mid-call.

A consequence: if you edit `~/.claude/PLANNER.md` and want the change live, the
bridge must be restarted. The Executor's MCP client does this automatically on
config reload, but ad-hoc tweaks in the middle of a session will not be picked
up until the next reload.

## Trade-offs

- **Synchronous, blocking calls.** A planner call blocks the Executor until
  the planner finishes or hits the 5-minute timeout. There is no concurrency
  inside a single Executor session. This is fine for review-style use
  ("here is my report, please review") and bad for tight loops.
- **No structured output.** The planner returns free text. The Executor parses
  it. There is no schema enforced by the bridge.
- **No request logging.** The bridge writes only the one stderr banner and
  whatever Node prints on crash. Calls are not recorded. If you want a trace,
  log on the Executor side.
- **Trust boundary.** The bridge assumes the Executor is a trusted caller.
  The `prompt` argument flows directly to a second Claude session with no
  filtering. Do not expose this server to untrusted MCP clients.
