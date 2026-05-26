import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const server = spawn("node", ["src/kimi-code-worker-mcp.mjs"], {
  cwd: process.cwd(),
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

send(1, "initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "tools-smoke", version: "0.1.0" },
});
await waitForResponseId(1, 5000);
server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
send(2, "tools/list");
const response = await waitForResponseId(2, 5000);
server.kill("SIGTERM");

const tools = response.result?.tools ?? [];
const names = tools.map((tool) => tool.name).sort();
const serialized = JSON.stringify(tools).length;
const checks = {
  has_six_tools: tools.length === 6,
  within_budget: serialized <= 12000,
  includes_plan: names.includes("kimi_plan_implementation"),
  includes_start: names.includes("kimi_start_implementation"),
  includes_get: names.includes("kimi_get_job"),
  includes_wait: names.includes("kimi_wait_for_job"),
  includes_steer: names.includes("kimi_steer_job"),
  includes_cancel: names.includes("kimi_cancel_job"),
  excludes_tail: !names.includes("kimi_tail_job"),
};

process.stdout.write(`${JSON.stringify({ ok: Object.values(checks).every(Boolean), checks, serialized_tools_chars: serialized, names }, null, 2)}\n`);
if (stderr) process.stderr.write(stderr);
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;

function send(id, method, params = {}) {
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
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
