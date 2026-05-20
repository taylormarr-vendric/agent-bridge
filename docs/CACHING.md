# Prompt Caching — v0.5.1

## Goal

Cut the per-call cost of the Planner and Reviewer spawns by ~90% on the
system-prompt portion, by letting Anthropic's prompt cache serve the
role memory after the first call.

## The problem with v0.5

`server.js` in v0.5 calls `spawn("claude", ["-p"])` and writes this
combined blob to the child's stdin:

    SYSTEM CONTEXT (your role and rules):
    <PLANNER.md or REVIEWER.md contents>
    ---
    USER MESSAGE:
    <executor's prompt>

That is **entirely a user message** as far as Claude Code is concerned.
The child session still loads its default system prompt (which contains
per-machine dynamic sections — cwd, git status, env info — that change
between calls). The result is two cache-defeating problems:

1. The default system prompt prefix shifts between calls, so even the
   stable framework portion can miss cache.
2. The role memory we *want* to cache is buried inside the user message,
   which is the variable layer the cache does not target.

## The fix: `--system-prompt-file <path>`

Claude Code exposes `--system-prompt-file <path>` (real flag, see
[CLI reference](https://code.claude.com/docs/en/cli-reference.md)).
When passed, the file's contents replace the default system prompt for
that session. The default per-machine dynamic sections are not loaded.

Claude Code applies prompt caching to the system-prompt prefix
automatically. There is no `--cache-control` flag and one is not needed
— per [Claude Code prompt caching docs](https://code.claude.com/docs/en/prompt-caching.md),
caching is managed via prefix matching with a 5-minute TTL. Two
`claude -p` invocations within 5 minutes that pass the same
`--system-prompt-file` (i.e. identical content) get a cache read on
the entire system-prompt block on the second call.

### What changes in `runChildClaude`

Before (v0.5):

    spawn("claude", ["-p"], { ... })
    stdin <-- memory + "---" + userPrompt

After (v0.5.1):

    spawn("claude", ["-p", "--system-prompt-file", memoryPath], { ... })
    stdin <-- userPrompt

The role memory file path moves to argv. The memory **contents** never
appear on argv, only the path does — the v0.4 "no prompt content on
argv, no shell, no quoting surface" rule still holds (a path is a
controlled internal string, not user input).

## Expected savings

- **First call within a TTL window:** no change. Full token cost on the
  system prompt and user prompt.
- **Second through Nth call within 5 min, same memory file:** the
  ~2-4 KB role memory is served from cache at the standard cached-read
  rate (~10% of the uncached input rate per Anthropic pricing). The
  per-call user prompt is never cached and pays full rate.
- **Net effect on a tight planner ↔ executor ↔ reviewer loop** where
  iterations are seconds apart: the role memory portion is paid for
  once per role per 5-minute window. For workflows where the role
  memory is ~3 KB and the user prompt is small, that's roughly the
  promised ~90% reduction on the system-prompt input tokens after the
  first call.

## What this does NOT speed up

- Output tokens (no cache for generation).
- User prompt tokens (variable per call, not cached).
- The first call in a window (cache write, not read).
- Calls spaced more than 5 minutes apart (cache eviction).
- A cold bridge restart followed by a single call (no second call to
  hit the cache).

## Caveats and gotchas

- **Identical-prefix requirement.** Any drift in the memory file —
  including whitespace, CRLF vs LF, BOM — kills the cache hit. The
  bridge reads the file via the CLI (not Node), so the file as it
  exists on disk is what gets hashed. If the user edits PLANNER.md
  mid-session, the next call writes a new cache entry; subsequent calls
  hit it.
- **Default system prompt is not loaded.** With `--system-prompt-file`
  in play, the per-machine sections (`--exclude-dynamic-system-prompt-sections`
  controls these on the default prompt) are not present. This is
  intentional — the role memory is the full system context the child
  needs. The CLI help notes that `--exclude-dynamic-system-prompt-sections`
  is ignored when `--system-prompt[-file]` is used, so we don't combine
  the two flags.
- **5-minute TTL only.** The 1-hour TTL (`ENABLE_PROMPT_CACHING_1H=1`)
  requires API-key billing per Anthropic docs. The bridge runs under
  the user's Claude Code OAuth subscription by default, so this is
  out of scope for v0.5.1.

## Backward compatibility

Old `claude` binaries without `--system-prompt-file` exist. At bridge
startup, `server.js` probes feature support with `claude --help` and
caches the result:

- **Supported:** spawn with `--system-prompt-file <path>` (the new
  path). Caching applies.
- **Not supported:** fall back to the v0.5 stdin layout (memory +
  separator + user prompt on stdin). No caching, behavior identical to
  v0.5.

The startup banner reports which path is active:

    agent-bridge v0.5.1 (planner + reviewer, system-prompt-file, prompt caching) running on stdio
    # or, on old CLI:
    agent-bridge v0.5.1 (planner + reviewer, stdin fallback, no caching) running on stdio

## What we are NOT doing in v0.5.1

- **No direct Anthropic API calls.** Bypassing the CLI would require
  an API key in env and change the trust/billing model. Out of scope.
- **No `--bare`.** It strips useful auto-discovery and forces
  `ANTHROPIC_API_KEY` or `apiKeyHelper`, changing the auth flow. Out of
  scope.
- **No `--model` selection per role.** Cheaper-Reviewer (Haiku) is on
  the v0.6 wishlist but needs separate design (cost / capability trade,
  per-role config schema).
- **No empirical cache-hit verification.** `claude -p` does not surface
  `cache_read_input_tokens` to stdout in text mode. Future work: switch
  to `--output-format json` to capture cache stats per call.
