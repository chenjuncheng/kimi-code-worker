import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { JobRuntime } from "../src/job-runtime.mjs";

const cwd = join(tmpdir(), `kimi-code-worker-edge-smoke-${Date.now()}`);
mkdirSync(cwd, { recursive: true });
const runtime = new JobRuntime();
const kimi_bin = resolve("scripts/mock-kimi-wire.mjs");

try {
  for (let i = 0; i < 40; i++) {
    writeFileSync(join(cwd, `fixture-${i}.txt`), `fixture ${i}\n`);
  }

  const failedCheck = await runToTerminal(await runtime.startImplementation({
    cwd,
    kimi_bin,
    task: "FAIL_CHECK: create an invalid hello file so host check fails.",
    allowed_dirs: ["hello.txt", "src"],
    checks: ["node -e \"process.exit(1)\""],
  }));

  const maxSteps = await runToTerminal(await runtime.startImplementation({
    cwd,
    kimi_bin,
    task: "MAX_STEPS: simulate model max step exhaustion.",
    allowed_dirs: ["src"],
  }));

  const longStart = await runtime.startImplementation({
    cwd,
    kimi_bin,
    task: "LONG_RUNNING: stay alive so steer can change the final file.",
    allowed_dirs: ["src"],
  });
  await sleep(300);
  const steered = await runtime.steerJob({
    job_id: longStart.job_id,
    guidance: "Use the steered branch.",
  });
  const steerTerminal = await runToTerminal(longStart);
  const steerContent = readFileSync(join(cwd, "src", "long-run.txt"), "utf8");

  const compact = runtime.getJob({ job_id: steerTerminal.job_id });
  const snapshot = compact.result?.workspace_snapshot;
  const checks = {
    failed_check_classified: failedCheck.status === "failed" && failedCheck.result?.failure_reason === "checks_failed",
    max_steps_classified: maxSteps.status === "failed" && maxSteps.result?.failure_reason === "worker_max_steps_reached",
    steer_acknowledged: steered.status === "steered",
    steer_changed_worker_output: steerTerminal.status === "completed" && steerContent.includes("steered:Use the steered branch."),
    snapshot_meta_present: snapshot?.before?.file_count > 0 && snapshot?.after?.file_count > 0,
    compact_result_has_no_diff: !hasKeyDeep(compact, "file_diffs"),
  };

  process.stdout.write(`${JSON.stringify({ ok: Object.values(checks).every(Boolean), checks }, null, 2)}\n`);
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} finally {
  await runtime.shutdown();
  try {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {}
}

async function runToTerminal(startResult) {
  for (let i = 0; i < 80; i++) {
    const result = await runtime.waitForJob({
      job_id: startResult.job_id,
      max_wait_ms: 500,
      poll_interval_ms: 25,
    });
    if (result.status !== "running") return result;
  }
  throw new Error(`Timed out waiting for ${startResult.job_id}`);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function hasKeyDeep(value, key) {
  if (value == null || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  if (Array.isArray(value)) return value.some((item) => hasKeyDeep(item, key));
  return Object.values(value).some((item) => hasKeyDeep(item, key));
}
