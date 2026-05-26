import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const kimi_bin = resolve("scripts/mock-kimi-wire.mjs");
const planCwd = join(tmpdir(), `kimi-code-worker-plan-smoke-${Date.now()}`);
const cwd = join(tmpdir(), `kimi-code-worker-run-smoke-${Date.now()}`);
const checkFile = join(cwd, "check-count.txt");
mkdirSync(planCwd, { recursive: true });
mkdirSync(cwd, { recursive: true });

const server = spawn("node", ["src/kimi-code-worker-mcp.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, KIMI_BIN: kimi_bin },
  stdio: ["pipe", "pipe", "pipe"],
});
const responses = [];
let stderr = "";
createInterface({ input: server.stdout }).on("line", (line) => {
  if (line.trim()) responses.push(JSON.parse(line));
});
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "workflow-smoke", version: "0.1.0" },
});
server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const plan = await tool("kimi_plan_implementation", {
  cwd: planCwd,
  task: "MAKE_HELLO: plan the smallest valid slice.",
});
const planNoFileChange = !existsSync(join(planCwd, "hello.txt"));
const start = await tool("kimi_start_implementation", {
  cwd,
  task: "MAKE_HELLO: create the requested hello file.",
  allowed_dirs: ["hello.txt", "src"],
  checks: [`node ${JSON.stringify(resolve("scripts/increment-counter.mjs"))} ${JSON.stringify(checkFile)}`],
});
const terminal = await tool("kimi_wait_for_job", {
  job_id: start.job_id,
  max_wait_ms: 5000,
  poll_interval_ms: 50,
});
const workerPrompt = readFileSync(join(cwd, "src", "worker-prompt.txt"), "utf8");
const compact = await tool("kimi_get_job", { job_id: start.job_id });
const verbose = await tool("kimi_get_job", { job_id: start.job_id, include_diff: true, include_logs: true, include_events: true });

const longStart = await tool("kimi_start_implementation", {
  cwd,
  task: "LONG_RUNNING NEEDS_APPROVAL: stay alive long enough for steer and cancel.",
  allowed_dirs: ["src"],
});
await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
const steered = await tool("kimi_steer_job", {
  job_id: longStart.job_id,
  guidance: "Only touch src/long-run.txt and keep the change minimal.",
});
const cancelled = await tool("kimi_cancel_job", { job_id: longStart.job_id });
const longTerminal = await tool("kimi_wait_for_job", {
  job_id: longStart.job_id,
  max_wait_ms: 5000,
  poll_interval_ms: 50,
});

server.kill("SIGTERM");

const checks = {
  plan_has_slice: plan.status === "planned" && typeof plan.current_slice === "string" && plan.current_slice.length > 0,
  plan_has_path: plan.plan_path === "PLAN.md",
  plan_inherits_permission: plan.codex_permission_profile === "full-access",
  plan_no_file_change: planNoFileChange,
  implementation_started: start.status === "started",
  implementation_completed: terminal.status === "completed" && compact.result?.status === "changed_files",
  implementation_inherits_permission: compact.result?.codex_permission_profile === "full-access",
  check_ran_once: existsSync(checkFile) && readFileSync(checkFile, "utf8") === "1",
  prompt_prefers_scripted_large_outputs: workerPrompt.includes("write a short local Python or shell script"),
  prompt_has_stop_rule: workerPrompt.includes("stop immediately") && workerPrompt.includes("Do not keep thinking"),
  default_get_is_compact: !hasKeyDeep(compact, "stdout_tail") && !hasKeyDeep(compact, "recent_events") && !hasKeyDeep(compact, "file_diffs"),
  verbose_get_has_evidence: hasKeyDeep(verbose, "stdout_tail") && hasKeyDeep(verbose, "recent_events") && hasKeyDeep(verbose, "file_diffs"),
  steer_acknowledged: steered.status === "steered",
  cancel_acknowledged: cancelled.status === "cancel_requested",
  cancelled_terminal: longTerminal.status === "cancel_requested" || longTerminal.result?.status === "cancelled" || longTerminal.result?.status === "partial_cancelled",
};

process.stdout.write(`${JSON.stringify({ ok: Object.values(checks).every(Boolean), checks }, null, 2)}\n`);
if (stderr) process.stderr.write(stderr);
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;

try {
  rmSync(planCwd, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
} catch {
  // Windows may still release child handles asynchronously; cleanup failure should not hide test results.
}

async function tool(name, args) {
  const response = await request("tools/call", { name, arguments: args });
  return JSON.parse(response.result?.content?.[0]?.text ?? "{}");
}

function request(method, params) {
  const id = responses.length + 1;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return waitForResponseId(id, 10000);
}

function waitForResponseId(id, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const response = responses.find((item) => item.id === id);
      if (response) {
        clearInterval(timer);
        resolvePromise(response);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        server.kill("SIGTERM");
        rejectPromise(new Error(`Timed out waiting for response ${id}`));
      }
    }, 20);
  });
}

function hasKeyDeep(value, key) {
  if (value == null || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  if (Array.isArray(value)) return value.some((item) => hasKeyDeep(item, key));
  return Object.values(value).some((item) => hasKeyDeep(item, key));
}
