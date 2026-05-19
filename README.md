# agent-bridge

A small MCP stdio server that exposes a single tool, `ask_planner`, to a coding
Claude session. The tool spawns a second `claude -p` process — the "planner" —
with a separate system prompt, so the coding session can request plans, task
breakdowns, and reviews from a session that is dedicated to thinking rather than
editing.

It is roughly 100 lines of JavaScript (`server.js`) plus this README. There is
no daemon, no web server, no state outside `~/.claude/PLANNER.md`.

## How it works

1. Your editor's Claude session (the **Executor**) is configured with this
   server as an MCP server.
2. When the Executor wants a plan or a review, it calls the `ask_planner` tool
   with a `prompt` argument.
3. `server.js` spawns `claude -p` with `shell: false` and `windowsHide: true`.
4. It writes the contents of `~/.claude/PLANNER.md` followed by a separator and
   the Executor's prompt to the child's **stdin**, then closes stdin.
5. The child's stdout is returned to the Executor as the tool result.

The planner prompt is never passed as a CLI argument and never goes through a
shell. See `ARCHITECTURE.md` for why.

## Setup

Prerequisites:

- Node.js 18 or newer (uses ES modules and `node:` builtins).
- The `claude` CLI on `PATH`. `server.js` calls `spawn("claude", ["-p"])`
  directly with no path qualifier.
- A file at `~/.claude/PLANNER.md` containing the planner's system prompt
  (role, rules, review format). If this file is missing, `server.js` exits
  with a fatal error on startup. See examples/planner-memory.md for a starter
  template, and examples/executor-memory.md for a matching executor role.

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
agent-bridge v0.4 (stdin-only, no shell) running on stdio
```

The process then waits on stdin for MCP traffic. Stop it with Ctrl-C — your
MCP client will manage the process lifecycle in normal use.

## Configuring an MCP client

Point your MCP client at the absolute path to `server.js`. For Claude Code,
add an entry like this to your MCP config:

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

Adjust the path for your OS. The server reads no environment variables of its
own, but it inherits the parent process environment so the spawned `claude`
child can find its own credentials.

## Usage

From inside the Executor session, the `ask_planner` tool will appear as
available. Send it a `prompt` string. A typical Executor handoff looks like:

```
ask_planner({
  prompt: "Here is my handoff report. Please review. ...<report>..."
})
```

The planner's full response is returned verbatim as the tool's text content.

## Honest limits

- **Same-model caveat.** Both Executor and Planner are Claude. The Planner is
  not a different model or a different vendor — it is a second Claude session
  with a different system prompt. They share blind spots. The review is real,
  but it is not an independent second opinion in the strict sense.
- **5-minute hard timeout.** A single `ask_planner` call is killed after 5
  minutes. Long reviews on large diffs may not fit.
- **No streaming.** The Executor sees nothing until the planner has finished
  and `claude -p` exits. There is no incremental output.
- **No retries.** If `claude -p` exits non-zero, the error is returned to the
  Executor and the call is over. There is no automatic backoff.
- **No conversation history.** Each call is a fresh `claude -p` process. The
  Planner has no memory of prior calls beyond what the Executor includes in
  the prompt and what is in `~/.claude/PLANNER.md`.
- **Cost doubles.** Every planner call is a second Claude invocation. Budget
  accordingly.

## License

MIT. See [LICENSE](LICENSE).
