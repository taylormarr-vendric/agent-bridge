# Architecture

`server.js` is small enough to read in one sitting. This document
explains the non-obvious decisions in it — the ones a reader would look
at and ask "why this way?"

## The shape (v0.5)

```
Executor (claude in your editor)        ── orchestrates the loop;
    |                                      conversation context = loop state
    | MCP stdio  (JSON-RPC over stdin/stdout)
    v
server.js   ── reads ──>  ~/.claude/PLANNER.md   (at startup, fatal if missing)
            ── reads ──>  ~/.claude/REVIEWER.md  (on first ask_reviewer, error if missing)
    |
    | spawn("claude", ["-p"], { shell: false })
    | writes <role memory> + separator + user prompt to stdin
    v
Planner (claude -p, stdin-driven, one-shot)   ── invoked via ask_planner
Reviewer (claude -p, stdin-driven, one-shot)  ── invoked via ask_reviewer
```

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

## What works: stdin-only, no shell

The current design, used by both `ask_planner` and `ask_reviewer`:

- `spawn("claude", ["-p"], { shell: false, windowsHide: true })` — no
  shell interpreter ever sees the prompt, and no prompt content is on
  the command line.
- The combined input — role system prompt, a `---` separator, then the
  Executor's user prompt — is written to the child's stdin and stdin is
  closed.
- The child's stdout is captured and returned. Stderr is captured for
  error reporting.

This makes the prompt content opaque to anything between the bridge and
the child. No shell. No argv. No injection surface beyond what the
prompt itself contains, which is bounded by what the Executor would
normally produce.

The spawn body lives in `runChildClaude(systemPrompt, userPrompt)` and
is shared by both tools. The only per-tool difference is *which* memory
file's contents are passed in as `systemPrompt`.

## The two memory files

`server.js` reads `~/.claude/PLANNER.md` **once at startup** and caches
it in memory for the life of the process. If the file is missing, the
process exits with a fatal error before any MCP traffic. This matches
the v0.4 behavior.

`~/.claude/REVIEWER.md` is read **lazily on the first ask_reviewer
call** and then cached for the life of the process. If it is missing at
that point, the call returns a structured Bridge error to the Executor
(pointing at `examples/reviewer-memory.md`); the bridge process does
not crash.

The split exists so that:

- Existing v0.4 deployments without a `REVIEWER.md` keep working. They
  can ignore `ask_reviewer` indefinitely.
- New v0.5 users opt in to the Reviewer role simply by creating
  `REVIEWER.md`. No flag, no config change.

Both files are read **once** per process lifetime. The bridge must be
restarted to pick up edits. The Executor's MCP client does this
automatically on config reload, but ad-hoc tweaks mid-session will not
be picked up until the next reload.

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
