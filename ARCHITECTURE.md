# Architecture

`server.js` is small enough to read in one sitting. This document
explains the non-obvious decisions in it — the ones a reader would look
at and ask "why this way?"

## The shape (v0.5.1)

```
Executor (claude in your editor)        ── orchestrates the loop;
    |                                      conversation context = loop state
    | MCP stdio  (JSON-RPC over stdin/stdout)
    v
server.js   ── validates ──>  ~/.claude/PLANNER.md   (at startup, fatal if missing)
            ── validates ──>  ~/.claude/REVIEWER.md  (on first ask_reviewer, error if missing)
    |
    | spawn("claude", ["-p", "--system-prompt-file", <role memory path>], { shell: false })
    | writes user prompt to stdin
    v
Planner (claude -p, stdin-driven, one-shot)   ── invoked via ask_planner
Reviewer (claude -p, stdin-driven, one-shot)  ── invoked via ask_reviewer
```

The role memory file path is the only prompt-related content on argv,
and a path is a controlled internal string, not user-supplied content —
so the v0.4 "no prompt content on argv, no shell" rule still holds.
Passing the memory as `--system-prompt-file` (rather than embedding it
in a user message on stdin) is what makes the system-prompt prefix
stable and cacheable across calls. See `docs/CACHING.md` for details.

If the local `claude` CLI is too old to support `--system-prompt-file`,
`server.js` detects this at startup (via `claude --help`) and falls
back to the v0.5 layout: memory + separator + user prompt all on
stdin, with the role memory living inside the user message. The
fallback is correct but does not cache.

The bridge process is the only long-lived piece. Each Planner or
Reviewer call is a fresh one-shot child process. The two roles are
distinct sessions with independent system prompts; they do not share
any state with each other or with their prior calls.

## What did not work (and is still ruled out in v0.5)

**Passing the prompt as a CLI argument.** The natural first attempt was
`spawn("claude", ["-p", combinedPrompt])`. This failed for two related
reasons:

1. **Shell quoting.** When the prompt contained quotes, backticks,
   dollar signs, or newlines — which it always did, because reviews
   contain code — the argument had to be escaped per-platform. The bug
   surface for quoting issues was large.
2. **Argv length limits.** Even with `shell: false`, Windows imposes a
   ~32k character limit on the combined command line. Real handoff
   reports plus the role system prompt blew past this regularly.

**Passing the prompt through a shell.** `spawn(..., { shell: true })`
was briefly considered to dodge argv-list parsing. It made the quoting
problem strictly worse, opened a shell-injection path through
user-supplied prompt content, and was abandoned the same day.

**Sourcing the role system prompt from an env var.** Same argv/length
limit on Windows; also leaks into child process listings.

## What works

`runChildClaude(memoryPath, userPrompt)` is shared by both tools; it
chooses between two spawn shapes based on startup feature detection.

### Supported path: `--system-prompt-file`

- `spawn("claude", ["-p", "--system-prompt-file", memoryPath], { shell: false, windowsHide: true })`
  — no shell interpreter sees the prompt; the only argv content is the
  memory file path, which is a controlled internal string and not
  user-supplied input.
- The CLI loads the memory file (`PLANNER.md` or `REVIEWER.md`) as the
  child session's system prompt. The Executor's user prompt is the only
  thing written to the child's stdin, and stdin is then closed.
- The child's stdout is captured and returned. Stderr is captured for
  error reporting.
- Because the system-prompt prefix is the file content and is stable
  across calls, Anthropic's prompt cache (5-minute TTL) hits on warm
  calls. See `docs/CACHING.md`.

### Fallback path (older CLI, no caching)

If startup feature detection (`claude --help`) does not find
`--system-prompt-file` support, the bridge spawns plain `claude -p`
and writes the combined input — role system prompt, a `---` separator,
then the Executor's user prompt — to the child's stdin in one chunk,
then closes stdin. This matches the v0.5 layout exactly. It is correct
but the system-prompt content lives inside the user message, which the
cache does not target.

