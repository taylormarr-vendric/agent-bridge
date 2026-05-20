# Bounded Planner Callback on BLOCK — v0.6 Design Report

## Status

Design only. No code in this commit. The original TASK pointed at files
that don't exist in agent-bridge (`backend/routes/chat.js`,
`backend/agents/planner_bridge.js`, `backend/tests/test_suite.js`) and
used a `VENDRIC_*` env-var prefix, which suggests it was authored for
a different Vendric Labs project (C.A.I.G.E.?). This doc adapts the
same feature design to agent-bridge's actual layout (flat repo, one
`server.js`, no test suite yet).

If the TASK was actually intended for the other project, this doc
still captures the right logic — just substitute file paths.

## Problem

In v0.5.1 the loop on a BLOCK looks like:

    Executor  ──►  ask_reviewer ──► REVIEW (STATUS: BLOCK)
    Executor surfaces BLOCK to the human
    Human reads BLOCK
    Human (or Executor with explicit user OK) calls ask_planner with
        BLOCK findings to request a revised contract
    Executor resumes with revised contract

The human is on the critical path for the most consequential failure
mode — contract-level disagreement between reviewer and planner.
v0.5.1 documents this honestly but it is the next clear loss of
autonomy worth closing.

v0.6 goal: when a review returns BLOCK, the bridge can auto-invoke the
planner once to request a revised contract, return that revised
contract to the caller, and stop. A depth cap prevents runaway.

## Constraints inherited from v0.5.1

- `claude -p` children remain one-shot and stateless. No shared
  conversation history between the planner and reviewer calls in a
  callback chain.
- stdin-only / `--system-prompt-file` spawn shape preserved. No new
  argv content beyond what the path already adds.
- Bridge stays stateless **across** tool calls. Depth tracking exists
  only within a single wrapped call's chain.
- Backward compatibility: `ask_planner` and `ask_reviewer` unchanged
  unless opted into the callback path.

## Design

### Where does the callback live?

Three options considered, ranked:

| Option | Where the callback runs | Depth tracking | Verdict |
|---|---|---|---|
| A. Executor-driven (status quo) | IDE Claude | N/A — human | Baseline, not v0.6 |
| B. Reviewer-driven | Spawned `claude -p` reviewer calls back into the bridge over MCP | Hard — bridge doesn't know who called from where | Reject for v0.6 |
| C. Bridge-driven | Bridge wraps the reviewer flow and chains the planner on BLOCK | Trivial — counter is per-call | **Picked** |

Option C is the smallest delta from v0.5.1 — the bridge already owns
the spawn primitive, so centralizing the chain is a few dozen lines
and gives us the depth cap for free. Option B (reviewer calls back via
MCP) is more decentralized and arguably more "agentic," but it
fundamentally cannot enforce a depth cap from the bridge side without
ALSO adding state-passing through the MCP protocol — and that's a
v0.7-shape problem.

### Tool surface

New MCP tool: **`review_with_callback`** (not a flag on `ask_reviewer`
— a separate tool, so callers know they may incur extra spawns).

Signature:

    review_with_callback({
      prompt: string,           // reviewer prompt (handoff report)
      original_task: string,    // verbatim TASK contract
      prior_contract: string?,  // optional, same as original_task for first hop
      depth?: number,           // defaults to 0, caller never sets >0 directly
      correlation_id?: string,  // generated if absent
    })

Returns one of:

    { status: "approve" | "request_changes",
      review: string,
      depth: 0,
      correlation_id: string }

    { status: "revised",
      review: string,            // the BLOCK review verbatim
      revised_contract: object,  // parsed JSON revised TASK
      depth: 1,
      correlation_id: string }

    { status: "blocked",         // BLOCK but depth cap hit
      review: string,
      depth: 1,
      correlation_id: string,
      reason: "PLANNER_DEPTH_EXCEEDED" }

    { status: "failed",
      depth: number,
      correlation_id: string,
      reason: "PLANNER_CALLBACK_DISABLED"
            | "PLANNER_TIMEOUT"
            | "PLANNER_BAD_JSON",
      detail?: string }

`ask_reviewer` and `ask_planner` remain unchanged and are still
available for callers that don't want the chain.

### Env gating

`AGENT_BRIDGE_PLANNER_CALLBACK=true` to enable. Off by default. When
unset or any other value, `review_with_callback` returns immediately
with `status: "failed"` and `reason: "PLANNER_CALLBACK_DISABLED"`. The
unwrapped `ask_planner` / `ask_reviewer` tools still work either way.

