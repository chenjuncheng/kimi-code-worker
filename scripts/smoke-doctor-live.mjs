import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const codexHome = join(tmpdir(), `kimi-code-worker-doctor-live-smoke-${Date.now()}`);
mkdirSync(codexHome, { recursive: true });

const threadId = "doctor-live-thread-1";
writeFileSync(join(codexHome, ".codex-global-state.json"), JSON.stringify({
  "pinned-thread-ids": [threadId],
  "heartbeat-thread-permissions-by-id": {
    [threadId]: {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
  },
}, null, 2));
writeFileSync(join(codexHome, "config.toml"), `
[mcp_servers."kimi-code-worker-mcp"]
command = "cmd"
args = ["/d", "/s", "/c", "kimi-code-worker-mcp"]
startup_timeout_sec = 120
`.trimStart());

const child = spawn(process.execPath, ["src/kimi-code-worker-mcp.mjs", "--doctor", "--live"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_THREAD_ID: threadId,
    KIMI_BIN: resolve("scripts/mock-kimi-wire.mjs"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

const exitCode = await new Promise((resolvePromise) => {
  child.on("close", (code) => resolvePromise(code ?? 1));
});

try {
  const parsed = JSON.parse(stdout);
  const checks = {
    exit_code_ok: exitCode === 0,
    doctor_live_present: parsed.checks.some((check) => check.name === "doctor_live_roundtrip" && check.ok === true),
    doctor_live_ok: parsed.doctor_live?.ok === true,
    registration_ok: parsed.codex_mcp_registration?.ok === true,
    permission_ok: parsed.codex_permission?.permission_profile?.label === "full-access",
    live_result_ok: parsed.doctor_live?.result_status === "changed_files",
  };
  process.stdout.write(`${JSON.stringify({ ok: Object.values(checks).every(Boolean), checks, stderr: stderr.trim() }, null, 2)}\n`);
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, stdout, stderr }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  try {
    rmSync(codexHome, { recursive: true, force: true });
  } catch {}
}