Both paths preserve the v0.4 invariants: no shell, no user-supplied
prompt content on argv, no injection surface beyond what the prompt
itself contains (which is bounded by what the Executor would normally
produce).

## The two memory files

`server.js` **validates** that `~/.claude/PLANNER.md` is readable
**once at startup** (a `readFileSync` whose result is discarded). If
the file is missing, the process exits with a fatal error before any
MCP traffic. This matches the v0.4 fatal-on-missing contract.

`~/.claude/REVIEWER.md` is **validated lazily on the first
ask_reviewer call** the same way. If it is missing at that point, the
call returns a structured Bridge error to the Executor (pointing at
`examples/reviewer-memory.md`); the bridge process does not crash. The
"reviewer is readable" check is sticky after its first success so we
don't re-stat the file on every subsequent call.

The split exists so that:

- Existing v0.4 deployments without a `REVIEWER.md` keep working. They
  can ignore `ask_reviewer` indefinitely.
- New users opt in to the Reviewer role simply by creating
  `REVIEWER.md`. No flag, no config change.

Memory file **contents** are not held in the bridge process. On the
supported path the `claude` CLI re-reads the file (via
`--system-prompt-file`) on every spawn. On the fallback path Node
re-reads the file before writing it to stdin on every call. The
practical effect: edits to `PLANNER.md` or `REVIEWER.md` take effect
on the next `ask_planner` / `ask_reviewer` call without restarting the
bridge.

One edge case: if `REVIEWER.md` is deleted *after* the first successful
validation, the sticky "exists" flag means the bridge does not
re-emit its pretty Bridge error — the CLI's own missing-file error
will surface on the next call instead.

## Why two roles, not one

In v0.4 the Planner role was overloaded: it generated TASK specs and
also reviewed handoff reports. That works, but it has a known weakness
— the session that wrote the contract is the same session judging
whether the implementation matched the contract. It tends to be too
generous with implementations that drift from its own original
phrasing.

The v0.5 Reviewer is a fresh session that has not seen the planning
context. It evaluates only the handoff report against the contract
text. Different blind spots, different defaults. See
`examples/reviewer-memory.md` for the expected output discipline.

This is **not** an independent second opinion in the strict sense — see
the "Same-model caveat" in `README.md`. It is an independent *session*
with an independent system prompt, which catches a different class of
issues than self-review.

## Why the bridge stays stateless

The loop is orchestrated by the Executor, not the bridge. The
Executor's conversation context already holds the prior plan, the
produced code, and the prior review. That is the loop state.

Adding bridge-side state — an in-memory iteration cache, an on-disk
session log, an MCP resource for replay — would require session IDs,
eviction policy, schema decisions, and a much larger tool surface. None
of that is needed to make the loop work. All of it is over-build for
v0.5.

The trade-off: if the Executor's context is compacted or the IDE
session restarts, loop continuity is lost. This is acknowledged in
`README.md` under "Honest limits."

## Trade-offs

- **Synchronous, blocking calls.** A Planner or Reviewer call blocks
  the Executor until the child finishes or hits the 5-minute timeout.
  There is no concurrency inside a single Executor session. Fine for
  review-style use, bad for tight loops.
- **No structured output.** Planner and Reviewer return free text. The
  Executor parses it. No schema is enforced by the bridge.
- **No request logging.** The bridge writes only the one stderr banner
  and whatever Node prints on crash. Calls are not recorded. If you
  want a trace, log on the Executor side.
- **Trust boundary.** The bridge assumes the Executor is a trusted
  caller. Each tool's `prompt` argument flows directly to a second
  Claude session with no filtering. Do not expose this server to
  untrusted MCP clients.
- **Cost.** Each loop turn is potentially three Claude invocations
  (Executor + Planner + Reviewer). Budget accordingly.
