#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 5 * 60 * 1000;
const PLANNER_MEMORY_PATH = join(homedir(), ".claude", "PLANNER.md");
const REVIEWER_MEMORY_PATH = join(homedir(), ".claude", "REVIEWER.md");

// Validate planner memory at startup. Preserves the v0.4 fatal-on-missing
// contract so existing deployments fail loudly if misconfigured.
try {
  readFileSync(PLANNER_MEMORY_PATH, "utf8");
} catch (err) {
  console.error("FATAL: cannot read planner memory at " + PLANNER_MEMORY_PATH);
  process.exit(1);
}

// Feature detection: --system-prompt-file is the cacheable path (see docs/CACHING.md).
// Older claude binaries lack the flag; in that case fall back to the v0.5 stdin layout.
let supportsSystemPromptFile = false;
try {
  const help = execSync("claude --help", {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  // Main help lists the flag indirectly inside the --bare description as
  // "--system-prompt[-file]". Either spelling is sufficient evidence.
  supportsSystemPromptFile = /--system-prompt(-file|\[-file\])/.test(help);
} catch (err) {
  // If we can't even probe `claude --help`, the child spawn would fail too;
  // let the per-call error path surface that instead of failing at startup.
  supportsSystemPromptFile = false;
}

// Reviewer memory is validated lazily on first ask_reviewer call so v0.4 users
// without REVIEWER.md can still start the bridge and keep using ask_planner.
let reviewerValidated = false;
function ensureReviewerReadable() {
  if (reviewerValidated) return;
  try {
    readFileSync(REVIEWER_MEMORY_PATH, "utf8");
    reviewerValidated = true;
  } catch (err) {
    throw new Error(
      "Reviewer memory missing at " + REVIEWER_MEMORY_PATH +
      ". Create it (see examples/reviewer-memory.md) or call ask_planner instead."
    );
  }
}

function runChildClaude(memoryPath, userPrompt) {
  return new Promise((resolve, reject) => {
    // Two spawn shapes. Both keep prompt CONTENT off argv (v0.4 rule).
    //   Cached path: the role memory is passed via --system-prompt-file <path>;
    //                only the path (a controlled internal string) is on argv.
    //                The user prompt is the only thing on stdin.
    //   Fallback:    no --system-prompt-file support — write memory + separator
    //                + user prompt to stdin (the v0.5 layout).
    const args = supportsSystemPromptFile
      ? ["-p", "--system-prompt-file", memoryPath]
      : ["-p"];

    const child = spawn("claude", args, {
      shell: false,
      windowsHide: true,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Timeout after " + TIMEOUT_MS + "ms"));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error("Spawn error: " + err.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error("Exit " + code + ": " + (stderr || stdout)));
    });

    if (supportsSystemPromptFile) {
      child.stdin.write(userPrompt);
    } else {
      const memory = readFileSync(memoryPath, "utf8");
      const combinedInput =
        "SYSTEM CONTEXT (your role and rules):\n" +
        memory +
        "\n\n---\n\nUSER MESSAGE:\n" +
        userPrompt;
      child.stdin.write(combinedInput);
    }
    child.stdin.end();
  });
}

const server = new Server(
  { name: "agent-bridge", version: "0.5.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ask_planner",
      description: "Send a prompt to the Planner Claude (a second Claude session running with the planner role from ~/.claude/PLANNER.md). Use to request a TASK block, get a plan, or get architectural input. Returns the planner verbatim response.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The full prompt to send to the planner." }
        },
        required: ["prompt"]
      }
    },
    {
      name: "ask_reviewer",
      description: "Send an executor handoff report (or any work artifact) to the Reviewer Claude — a fresh session running with the reviewer role from ~/.claude/REVIEWER.md, independent of the planner. Use to get an APPROVE / REQUEST CHANGES / BLOCK verdict on work the executor has already produced. Returns the reviewer verbatim response. If REVIEWER.md does not exist, returns a bridge error pointing the executor at examples/reviewer-memory.md.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The full prompt to send to the reviewer — typically the executor's handoff report plus any context the reviewer needs to judge it (original TASK contract, diff, verbatim test output)." }
        },
        required: ["prompt"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    if (name === "ask_planner") {
      result = await runChildClaude(PLANNER_MEMORY_PATH, args.prompt);
    } else if (name === "ask_reviewer") {
      ensureReviewerReadable();
      result = await runChildClaude(REVIEWER_MEMORY_PATH, args.prompt);
    } else {
      throw new Error("Unknown tool: " + name);
    }
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: "Bridge error: " + err.message }],
      isError: true
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  supportsSystemPromptFile
    ? "agent-bridge v0.5.1 (planner + reviewer, --system-prompt-file, prompt caching) running on stdio"
    : "agent-bridge v0.5.1 (planner + reviewer, stdin fallback, no caching) running on stdio"
);
