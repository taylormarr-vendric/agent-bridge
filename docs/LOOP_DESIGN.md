# Loop Design — v0.5

## Goal

Extend agent-bridge from a one-shot planner RPC to a working
planner ↔ executor ↔ reviewer loop. v0.4 already supports a two-role
pattern (Executor in the IDE calls Planner via `ask_planner`). v0.5
splits a dedicated Reviewer role out of the Planner so the loop can be:

    Executor produces work  →  Reviewer critiques  →  Executor revises  →  repeat

## Hard constraint inherited from v0.4

Every spawned `claude -p` child is single-shot and stateless.
`ARCHITECTURE.md` documents three rejected approaches: CLI-arg passing,
shell-mode spawn, env-var prompt. The stdin-only / no-shell design is
non-negotiable and v0.5 reuses it verbatim. The new Reviewer path is the
same spawn pattern with a different memory file — not a new transport.

## Open questions, answered

### 1. Where does loop state live?

**Decision: nowhere new. The bridge stays stateless.**

- The Executor (Claude in the IDE) is the orchestrator. Its own
  conversation context already holds the prior plan, the produced code,
  and the prior review. That IS the loop state.
- Adding bridge-side state — in-memory cache, on-disk session log, MCP
  resource — would require session IDs, eviction policy, schema
  decisions, and a much larger tool surface. None of that is needed to
  make the loop work; all of it is over-build for v0.5.
- Honest limit: if the Executor's conversation context is compacted or
  the IDE session restarts, loop continuity is lost. Acceptable for a
  prototype; documented in the README.

### 2. How does the Reviewer get the Executor's output?

**Decision: new tool `ask_reviewer(prompt)`, structurally identical to
`ask_planner`.** The Executor formats the prompt body to include
whatever context the Reviewer needs (plan, diff, test output, etc).

- A structured `ask_reviewer({plan, execution, tests})` schema was
  considered and rejected. It would lock the bridge into one loop shape.
  Free-text prompt keeps the Executor free to evolve the format. The
  REVIEWER.md memory file defines what shape the Reviewer expects on the
  consumer side, not the bridge side.

### 3. Termination condition?

**Decision: not the bridge's job.** Termination lives in the Executor's
role definition (`examples/executor-memory.md`).

- The bridge has no concept of "iterations." Each tool call is
  independent. The Executor decides when to stop calling, guided by:
  Reviewer returns `STATUS: APPROVE`, a max-iterations hint in
  `executor-memory.md`, or user intervention.

### 4. Backward compatibility?

**Decision: fully preserved.**

- `ask_planner` tool — unchanged signature and behavior.
- `~/.claude/PLANNER.md` — still required at startup, still fatal on
  missing (matches v0.4 exactly).
- `~/.claude/REVIEWER.md` — **lazy-loaded** on first `ask_reviewer`
  call. If missing at that point, the call returns a structured Bridge
  error to the Executor; the bridge process does NOT crash. Existing
  v0.4 users who never call `ask_reviewer` see zero behavior change.

## Loop shape (v0.5)

    User in IDE
        │
        ▼
    Executor (Claude in IDE)          ── conversation context = loop state
        │
        ├─ ask_planner(prompt) ─────► PLANNER.md + spawn claude -p ─► Plan / TASK
        │
        ├─ implements TASK in repo
        │
        ├─ ask_reviewer(prompt) ────► REVIEWER.md + spawn claude -p ─► Review verdict
        │
        ├─ revises (loop back to executor → reviewer until APPROVE)
        │
        ▼
    User reviews

## What does NOT change

- Single-shot, stateless `claude -p` child per call.
- stdin-only, no shell, no argv content (the v0.4 security posture
  established in `ARCHITECTURE.md`).
- 5-minute per-call timeout.
- No streaming, no retries, no conversation history inside the bridge.

## What DOES change in code

- `server.js` extracts a `runChildClaude(systemPrompt, userPrompt)`
  helper that both `ask_planner` and `ask_reviewer` use. No behavior
  change for `ask_planner`.
- Adds `ask_reviewer` tool with the same prompt-only input schema.
- Adds `loadReviewerPrompt()` with lazy load + structured "missing
  REVIEWER.md" error.
- Adds `examples/reviewer-memory.md` starter template.
- `examples/planner-memory.md` is updated to note that the standalone
  Reviewer is now the preferred path for independent reviews. Existing
  REVIEW output format on the Planner side is kept so users who only
  configure a Planner are not regressed.
- `examples/executor-memory.md` is updated to mention `ask_reviewer` in
  the WHEN BRIDGE IS AVAILABLE section.
- Banner becomes `agent-bridge v0.5 (planner + reviewer) running on stdio`.
- `package.json` bumped to `0.5.0`.

## Honest new limits to add in README

- **Cost can now 3x per iteration.** Executor + Planner + Reviewer are
  three Claude invocations per loop turn. Budget accordingly.
- **Same-model caveat applies to the Reviewer too.** Reviewer is a fresh
  Claude session with an independent system prompt — not a different
  model, not a different vendor. It is independent of the Planner
  session but shares blind spots with the rest of the loop.
- **Loop state is fragile.** It lives in the Executor's conversation
  context. Context compaction or session restart loses continuity.
- **No automated tests in v0.5.** v0.4 shipped none; v0.5 does not add a
  test harness. The loop is verified by running it. A future version
  may split `server.js` into module + entrypoint so the memory-load and
  spawn helpers can be unit-tested.

## Out of scope for v0.5

- Bridge-side session log or replay.
- Concurrent planner+reviewer calls.
- Streaming output.
- Structured (JSON-shaped) review schema.
- Cross-model routing (e.g., Sonnet planner + Opus reviewer).
- Tests — see "Honest new limits" above.

## Commit plan

1. This document (`docs/LOOP_DESIGN.md`).
2. Memory files: new `examples/reviewer-memory.md`, updated
   `examples/planner-memory.md` and `examples/executor-memory.md`.
3. `server.js`: extract `runChildClaude` helper, add `ask_reviewer`
   tool, add lazy-loaded REVIEWER.md, update banner.
4. `package.json` to `0.5.0`, `README.md` and `ARCHITECTURE.md` updated
   to honestly describe the v0.5 loop and new limits.
