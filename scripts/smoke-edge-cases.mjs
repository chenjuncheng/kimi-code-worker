import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

process.env.KIMI_CODE_WORKER_PROTOCOL_UNSETTLED_AFTER_MS = "300";
process.env.KIMI_CODE_WORKER_TOOL_CALL_PART_BURST_MIN = "3";

const { JobRuntime } = await import("../src/job-runtime.mjs");

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

  const protocolTimeoutStart = await runtime.startImplementation({
    cwd,
    kimi_bin,
    task: "TOOLCALL_TIMEOUT: keep streaming ToolCallPart fragments without settling the prompt.",
    allowed_dirs: ["src"],
    timeout_ms: 1_200,
  });
  await sleep(700);
  const protocolProgress = await runtime.getJob({ job_id: protocolTimeoutStart.job_id });
  const protocolTimeoutTerminal = await runToTerminal(protocolTimeoutStart);

  const orphanedStart = await runtime.startImplementation({
    cwd,
    kimi_bin,
    task: "LONG_RUNNING: create a long-running file so we can simulate orphaned reconciliation.",
    allowed_dirs: ["src"],
  });
  await sleep(300);
  const orphanedJob = runtime.jobs.get(orphanedStart.job_id);
  writeFileSync(join(cwd, "src", "orphaned.txt"), "reconcile me\n");
  orphanedJob.process_alive = false;
  orphanedJob.backend = null;
  orphanedJob.status = "running";
  orphanedJob.stage = "implementing";
  orphanedJob.updated_at = new Date().toISOString();
  const orphanedTerminal = await runtime.getJob({ job_id: orphanedStart.job_id });

  const compact = await runtime.getJob({ job_id: steerTerminal.job_id });
  const snapshot = compact.result?.workspace_snapshot;
  const checks = {
    failed_check_classified: failedCheck.status === "failed" && failedCheck.result?.failure_reason === "checks_failed",
    max_steps_classified: maxSteps.status === "failed" && maxSteps.result?.failure_reason === "worker_max_steps_reached",
    steer_acknowledged: steered.status === "steered",
    steer_changed_worker_output: steerTerminal.status === "completed" && steerContent.includes("steered:Use the steered branch."),
    protocol_stall_visible_while_running: protocolProgress.status === "running"
      && protocolProgress.progress?.suspected_stall === true
      && protocolProgress.progress?.stall_reason === "protocol_not_settled",
    protocol_timeout_classified: protocolTimeoutTerminal.status === "failed"
      && protocolTimeoutTerminal.result?.failure_reason === "worker_protocol_timeout",
    orphaned_job_reconciled: orphanedTerminal.status === "completed"
      && orphanedTerminal.result?.worker_exit_without_terminal_event === true
      && orphanedTerminal.result?.recovered_from_failure_reason === "worker_exited_without_terminal_event",
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