Rationale for off-by-default: this is the first bridge behavior that
makes an extra Claude call the caller didn't directly request. Opt-in
preserves the "transparent RPC" mental model for everyone else.

(Env var named with the `AGENT_BRIDGE_` prefix, not `VENDRIC_`, since
this is a public repo with no Vendric branding.)

### Depth cap

`maxDepth = 1` baked in. Not user-tunable in v0.6. If `depth >= 1` and
the review is BLOCK, the bridge does **not** spawn the planner and
returns `status: "blocked"` with `reason: "PLANNER_DEPTH_EXCEEDED"`.

`maxDepth = 1` means: at most ONE planner revision per wrapped call.
The revised contract is handed back; the caller decides whether to
re-implement and re-review. That re-review is a fresh
`review_with_callback` call with `depth = 0` again. So the cap is
"depth per chain," not "lifetime depth" — which is what we want.

Why 1 and not 2 or 3? Empirically uncertain, but the principled answer
is: at depth 2+, the planner is revising a revision based on a review
of an implementation of a revision. The chance the bridge can recover
without human input is low; the chance of token waste is high. Pull
the human in.

### correlationId

Bridge generates a UUID on first call (or accepts caller-provided),
threads it through every spawn in the chain, and logs it on the
stderr banner of each spawn. No persistence; this is for traceability
in stderr only. Sufficient for v0.6.

### JSON contract for the revised TASK

The planner's normal output is free text. For the callback path, the
bridge sends a strict prompt that asks for a JSON envelope:

    {
      "revised_task": {
        "task": "...",
        "context": "...",
        "files": [ ... ],
        "contract": { ... },
        "steps": [ ... ],
        "acceptance": { ... },
        "out_of_scope": [ ... ]
      },
      "rationale": "..."
    }

Bridge parses, validates required keys (`revised_task.task`,
`revised_task.steps`, `revised_task.acceptance`), and returns
`PLANNER_BAD_JSON` on any parse/validation failure. The raw planner
stdout is returned in `detail` for debugging.

Tolerant parsing for v0.6: strip ` ```json ... ``` ` code fences,
trim leading prose paragraphs up to the first `{`, but otherwise
strict. The reviewer-memory and planner-memory templates need a note
about the BLOCK-callback JSON shape so the planner produces it
reliably.

This is the first time the bridge enforces a schema. We're crossing a
line — from free-text RPC to a constrained protocol. README must
disclose this honestly.

### What the bridge does NOT do

- Not parse normal `ask_planner` output. The JSON schema applies only
  to the BLOCK callback path.
- Not re-implement code in response to the revised contract. The
  caller (Executor) does that.
- Not re-review automatically. The caller decides whether to call
  `review_with_callback` again with `depth = 0`.

## Tests

v0.5.1 shipped with no test suite. v0.6 changes that — the depth cap
and env gate are precisely the kind of guard-rails that don't exist
unless tested.

Minimal test harness using Node's built-in `node:test` runner. No new
dependencies. Refactor extracts:

- `lib/spawn.js` — `runChildClaude(memoryPath, userPrompt)`, the same
  function we have today, mockable in tests.
- `lib/callback.js` — `reviewWithCallback(args, { spawn })`, where
  `spawn` defaults to the real one but is injectable for tests.
- `server.js` — wiring only.

Tests (with mocked spawn):

| # | Scenario | Expected |
|---|---|---|
| 1 | `AGENT_BRIDGE_PLANNER_CALLBACK` unset, BLOCK review | `status: failed`, `reason: PLANNER_CALLBACK_DISABLED`, planner NOT spawned |
| 2 | Enabled, `depth = 0`, BLOCK review, valid JSON | `status: revised`, `revised_contract` populated, planner spawned once |
| 3 | Enabled, `depth = 1`, BLOCK review | `status: blocked`, `reason: PLANNER_DEPTH_EXCEEDED`, planner NOT spawned |
| 4 | Enabled, BLOCK review, planner returns garbage | `status: failed`, `reason: PLANNER_BAD_JSON`, `detail` contains raw output |
| 5 | Enabled, BLOCK review, planner times out (mock long delay) | `status: failed`, `reason: PLANNER_TIMEOUT` |
| 6 | Enabled, review is APPROVE | `status: approve`, planner NOT spawned |
| 7 | Enabled, review is REQUEST CHANGES | `status: request_changes`, planner NOT spawned |
| 8 | Enabled, correlation_id provided | Same id appears in both spawn calls (mock spawn records args) |

