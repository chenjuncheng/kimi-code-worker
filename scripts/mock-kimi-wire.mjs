#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const cwd = readWorkDir(args);

if (args[0] === "info") {
  process.stdout.write("kimi-cli version: 1.44.0\nwire protocol: 1.10\npython version: 3.13.13\n");
  process.exit(0);
}

if (args.includes("--print")) {
  process.stdout.write("OK\n");
  process.exit(0);
}

if (!args.includes("--wire")) {
  process.stderr.write("mock-kimi-wire only supports info, --print, and --wire\n");
  process.exit(1);
}

let planMode = false;
let running = null;
let pendingTurn = null;
const pendingRequests = new Map();

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (!msg.method && msg.id && (msg.result != null || msg.error != null)) {
    pendingRequests.set(msg.id, msg);
    return;
  }
  if (msg.method === "initialize") {
    respond(msg.id, {
      protocol_version: "1.10",
      server: { name: "Mock Kimi Wire", version: "0.1.0" },
      slash_commands: [],
      capabilities: { supports_question: true },
    });
    return;
  }
  if (msg.method === "set_plan_mode") {
    planMode = Boolean(msg.params?.enabled);
    event("StatusUpdate", { plan_mode: planMode, context_tokens: 512 });
    respond(msg.id, { status: "ok", plan_mode: planMode });
    return;
  }
  if (msg.method === "steer") {
    if (!running) {
      error(msg.id, -32000, "No running turn");
      return;
    }
    running.steer = typeof msg.params?.user_input === "string" ? msg.params.user_input : JSON.stringify(msg.params?.user_input);
    event("SteerInput", { content: running.steer });
    respond(msg.id, { status: "steered" });
    return;
  }
  if (msg.method === "cancel") {
    if (running) running.cancelled = true;
    respond(msg.id, {});
    return;
  }
  if (msg.method === "prompt") {
    if (running) {
      error(msg.id, -32000, "An agent turn is already in progress");
      return;
    }
    running = {
      id: msg.id,
      userInput: normalizePrompt(msg.params?.user_input),
      cancelled: false,
      steer: null,
    };
    void runPrompt(running);
    return;
  }
});

async function runPrompt(turn) {
  event("TurnBegin", { user_input: turn.userInput });
  event("StepBegin", { n: 1 });
  event("StatusUpdate", {
    context_usage: 0.02,
    context_tokens: 1024,
    max_context_tokens: 262144,
    plan_mode: planMode,
  });

  if (turn.userInput.includes("NEEDS_APPROVAL")) {
    const reqId = "approval-1";
    request(reqId, "ApprovalRequest", {
      id: reqId,
      tool_call_id: "tc-1",
      sender: "mock",
      action: "edit",
      description: "mock approval",
      display: [],
    });
    await waitForClientResponse(reqId, 1000);
  }

  if (planMode) {
    event("PlanDisplay", {
      content: [
        "# Plan",
        "## Overall goal",
        "Inspect the target file, make one focused edit, then let MCP run final checks.",
        "## Current slice",
        "Apply the smallest code change for the requested slice.",
        "## Risks",
        "- The requested scope may still be ambiguous.",
        "## Next action",
        "Review the plan display, then start implementation for one slice.",
      ].join("\n"),
      file_path: "PLAN.md",
    });
    event("ContentPart", { type: "text", text: "Plan submitted for approval." });
    respond(turn.id, { status: "finished" });
    event("TurnEnd", {});
    running = null;
    return;
  }

  if (turn.userInput.includes("LONG_RUNNING")) {
    await sleep(200);
    event("TextPart", { text: "Starting a longer edit." });
    await sleep(300);
    if (turn.cancelled) {
      respond(turn.id, { status: "cancelled" });
      event("TurnEnd", {});
      running = null;
      return;
    }
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "long-run.txt"), turn.steer ? `steered:${turn.steer}\n` : "long-running\n");
    await sleep(800);
    if (turn.cancelled) {
      respond(turn.id, { status: "cancelled" });
    } else {
      respond(turn.id, { status: "finished" });
    }
    event("TurnEnd", {});
    running = null;
    return;
  }

  if (turn.userInput.includes("TOOLCALL_TIMEOUT")) {
    for (let index = 0; index < 10; index += 1) {
      event("ToolCallPart", { arguments_part: `fragment-${index}` });
      await sleep(120);
      if (turn.cancelled) {
        respond(turn.id, { status: "cancelled" });
        event("TurnEnd", {});
        running = null;
        return;
      }
    }
    await sleep(5_000);
    return;
  }

  if (turn.userInput.includes("FAIL_CHECK")) {
    writeFileSync(join(cwd, "hello.txt"), "wrong content\n");
    event("ContentPart", { type: "text", text: "Implementation finished with intentionally wrong content." });
    respond(turn.id, { status: "finished" });
    event("TurnEnd", {});
    running = null;
    return;
  }

  if (turn.userInput.includes("MAX_STEPS")) {
    event("ContentPart", { type: "text", text: "Stopping after max steps." });
    respond(turn.id, { status: "max_steps_reached", steps: 99 });
    event("TurnEnd", {});
    running = null;
    return;
  }

  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "worker-prompt.txt"), turn.userInput);
  if (turn.userInput.includes("LIVE_OK")) {
    mkdirSync(join(cwd, "reports"), { recursive: true });
    writeFileSync(join(cwd, "reports", "kimi-doctor-live.txt"), "LIVE_OK\n");
  } else if (turn.userInput.includes("MAKE_HELLO")) {
    writeFileSync(join(cwd, "hello.txt"), "Hello from mock Kimi Wire!\n");
  } else if (turn.userInput.includes("OUTSIDE_SCOPE")) {
    writeFileSync(join(cwd, "hello.txt"), "Hello from mock Kimi Wire!\n");
    writeFileSync(join(cwd, "outside.txt"), "out of scope\n");
  } else {
    writeFileSync(join(cwd, "src", "result.txt"), "mock changed this file\n");
  }
  event("ContentPart", { type: "text", text: "Implementation finished." });
  respond(turn.id, { status: "finished" });
  event("TurnEnd", {});
  running = null;
}

function request(id, type, payload) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "request", id, params: { type, payload } })}\n`);
}

function event(type, payload) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type, payload } })}\n`);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function error(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function waitForClientResponse(id, timeoutMs) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const response = pendingRequests.get(id);
      if (response) {
        clearInterval(timer);
        pendingRequests.delete(id);
        resolvePromise(response);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolvePromise(null);
      }
    }, 20);
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function normalizePrompt(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function readWorkDir(argv) {
  const index = argv.indexOf("--work-dir");
  return index >= 0 ? argv[index + 1] : process.cwd();
}
