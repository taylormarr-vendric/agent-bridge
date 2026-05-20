# agent-bridge

A small MCP stdio server that lets a coding Claude session (the
**Executor**) call two other Claude sessions on demand: a **Planner** and
an **independent Reviewer**. Each "other" session is a one-shot
`claude -p` child process with its own system prompt.

The Executor stays in your IDE and orchestrates the loop:

    Executor (in IDE)  ──►  ask_planner  ──►  TASK / PLAN / DECISION
    Executor implements the TASK
    Executor  ──►  ask_reviewer  ──►  APPROVE / REQUEST CHANGES / BLOCK
    Executor revises and loops back to ask_reviewer until APPROVE.

It is roughly 130 lines of JavaScript (`server.js`) plus this README.
There is no daemon, no web server, no state kept inside the bridge.
Loop state lives entirely in the Executor's conversation context.

This is **v0.5.1**. It is a working prototype, not a production loop.
See `docs/LOOP_DESIGN.md` for the loop design and `docs/CACHING.md` for
the prompt-caching strategy. The "Honest limits" section below covers
what the bridge does and does not do.

## Tools exposed

| Tool           | System prompt source              | Loaded            | Use                                              |
|----------------|-----------------------------------|-------------------|--------------------------------------------------|
| `ask_planner`  | `~/.claude/PLANNER.md`            | At startup (fatal if missing)  | Request a TASK, PLAN, or DECISION.                |
| `ask_reviewer` | `~/.claude/REVIEWER.md`           | Lazy, first call (error returned if missing)   | Get an independent review of a handoff report.    |

Both tools take a single `prompt` string and return the child session's
verbatim stdout.

## How a call works

1. The Executor calls `ask_planner` or `ask_reviewer` with a `prompt`.
2. `server.js` spawns `claude -p` with `shell: false` and `windowsHide: true`.
3. It writes the contents of the matching memory file
   (`PLANNER.md` or `REVIEWER.md`) followed by a `---` separator and the
   Executor's prompt to the child's **stdin**, then closes stdin.
4. The child's stdout is returned to the Executor as the tool result.

No prompt content is ever passed as a CLI argument and no shell
interpreter sees it. See `ARCHITECTURE.md` for why.

## Setup

Prerequisites:

- Node.js 18 or newer (uses ES modules and `node:` builtins).
- The `claude` CLI on `PATH`. `server.js` calls `spawn("claude", ["-p"])`
  directly with no path qualifier.
- A file at `~/.claude/PLANNER.md` containing the planner's system
  prompt (role, rules, expected output format). If this file is missing,
  `server.js` exits with a fatal error on startup.
- Optionally, a file at `~/.claude/REVIEWER.md` containing the
  reviewer's system prompt. If this file is missing, the bridge still
  starts; only `ask_reviewer` calls will fail (with an actionable
  error). `ask_planner` is unaffected.

Starter templates: `examples/planner-memory.md`,
`examples/reviewer-memory.md`, and `examples/executor-memory.md` for the
Executor's CLAUDE.md.

Install:

```
npm install
```

Confirm it starts:

```
node server.js
```

You should see, on **stderr**:

```
agent-bridge v0.5.1 (planner + reviewer, --system-prompt-file, prompt caching) running on stdio
```

(If your `claude` CLI is too old to support `--system-prompt-file`, the
banner reads `... stdin fallback, no caching ...` instead. Behavior is
identical to v0.5 in that case — see `docs/CACHING.md`.)

The process then waits on stdin for MCP traffic. Stop it with Ctrl-C —
your MCP client will manage the process lifecycle in normal use.

## Configuring an MCP client

Point your MCP client at the absolute path to `server.js`. For Claude
Code, add an entry like this to your MCP config:

```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "node",
      "args": ["C:\\Users\\you\\projects\\agent-bridge\\server.js"]
    }
  }
}
```

Adjust the path for your OS. The server reads no environment variables
of its own, but it inherits the parent process environment so the
spawned `claude` child can find its own credentials.

## Usage

From inside the Executor session, both tools appear as available MCP
tools. Send each a `prompt` string. A typical loop iteration looks
like this on the Executor side:

```
// 1. Get a TASK from the Planner
ask_planner({ prompt: "I need to add ... Please return a TASK block." })

// 2. (Executor implements the TASK in the repo.)

// 3. Send the handoff report to the Reviewer
ask_reviewer({ prompt: "Here is my handoff report. Please review. ...<report>..." })

// 4. If REQUEST CHANGES, revise and call ask_reviewer again.
//    If APPROVE, hand control back to the user.
//    If BLOCK, take it to ask_planner to revise the contract.
```

The Executor's role file (`~/.claude/CLAUDE.md`, modelled on
`examples/executor-memory.md`) is where the loop discipline lives —
termination conditions, call caps, when to escalate from Reviewer back
to Planner.

## Backward compatibility with v0.4

- `ask_planner` is unchanged. Same input schema, same output.
- `PLANNER.md` is still required at startup, same fatal-on-missing
  behavior.
- Existing deployments with no `REVIEWER.md` keep working; only
  `ask_reviewer` calls fail (with a structured error), the bridge does
  not crash.

## Honest limits

- **Same-model caveat, both roles.** Planner and Reviewer are both
  Claude. They are fresh sessions with different system prompts — not
  different models, not different vendors. They are independent of each
  other but share blind spots with the rest of the loop. The Reviewer's
  APPROVE means "reasonable to merge," not "guaranteed correct."
- **Cost: up to 3x per iteration on cold calls.** Executor + Planner +
  Reviewer is three Claude invocations per loop turn. v0.5.1 enables
  prompt caching on the Planner and Reviewer system prompts: after the
  first call within a 5-minute window, the ~2-4 KB role memory is
  served from cache (~10% of the uncached input rate) — see
  `docs/CACHING.md`. The user prompt and output tokens are never
  cached, so caching cuts the system-prompt portion only, not the full
  per-call cost. Calls spaced >5 min apart and cold bridge restarts
  pay the full rate.
- **5-minute hard timeout.** A single tool call is killed after 5
  minutes. Long planner or reviewer responses on large diffs may not
  fit.
- **No streaming.** The Executor sees nothing until the child has
  finished and `claude -p` exits. No incremental output.
- **No retries.** If `claude -p` exits non-zero, the error is returned
  to the Executor and the call is over. No automatic backoff.
- **No conversation history inside the bridge.** Each call is a fresh
  `claude -p` process. The only system context the child sees is its
  memory file plus the Executor's prompt for this call.
- **Loop state is fragile.** It lives in the Executor's conversation
  context. If that context is compacted or the IDE session restarts,
  loop continuity is lost.
- **No automated tests.** The bridge ships without a test suite. The
  loop is verified by running it. Splitting `server.js` so spawn and
  memory-load helpers can be unit-tested is on the v0.6 wishlist.

## License

MIT. See [LICENSE](LICENSE).