`npm test` wires up `node --test lib/`. No CI in this commit.

## Risks and honest limits

- **Cost: now up to 4x per iteration on a BLOCK.** Executor + reviewer
  + planner-revision spawn + executor re-implements + a potential
  re-review. v0.5.1's "up to 3x per iteration" becomes 4x on the
  blocked path.
- **Depth cap = 1 is a policy choice, not a proof.** A pathological
  planner ↔ reviewer disagreement could still produce a revised
  contract that the human has to discard. The cap prevents token
  spiral, not bad output.
- **JSON parsing is strict.** Any drift in planner output format
  triggers `PLANNER_BAD_JSON`. Mitigation: the lenient pre-parse step
  (strip fences, trim prose). Long-term mitigation: structured output
  via Claude's JSON-mode flag if/when we adopt it.
- **First non-transparent tool.** `review_with_callback` may issue
  additional Claude calls without the caller asking. README must
  surface this prominently; otherwise users are surprised by 2x cost.
- **Bridge is now stateful within a call.** It tracks depth and a
  correlation id. Still stateless across calls. Documenting honestly.
- **No persistent log of callback chains.** stderr only. If the
  Executor wants a trace, log on its side.

## Commit plan

1. `docs/AGENT_LOOP.md` — this design doc (uncommitted today; commit
   after Planner review).
2. `lib/spawn.js` + adjust `server.js` to import it. Pure refactor,
   no behavior change. Add `node --test` smoke test for the existing
   spawn path.
3. `lib/callback.js` — implement `reviewWithCallback` with env gate,
   depth cap, JSON validation. Not yet wired into `server.js`.
4. Tests 1-8 (mocked spawn).
5. `server.js` — wire `review_with_callback` as the new MCP tool.
6. `package.json` to `0.6.0`, README + ARCHITECTURE updates, new
   honest-limits entries (4x BLOCK cost, first non-transparent tool,
   first schema-enforced path).
7. `examples/planner-memory.md` + `examples/reviewer-memory.md`
   updates explaining the JSON envelope expected on BLOCK callback
   chains.

~6-7 commits. ~250-400 lines of new code (mostly tests). M complexity.

## Out of scope (deferred to v0.7+)

- Persistent state (session log, replay).
- `maxDepth > 1` or user-configurable depth.
- Reviewer-initiated callbacks (Option B above).
- Structured message passing on the unwrapped `ask_planner` /
  `ask_reviewer` tools.
- Autonomous multi-turn loops without a human in the loop at all.
- CI/lint.

## Open questions for the Planner

1. **Repo confirmation.** The TASK's FILES pointed at
   `backend/routes/chat.js` etc. agent-bridge doesn't have those.
   Should this v0.6 land in agent-bridge (this doc's default), or
   should this design be handed off to the other repo (C.A.I.G.E.)
   where the original TASK is presumably correctly scoped?
2. **Tool shape.** New `review_with_callback` tool (this doc's pick)
   or a flag on existing `ask_reviewer` (`{ allow_planner_callback:
   true }`)? Flag-on-existing is one fewer tool but blurs the
   transparent-RPC mental model. Separate tool is more honest.
3. **Env var name.** `AGENT_BRIDGE_PLANNER_CALLBACK` (this doc's pick)
   or shorter `PLANNER_CALLBACK_ENABLED`? Prefer the prefixed form for
   public-repo namespace hygiene.
4. **JSON tolerance.** Strip code fences and trim leading prose
   (this doc's pick), or strict parse-or-fail like the TASK errors
   imply? Tolerant is more useful in practice; strict is easier to
   test.
5. **Test framework.** `node --test` (this doc's pick — zero deps) or
   `vitest`/`jest` (richer ergonomics but adds a dev dependency)?
6. **Memory file updates.** The planner role currently outputs free
   text. For the callback chain to work, the planner role must
   produce the JSON envelope when asked. Do we update the shipped
   `examples/planner-memory.md` template, or document the JSON
   envelope as a per-call instruction the bridge prepends to the
   prompt? (Picking per-call instruction is more robust — it doesn't
   require users to update their `~/.claude/PLANNER.md`.)
