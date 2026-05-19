#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 5 * 60 * 1000;
const PLANNER_MEMORY_PATH = join(homedir(), ".claude", "PLANNER.md");

let plannerSystemPrompt;
try {
  plannerSystemPrompt = readFileSync(PLANNER_MEMORY_PATH, "utf8");
} catch (err) {
  console.error("FATAL: cannot read planner memory at " + PLANNER_MEMORY_PATH);
  process.exit(1);
}

function runPlanner(userPrompt) {
  return new Promise((resolve, reject) => {
    // Send: planner instructions on top, separator, then user prompt
    // All via stdin. NO shell, NO CLI string args with content.
    const combinedInput =
      "SYSTEM CONTEXT (your role and rules):\n" +
      plannerSystemPrompt +
      "\n\n---\n\nUSER MESSAGE:\n" +
      userPrompt;

    const child = spawn("claude", ["-p"], {
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
      },
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

    child.stdin.write(combinedInput);
    child.stdin.end();
  });
}

const server = new Server(
  { name: "agent-bridge", version: "0.4.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ask_planner",
      description: "Send a prompt to the Planner Claude (a second Claude session running with the planner/reviewer role). Use to request a TASK block, get a code review on a handoff report, or get architectural input. Returns the planner verbatim response.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The full prompt to send to the planner." }
        },
        required: ["prompt"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name !== "ask_planner") throw new Error("Unknown tool: " + name);
    const result = await runPlanner(args.prompt);
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
console.error("agent-bridge v0.4 (stdin-only, no shell) running on stdio");
