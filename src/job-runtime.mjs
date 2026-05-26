import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_FORBIDDEN_PATHS,
  DEFAULT_FOREGROUND_WAIT_CAP_MS,
  DEFAULT_IDLE_AFTER_MS,
  DEFAULT_IGNORED_DIRS,
  DEFAULT_PLAN_TIMEOUT_MS,
  DEFAULT_RECOMMENDED_POLL_INTERVAL_MS,
  DEFAULT_RECOMMENDED_WAIT_MS,
  DEFAULT_STALL_AFTER_MS,
  DEFAULT_SYNC_TIMEOUT_MS,
  DEFAULT_WAIT_RETURN_GUARD_MS,
  DEFAULT_WAIT_RETURN_GUARD_TRIGGER_MS,
  JOB_ROOT,
  KIMI_BIN,
  MAX_DIFF_BYTES,
  MAX_DIFF_LINES,
  MAX_FILE_BYTES,
  MAX_OUTPUT_CHARS,
  MAX_PLAN_SANDBOX_BYTES,
  MAX_PLAN_SANDBOX_FILES,
  MAX_SNAPSHOT_CONTENT_BYTES,
  MAX_SNAPSHOT_FILES,
  MAX_STREAM_EVENTS,
} from "./core/config.mjs";
import {
  inferPermissionProfile,
  readCodexPermissionContext,
} from "./core/codex-permissions.mjs";
import { KimiWireBackend } from "./kimi-wire-backend.mjs";

export class JobRuntime {
  constructor() {
    this.jobs = new Map();
    mkdirSync(JOB_ROOT, { recursive: true });
  }

  async planImplementation(rawArgs) {
    const args = normalizePlanArgs(rawArgs);
    const before = snapshotWorkspace(args.cwd, args.ignored_dirs);
    const sandbox = createPlanningSandbox(args.cwd, args.ignored_dirs);
    const sandbox_cwd = sandbox.path;
    const job = createJob({
      kind: "plan",
      cwd: args.cwd,
      model: args.model,
      checks: [],
      before,
      allowedRoots: normalizeRoots(args.cwd, args.allowed_dirs, true),
      forbiddenPaths: normalizeForbidden(args.cwd, args.forbidden_paths),
      ignored_dirs: args.ignored_dirs,
    });
    job.planning_sandbox = sandbox.meta;
    this.jobs.set(job.id, job);
    persistJob(job);
    try {
      await runPlanJob(job, { ...args, sandbox_cwd });
      return {
        status: "planned",
        job_id: job.id,
        plan_mode: true,
        codex_permission_profile: job.permission_profile?.label ?? "unknown",
        plan_summary: job.result?.plan_summary ?? "",
        current_slice: job.result?.current_slice ?? "",
        risks: job.result?.risks ?? [],
        next_action: job.result?.next_action ?? "Review the plan summary, then start one implementation slice.",
        plan_path: job.result?.plan_path ?? null,
    };
    } catch (error) {
      job.status = "failed";
      job.error = { message: error.message };
      job.updated_at = new Date().toISOString();
      persistJob(job);
      throw error;
    } finally {
      cleanupDirectory(sandbox_cwd);
    }
  }

  async startImplementation(rawArgs) {
    const args = normalizeStartArgs(rawArgs);
    const before = snapshotWorkspace(args.cwd, args.ignored_dirs);
    const job = createJob({
      kind: "implementation",
      cwd: args.cwd,
      model: args.model,
      checks: args.checks,
      before,
      allowedRoots: normalizeRoots(args.cwd, args.allowed_dirs, true),
      forbiddenPaths: normalizeForbidden(args.cwd, args.forbidden_paths),
      ignored_dirs: args.ignored_dirs,
    });
    job.stage = "queued";
    this.jobs.set(job.id, job);
    persistJob(job);
    job.promise = runImplementationJob(job, args).catch((error) => {
      job.status = "failed";
      job.error = { message: error.message };
      job.updated_at = new Date().toISOString();
      persistJob(job);
    });
    return {
      status: "started",
      job_id: job.id,
      started_at: job.started_at,
      stage: job.stage,
    };
  }

  getJob(rawArgs) {
    const args = outputOptions(rawArgs);
    const job = this.jobs.get(rawArgs.job_id);
    if (!job) return { status: "not_found", job_id: rawArgs.job_id };
    return serializeJob(job, args);
  }

  waitForJob(rawArgs) {
    const job = this.jobs.get(rawArgs.job_id);
    if (!job) return Promise.resolve({ status: "not_found", job_id: rawArgs.job_id });
    const options = outputOptions(rawArgs);
    const waitRequested = rawArgs.max_wait_ms != null;
    const requestedMaxWaitMs = waitRequested
      ? positiveNumber(rawArgs.max_wait_ms, DEFAULT_FOREGROUND_WAIT_CAP_MS, "max_wait_ms")
      : 0;
    const pollIntervalMs = positiveNumber(rawArgs.poll_interval_ms, DEFAULT_RECOMMENDED_POLL_INTERVAL_MS, "poll_interval_ms");
    const cappedMaxWaitMs = Math.min(requestedMaxWaitMs, DEFAULT_FOREGROUND_WAIT_CAP_MS);
    const timeoutGuardMs = waitRequested ? waitReturnGuardMs(cappedMaxWaitMs) : 0;
    const maxWaitMs = Math.max(0, cappedMaxWaitMs - timeoutGuardMs);
    const startedMs = Date.now();
    return new Promise((resolvePromise) => {
      const finish = () => {
        const output = {
          status: "running",
          reason: !waitRequested
            ? "no_wait_requested"
            : timeoutGuardMs > 0 ? "host_timeout_guard_elapsed" : "max_wait_elapsed",
          job_id: job.id,
          elapsed_wait_ms: Date.now() - startedMs,
          requested_max_wait_ms: requestedMaxWaitMs,
          effective_max_wait_ms: maxWaitMs,
          timeout_guard_ms: timeoutGuardMs,
          recommended_wait_ms: DEFAULT_RECOMMENDED_WAIT_MS,
          recommended_poll_interval_ms: DEFAULT_RECOMMENDED_POLL_INTERVAL_MS,
          suggested_next_tool: "kimi_get_job",
          suggested_next_action: "Use kimi_get_job for the main loop and keep kimi_wait_for_job as a short observation window.",
          progress: progressForJob(job),
          result: resultForOutput(job.result, options),
          error: job.error ?? null,
        };
        resolvePromise(stripLargeEvidence(output, options));
      };

      const decide = () => {
        if (job.status === "completed" || job.status === "failed" || job.status === "cancel_requested") {
          resolvePromise(serializeJob(job, options));
          return true;
        }
        return false;
      };

      if (decide()) return;
      if (!waitRequested || maxWaitMs <= 0) {
        finish();
        return;
      }
      const timer = setInterval(() => {
        if (decide()) {
          clearInterval(timer);
          return;
        }
        if (Date.now() - startedMs >= maxWaitMs) {
          clearInterval(timer);
          finish();
        }
      }, Math.max(25, pollIntervalMs));
    });
  }

  async steerJob(rawArgs) {
    const args = normalizeSteerArgs(rawArgs);
    const job = this.jobs.get(args.job_id);
    if (!job) return { status: "not_found", job_id: args.job_id };
    if (job.status !== "running" || !job.backend) {
      return { status: "not_running", job_id: job.id, current_status: job.status };
    }
    await job.backend.steer(args.guidance);
    markMeaningfulActivity(job, "steer");
    job.last_steer = args.guidance;
    persistJob(job);
    return { status: "steered", job_id: job.id };
  }

  async cancelJob(rawArgs) {
    const args = normalizeCancelArgs(rawArgs);
    const job = this.jobs.get(args.job_id);
    if (!job) return { status: "not_found", job_id: args.job_id };
    if (job.status !== "running" || !job.backend) {
      return { status: "not_running", job_id: job.id, current_status: job.status };
    }
    job.status = "cancel_requested";
    job.updated_at = new Date().toISOString();
    persistJob(job);
    await job.backend.cancel();
    return { status: "cancel_requested", job_id: job.id };
  }

  async shutdown() {
    await Promise.allSettled(
      [...this.jobs.values()].map(async (job) => {
        if (job.backend) await job.backend.close();
      })
    );
  }
}

async function runPlanJob(job, args) {
  const codexPermission = readCodexPermissionContext();
  const permissionProfile = inferPermissionProfile(codexPermission);
  const sandboxBefore = snapshotWorkspace(args.sandbox_cwd, args.ignored_dirs);
  job.codex_permission = codexPermission;
  job.permission_profile = permissionProfile;
  setPhase(job, "connecting", "Starting Kimi Wire session for planning.");
  const backend = createBackend(job, { ...args, cwd: args.sandbox_cwd, codexPermission, permissionProfile });
  job.backend = backend;
  await backend.start();
  setPhase(job, "planning", "Switching Kimi into plan mode.");
  await backend.setPlanMode(true);
  const prompt = buildPlanPrompt(args, job.allowedRoots, job.forbiddenPaths, permissionProfile);
  const result = await waitForPlanResult(job, backend, prompt, args.timeout_ms);
  await backend.setPlanMode(false);
  await backend.close();
  job.backend = null;

  const sandboxAfter = snapshotWorkspace(args.sandbox_cwd, args.ignored_dirs);
  const sandboxChanges = diffSnapshots(sandboxBefore, sandboxAfter);
  if (sandboxChanges.length > 0) {
    throw new Error("Plan mode changed the planning sandbox; refusing to trust the planning result.");
  }
  const after = snapshotWorkspace(args.cwd, args.ignored_dirs);
  const changes = diffSnapshots(job.before, after);
  if (changes.length > 0) {
    throw new Error("Plan mode changed the workspace; refusing to trust the planning result.");
  }
  const plan = parsePlanOutput(job.plan_display?.content ?? job.assistant_text);
  if (!plan) {
    throw new Error("Failed to parse plan output from Kimi.");
  }

  job.status = "completed";
  job.stage = "completed";
  job.result = {
    status: result.status === "finished" ? "planned" : result.status,
    plan_summary: plan.plan_summary,
    current_slice: plan.current_slice,
    risks: plan.risks,
    next_action: plan.next_action,
    plan_path: job.plan_display?.file_path ?? null,
    files_changed: [],
    change_count: 0,
    checks_run: [],
    requires_review: false,
    completed_at: new Date().toISOString(),
    elapsed_ms: Date.now() - job.started_ms,
  };
  job.updated_at = new Date().toISOString();
  persistJob(job);
}

async function waitForPlanResult(job, backend, prompt, timeoutMs) {
  const promptPromise = backend.prompt(prompt)
    .then((result) => ({ result }))
    .catch((error) => ({ error }));
  const startedMs = Date.now();
  while (Date.now() - startedMs < timeoutMs) {
    const settled = await Promise.race([
      promptPromise,
      sleep(250).then(() => null),
    ]);
    if (settled?.error) throw settled.error;
    if (settled?.result) return settled.result;
    const planText = job.plan_display?.content ?? "";
    const assistantPlanText = looksLikePlanText(job.assistant_text) ? job.assistant_text : "";
    if (parsePlanOutput(planText || assistantPlanText)) {
      await backend.cancel().catch(() => null);
      await Promise.race([promptPromise, sleep(2_000)]);
      return { status: "finished" };
    }
  }
  await backend.cancel().catch(() => null);
  const evidence = job.last_event_summary ? ` Last signal: ${job.last_event_summary}.` : "";
  throw new Error(`Timed out waiting for Kimi plan output after ${timeoutMs} ms.${evidence}`);
}

async function runImplementationJob(job, args) {
  const codexPermission = readCodexPermissionContext();
  const permissionProfile = inferPermissionProfile(codexPermission);
  job.codex_permission = codexPermission;
  job.permission_profile = permissionProfile;
  setPhase(job, "connecting", "Starting Kimi Wire session for implementation.");
  const backend = createBackend(job, { ...args, codexPermission, permissionProfile });
  job.backend = backend;
  await backend.start();
  setPhase(job, "implementing", "Kimi is executing the current slice.");
  const prompt = buildImplementationPrompt(args, job.allowedRoots, job.forbiddenPaths, permissionProfile);
  let workerResult;
  let workerError = null;
  try {
    workerResult = await backend.prompt(prompt);
  } catch (error) {
    workerError = error;
    workerResult = { status: "failed" };
  } finally {
    await backend.close();
    job.backend = null;
  }

  const after = snapshotWorkspace(args.cwd, args.ignored_dirs);
  const changes = diffSnapshots(job.before, after);
  const changedFiles = changes.map((change) => change.path).sort();
  const policy = evaluatePolicy({
    cwd: args.cwd,
    changedFiles,
    allowedRoots: job.allowedRoots,
    forbiddenPaths: job.forbiddenPaths,
  });

  const checks_run = [];
  if (changedFiles.length > 0 && policy.ok && args.checks.length > 0) {
    setPhase(job, "checking", "Workspace changed; running authoritative host-side checks.");
    for (const [index, command] of args.checks.entries()) {
      job.current_check = {
        index,
        total: args.checks.length,
        command,
        started_at_ms: Date.now(),
      };
      persistJob(job);
      const checked = await runCheck(args.cwd, command, args.check_timeout_ms);
      checks_run.push(checked);
      markMeaningfulActivity(job, checked.exit_code === 0 && !checked.timed_out ? "check_passed" : "check_failed");
      job.current_check = null;
      persistJob(job);
    }
  }

  const file_diffs = computeFileDiffs(job.before, after, changes);
  const failedChecks = checks_run.filter((check) => check.exit_code !== 0 || check.timed_out);
  const terminal = classifyTerminal({
    worker_status: workerResult.status,
    worker_error: workerError,
    changedFiles,
    policy,
    failedChecks,
  });

  job.status = terminal.ok ? "completed" : terminal.status === "cancel_requested" ? "cancel_requested" : "failed";
  job.stage = job.status === "completed" ? "completed" : "failed";
  job.result = {
    status: terminal.status,
    files_changed: changedFiles,
    change_count: changedFiles.length,
    policy,
    checks_run,
    requires_review: changedFiles.length > 0,
    failure_reason: terminal.failure_reason,
    worker_error: workerError ? workerError.message : null,
    file_diffs,
    workspace_snapshot: {
      before: snapshotMeta(job.before),
      after: snapshotMeta(after),
    },
    codex_permission_profile: permissionProfile?.label ?? "unknown",
    completed_at: new Date().toISOString(),
    elapsed_ms: Date.now() - job.started_ms,
  };
  job.updated_at = new Date().toISOString();
  persistJob(job);
}

function createBackend(job, args) {
  return new KimiWireBackend({
    cwd: args.cwd,
    model: args.model,
    kimi_bin: args.kimi_bin || KIMI_BIN,
    plan_mode: job.kind === "plan",
    request_timeout_ms: args.timeout_ms,
    codex_permission: args.codexPermission ?? null,
    permission_profile: args.permissionProfile ?? null,
    onStdout(line) {
      appendLog(job, "stdout", line);
    },
    onStderr(text) {
      appendLog(job, "stderr", text);
    },
    onEvent(event) {
      appendEvent(job, event.type, event.summary, event.raw);
      if (event.stage) {
        job.stage = event.stage.stage;
        job.phase_message = event.stage.message;
      }
      if (event.text) {
        job.assistant_text += event.text;
      }
      if (event.plan) {
        job.plan_display = event.plan;
      }
      if (event.status_update) {
        job.status_update = event.status_update;
      }
      markMeaningfulActivity(job, event.summary);
      job.updated_at = new Date().toISOString();
      persistJob(job);
    },
    onRequest(event) {
      appendEvent(job, event.type, `request:${event.summary}`, event.raw);
      markMeaningfulActivity(job, `request:${event.type}`);
      job.updated_at = new Date().toISOString();
      persistJob(job);
    },
    onExit() {
      job.process_alive = false;
      job.updated_at = new Date().toISOString();
      persistJob(job);
    },
  });
}

function createJob({ kind, cwd, model, checks, before, allowedRoots, forbiddenPaths, ignored_dirs }) {
  const id = `kcw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const job = {
    id,
    kind,
    cwd,
    model,
    checks,
    before,
    allowedRoots,
    forbiddenPaths,
    ignored_dirs,
    status: "running",
    stage: kind === "plan" ? "planning" : "queued",
    started_at: now,
    started_ms: Date.now(),
    updated_at: now,
    phase_message: "",
    process_alive: false,
    assistant_text: "",
    plan_display: null,
    status_update: null,
    planning_sandbox: null,
    events: [],
    stdout_tail: "",
    stderr_tail: "",
    last_event_summary: null,
    last_meaningful_activity_ms: Date.now(),
    current_check: null,
    result: null,
    error: null,
    backend: null,
    promise: null,
    codex_permission: null,
    permission_profile: null,
  };
  mkdirSync(jobDir(job), { recursive: true });
  writeFileSync(join(jobDir(job), "before-snapshot.json"), JSON.stringify([...before.entries()], null, 2));
  job.snapshot = { before: snapshotMeta(before) };
  return job;
}

function setPhase(job, stage, message) {
  job.stage = stage;
  job.phase_message = message;
  job.updated_at = new Date().toISOString();
  markMeaningfulActivity(job, `phase:${stage}`);
  persistJob(job);
}

function progressForJob(job) {
  const elapsedMs = Date.now() - job.started_ms;
  const idleMs = Date.now() - job.last_meaningful_activity_ms;
  const suspected_stall = job.status === "running" && idleMs >= DEFAULT_STALL_AFTER_MS;
  const facts = [
    `Current stage: ${job.stage}.`,
    `Elapsed time: ${elapsedMs} ms.`,
  ];
  if (job.last_event_summary) facts.push(`Recent wire signal: ${job.last_event_summary}.`);
  if (job.current_check) {
    facts.push(`Checks progress: ${job.current_check.index + 1}/${job.current_check.total}.`);
  }
  if (job.status_update?.context_tokens != null) {
    facts.push(`Context tokens reported: ${job.status_update.context_tokens}.`);
  }
  const beforeSnapshot = job.snapshot?.before;
  if (beforeSnapshot?.truncated) {
    facts.push(`Workspace snapshot reached its scan budget; ${beforeSnapshot.skipped_file_count} files were not tracked.`);
  }

  let weak_inference = "Recent activity suggests the run is still progressing, but these signals do not prove that it is on the right path.";
  if (job.status !== "running") {
    weak_inference = "The job reached a terminal state. Final acceptance should be based on result, policy, checks, and optional diff review.";
  } else if (suspected_stall) {
    weak_inference = `No meaningful activity has been observed for ${idleMs} ms. This suggests the run may be stalled, but it does not prove failure.`;
  } else if (job.stage === "checking") {
    weak_inference = "The run has reached host-side validation. This suggests coding has paused, but the final acceptance still depends on check results.";
  }

  let next_action = "Continue short polling with kimi_get_job. Use kimi_wait_for_job only for another short observation window.";
  if (suspected_stall) {
    next_action = "Fetch include_logs or include_events once for stronger evidence. Cancel and restart only if the task boundary now looks wrong.";
  } else if (job.status !== "running") {
    next_action = "Inspect the terminal summary. Request include_diff only if final review needs file-level evidence.";
  }

  return {
    status: job.status,
    stage: job.stage,
    phase_message: job.phase_message,
    facts,
    weak_inference,
    next_action,
    suspected_stall,
    checks_progress: job.current_check ? {
      current: job.current_check.index + 1,
      total: job.current_check.total,
      command: job.current_check.command,
    } : null,
  };
}

function serializeJob(job, options = {}) {
  return stripLargeEvidence({
    status: job.status,
    job_id: job.id,
    elapsed_ms: Date.now() - job.started_ms,
    progress: progressForJob(job),
    result: resultForOutput(job.result, options),
    error: job.error,
    worker: options.include_logs || options.include_events ? {
      stdout_tail: job.stdout_tail,
      stderr_tail: job.stderr_tail,
      recent_events: job.events,
    } : undefined,
  }, options);
}

function resultForOutput(result, options = {}) {
  if (!result) return null;
  return stripLargeEvidence(
    {
      status: result.status,
      files_changed: result.files_changed ?? [],
      change_count: result.change_count ?? 0,
      policy: result.policy ?? null,
      checks_run: checksForOutput(result.checks_run ?? [], options),
      requires_review: Boolean(result.requires_review),
      failure_reason: result.failure_reason ?? null,
      plan_summary: result.plan_summary,
      current_slice: result.current_slice,
      risks: result.risks,
      next_action: result.next_action,
      plan_path: result.plan_path ?? null,
      codex_permission_profile: result.codex_permission_profile ?? null,
      elapsed_ms: result.elapsed_ms ?? null,
      completed_at: result.completed_at ?? null,
      file_diffs: result.file_diffs ?? [],
      worker_error: result.worker_error ?? null,
      workspace_snapshot: result.workspace_snapshot ?? null,
    },
    options
  );
}

function checksForOutput(checks, options = {}) {
  return checks.map((check) => {
    if (options.include_logs) return check;
    return {
      command: check.command,
      exit_code: check.exit_code,
      timed_out: check.timed_out,
      elapsed_ms: check.elapsed_ms,
    };
  });
}

function stripLargeEvidence(value, options = {}) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stripLargeEvidence(item, options));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (!options.include_logs && (key === "stdout_tail" || key === "stderr_tail")) continue;
    if (!options.include_events && key === "recent_events") continue;
    if (!options.include_diff && key === "file_diffs") continue;
    output[key] = stripLargeEvidence(item, options);
  }
  return output;
}

function persistJob(job) {
  const payload = {
    id: job.id,
    kind: job.kind,
    cwd: job.cwd,
    model: job.model,
    status: job.status,
    stage: job.stage,
    started_at: job.started_at,
    updated_at: job.updated_at,
    phase_message: job.phase_message,
    process_alive: job.process_alive,
    checks: job.checks,
    allowedRoots: job.allowedRoots,
    forbiddenPaths: job.forbiddenPaths,
    ignored_dirs: job.ignored_dirs,
    status_update: job.status_update,
    current_check: job.current_check,
    snapshot: job.snapshot,
    planning_sandbox: job.planning_sandbox,
    last_event_summary: job.last_event_summary,
    codex_permission: job.codex_permission,
    permission_profile: job.permission_profile,
    result: job.result,
    error: job.error,
  };
  writeFileSync(join(jobDir(job), "status.json"), JSON.stringify(payload, null, 2));
}

function appendEvent(job, type, summary, raw) {
  job.last_event_summary = summary;
  job.events.push({
    at: new Date().toISOString(),
    type,
    summary,
    raw,
  });
  if (job.events.length > MAX_STREAM_EVENTS) job.events.shift();
}

function appendLog(job, stream, text) {
  const next = appendBounded(stream === "stdout" ? job.stdout_tail : job.stderr_tail, text);
  if (stream === "stdout") job.stdout_tail = next;
  else job.stderr_tail = next;
  appendFileSync(join(jobDir(job), `${stream}.log`), text);
}

function appendBounded(existing, text) {
  const combined = `${existing}${text}`;
  if (combined.length <= MAX_OUTPUT_CHARS) return combined;
  return combined.slice(combined.length - MAX_OUTPUT_CHARS);
}

function jobDir(job) {
  return join(JOB_ROOT, job.id);
}

function markMeaningfulActivity(job, reason) {
  job.last_meaningful_activity_ms = Date.now();
  job.last_event_summary = reason;
}

function normalizePlanArgs(rawArgs) {
  const cwd = assertDirectory(rawArgs.cwd, "cwd");
  return {
    cwd,
    task: requiredString(rawArgs.task, "task"),
    allowed_dirs: optionalStringArray(rawArgs.allowed_dirs),
    forbidden_paths: optionalStringArray(rawArgs.forbidden_paths, DEFAULT_FORBIDDEN_PATHS),
    ignored_dirs: optionalStringArray(rawArgs.ignored_dirs, [...DEFAULT_IGNORED_DIRS]),
    model: optionalString(rawArgs.model),
    kimi_bin: optionalString(rawArgs.kimi_bin),
    timeout_ms: positiveNumber(rawArgs.timeout_ms, DEFAULT_PLAN_TIMEOUT_MS, "timeout_ms"),
  };
}

function normalizeStartArgs(rawArgs) {
  const cwd = assertDirectory(rawArgs.cwd, "cwd");
  return {
    cwd,
    task: requiredString(rawArgs.task, "task"),
    allowed_dirs: optionalStringArray(rawArgs.allowed_dirs),
    forbidden_paths: optionalStringArray(rawArgs.forbidden_paths, DEFAULT_FORBIDDEN_PATHS),
    ignored_dirs: optionalStringArray(rawArgs.ignored_dirs, [...DEFAULT_IGNORED_DIRS]),
    checks: optionalStringArray(rawArgs.checks),
    model: optionalString(rawArgs.model),
    timeout_ms: positiveNumber(rawArgs.timeout_ms, DEFAULT_SYNC_TIMEOUT_MS, "timeout_ms"),
    check_timeout_ms: positiveNumber(rawArgs.check_timeout_ms, DEFAULT_CHECK_TIMEOUT_MS, "check_timeout_ms"),
    kimi_bin: optionalString(rawArgs.kimi_bin),
  };
}

function normalizeSteerArgs(rawArgs) {
  return {
    job_id: requiredString(rawArgs.job_id, "job_id"),
    guidance: requiredString(rawArgs.guidance, "guidance"),
  };
}

function normalizeCancelArgs(rawArgs) {
  return {
    job_id: requiredString(rawArgs.job_id, "job_id"),
  };
}

function outputOptions(args = {}) {
  return {
    include_logs: Boolean(args.include_logs),
    include_events: Boolean(args.include_events),
    include_diff: Boolean(args.include_diff),
  };
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function optionalStringArray(value, fallback = []) {
  if (value == null) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error("Expected an array of non-empty strings");
  }
  return value.map((item) => item.trim());
}

function positiveNumber(value, fallback, label) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a positive number`);
  return number;
}

function assertDirectory(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a directory path`);
  const path = resolve(value);
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  return path;
}

function normalizeRoots(cwd, roots, defaultToCwd) {
  const items = roots.length === 0 && defaultToCwd ? [cwd] : roots;
  return items.map((item) => assertInside(resolve(cwd, item), cwd, "allowed_dirs"));
}

function normalizeForbidden(cwd, entries) {
  return entries.map((entry) => assertInside(resolve(cwd, entry), cwd, "forbidden_paths"));
}

function assertInside(target, root, label) {
  const normalizedRoot = normalizePath(root);
  const normalizedTarget = normalizePath(target);
  if (normalizedTarget === normalizedRoot) return target;
  if (!normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`${label} path escapes cwd: ${target}`);
  }
  return target;
}

function normalizePath(path) {
  let normalized = resolve(path);
  if (platform() === "win32") normalized = normalized.toLowerCase();
  return normalized;
}

function snapshotWorkspace(cwd, ignoredDirs) {
  const files = new Map();
  const meta = createSnapshotMeta();
  visitDirectory(cwd, cwd, new Set(ignoredDirs), files, meta);
  files.meta = meta;
  return files;
}

function createPlanningSandbox(cwd, ignoredDirs) {
  const sandbox = join(tmpdir(), `kimi-code-worker-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(sandbox, { recursive: true });
  const meta = createCopyMeta();
  copyWorkspace(cwd, sandbox, new Set(ignoredDirs), meta);
  return { path: sandbox, meta };
}

function copyWorkspace(source, target, ignoredDirs, meta) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "." || entry.name === "..") continue;
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) {
        meta.ignored_dir_count++;
        continue;
      }
      mkdirSync(targetPath, { recursive: true });
      copyWorkspace(sourcePath, targetPath, ignoredDirs, meta);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = statSync(sourcePath);
    if (meta.file_count >= MAX_PLAN_SANDBOX_FILES || meta.bytes_copied + stat.size > MAX_PLAN_SANDBOX_BYTES) {
      meta.truncated = true;
      meta.skipped_file_count++;
      continue;
    }
    writeFileSync(targetPath, readFileSync(sourcePath));
    meta.file_count++;
    meta.bytes_copied += stat.size;
  }
}

function visitDirectory(root, current, ignoredDirs, output, meta) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) {
        meta.ignored_dir_count++;
        continue;
      }
      visitDirectory(root, join(current, entry.name), ignoredDirs, output, meta);
      continue;
    }
    if (!entry.isFile()) continue;
    if (meta.file_count >= MAX_SNAPSHOT_FILES) {
      meta.truncated = true;
      meta.skipped_file_count++;
      continue;
    }
    const absolute = join(current, entry.name);
    const relativePath = relative(root, absolute).split("\\").join("/");
    const stat = statSync(absolute);
    const canReadContent = stat.size <= MAX_FILE_BYTES && meta.content_bytes + stat.size <= MAX_SNAPSHOT_CONTENT_BYTES;
    const content = canReadContent ? readFileSync(absolute) : null;
    if (content == null) meta.content_skipped_count++;
    else meta.content_bytes += stat.size;
    const hash = createHash("sha1").update(content ?? `${stat.size}:${stat.mtimeMs}`).digest("hex");
    output.set(relativePath, {
      size: stat.size,
      hash,
      content: content == null ? null : content.toString("utf8"),
    });
    meta.file_count++;
  }
}

function createSnapshotMeta() {
  return {
    file_count: 0,
    content_bytes: 0,
    content_skipped_count: 0,
    skipped_file_count: 0,
    ignored_dir_count: 0,
    truncated: false,
    max_files: MAX_SNAPSHOT_FILES,
    max_content_bytes: MAX_SNAPSHOT_CONTENT_BYTES,
  };
}

function createCopyMeta() {
  return {
    file_count: 0,
    bytes_copied: 0,
    skipped_file_count: 0,
    ignored_dir_count: 0,
    truncated: false,
    max_files: MAX_PLAN_SANDBOX_FILES,
    max_bytes: MAX_PLAN_SANDBOX_BYTES,
  };
}

function snapshotMeta(snapshot) {
  return snapshot?.meta ?? null;
}

function diffSnapshots(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changes = [];
  for (const path of [...paths].sort()) {
    const prev = before.get(path);
    const next = after.get(path);
    if (!prev && next) {
      changes.push({ path, type: "added", before: null, after: next });
      continue;
    }
    if (prev && !next) {
      changes.push({ path, type: "deleted", before: prev, after: null });
      continue;
    }
    if (prev.hash !== next.hash) {
      changes.push({ path, type: "modified", before: prev, after: next });
    }
  }
  return changes;
}

function computeFileDiffs(before, after, changes) {
  return changes.map((change) => ({
    path: change.path,
    type: change.type,
    unified_diff: buildUnifiedDiff(change.path, before.get(change.path)?.content ?? "", after.get(change.path)?.content ?? ""),
  }));
}

function buildUnifiedDiff(path, beforeText, afterText) {
  const beforeLines = splitLines(beforeText);
  const afterLines = splitLines(afterText);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix + prefix < beforeLines.length
    && suffix + prefix < afterLines.length
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
  const diff = lines.slice(0, MAX_DIFF_LINES).join("\n");
  return diff.length <= MAX_DIFF_BYTES ? diff : diff.slice(0, MAX_DIFF_BYTES);
}

function splitLines(text) {
  return text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n");
}

function evaluatePolicy({ cwd, changedFiles, allowedRoots, forbiddenPaths }) {
  const outside_allowed = changedFiles.filter((path) => !allowedRoots.some((root) => isInside(join(cwd, path), root)));
  const forbidden_changed = changedFiles.filter((path) => forbiddenPaths.some((forbidden) => normalizePath(join(cwd, path)) === normalizePath(forbidden)));
  const ok = outside_allowed.length === 0 && forbidden_changed.length === 0;
  return {
    ok,
    scope_violation: outside_allowed.length > 0,
    outside_allowed,
    generated_changed: [],
    forbidden_changed,
  };
}

function isInside(target, root) {
  const normalizedTarget = normalizePath(target);
  const normalizedRoot = normalizePath(root);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
}

function classifyTerminal({ worker_status, worker_error, changedFiles, policy, failedChecks }) {
  if (worker_error || worker_status === "failed") {
    return { ok: false, status: "failed", failure_reason: "worker_failed" };
  }
  if (worker_status === "max_steps_reached") {
    return { ok: false, status: "failed", failure_reason: "worker_max_steps_reached" };
  }
  if (worker_status === "cancelled") {
    if (changedFiles.length > 0) {
      return { ok: false, status: "partial_cancelled", failure_reason: "cancelled_after_changes" };
    }
    return { ok: false, status: "cancelled", failure_reason: "worker_cancelled" };
  }
  if (!policy.ok) {
    return {
      ok: false,
      status: "failed",
      failure_reason: policy.scope_violation ? "changed_outside_allowed_scope" : "forbidden_paths_changed",
    };
  }
  if (failedChecks.length > 0) {
    return { ok: false, status: "failed", failure_reason: "checks_failed" };
  }
  if (changedFiles.length === 0) {
    return { ok: true, status: "no_changes", failure_reason: null };
  }
  return { ok: true, status: "changed_files", failure_reason: null };
}

async function runCheck(cwd, command, timeout_ms) {
  const shell = checkShellInvocation(command);
  const startedMs = Date.now();
  const result = await runProcess(shell.command, shell.args, { cwd, timeout_ms });
  return {
    command,
    exit_code: result.exit_code,
    timed_out: result.timed_out,
    elapsed_ms: Date.now() - startedMs,
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr),
  };
}

function checkShellInvocation(command) {
  if (platform() === "win32") {
    if (isCommandAvailable("pwsh")) return { command: "pwsh", args: ["-NoProfile", "-Command", command] };
    if (isCommandAvailable("powershell")) return { command: "powershell", args: ["-NoProfile", "-Command", command] };
    return { command: "cmd", args: ["/d", "/s", "/c", command] };
  }
  return { command: "bash", args: ["-lc", command] };
}

function isCommandAvailable(command) {
  try {
    if (isAbsolute(command)) {
      accessSync(command, fsConstants.X_OK);
      return true;
    }
    return true;
  } catch {
    return false;
  }
}

function runProcess(command, args, { cwd, timeout_ms }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let timed_out = false;
    const timer = setTimeout(() => {
      timed_out = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeout_ms);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exit_code: code, stdout, stderr, timed_out });
    });
  });
}

function tail(text) {
  return text.length <= MAX_OUTPUT_CHARS ? text : text.slice(text.length - MAX_OUTPUT_CHARS);
}

function buildPlanPrompt(args, allowedRoots, forbiddenPaths, permissionProfile) {
  return [
    "You are Kimi Code working for Codex.",
    "Plan only. You are running in Kimi plan mode and must stay read-only.",
    "Use the Wire plan-mode flow and submit a PlanDisplay-style markdown plan when ready.",
    "Do not execute the implementation. Do not broaden scope.",
    permissionProfile?.summary ?? "Codex permission profile unknown.",
    "You are inspecting a temporary workspace copy for planning. Never write to the original repository path and never use absolute paths from the user request.",
    "Produce a concise markdown plan suitable for the PlanDisplay wire event.",
    "The plan should include the overall goal, current slice, risks, and next action.",
    "Do not wait for human confirmation inside this turn; submit the plan and finish.",
    `Task: ${args.task}`,
    `Allowed scope (relative): ${allowedRoots.map((root) => relative(args.cwd, root) || ".").join(", ")}`,
    `Forbidden paths (relative): ${forbiddenPaths.map((path) => relative(args.cwd, path) || ".").join(", ") || "(none)"}`,
    "Keep the plan compact. Recommend only one implementation slice.",
  ].join("\n");
}

function cleanupDirectory(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Windows can briefly retain child-process handles after a wire session exits.
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function looksLikePlanText(text) {
  return typeof text === "string"
    && /current slice|next action|overall goal|risks|当前|下一步|风险|目标/i.test(text)
    && text.trim().length >= 80;
}

function buildImplementationPrompt(args, allowedRoots, forbiddenPaths, permissionProfile) {
  return [
    "You are Kimi Code working for Codex.",
    "Inherit the current Codex thread permission profile and stay within it.",
    permissionProfile?.summary ?? "Codex permission profile unknown.",
    "Execute only this slice.",
    "Do not broaden scope. If more work remains, stop after this slice and leave the remaining work for Codex to schedule.",
    "Final checks are run once by the MCP. Do not repeat the caller's final checks unless they are required to understand the bug.",
    `Task: ${args.task}`,
    `CWD: ${args.cwd}`,
    `Allowed scope: ${allowedRoots.map((root) => relative(args.cwd, root) || ".").join(", ")}`,
    `Forbidden paths: ${forbiddenPaths.map((path) => relative(args.cwd, path) || ".").join(", ") || "(none)"}`,
    "After you finish the slice, stop cleanly.",
  ].join("\n");
}

function parsePlanOutput(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  const content = text.trim();
  const labeled = parseLabeledPlanContent(content);
  if (labeled) return labeled;
  return fallbackPlanContent(content);
}

function parseLabeledPlanContent(content) {
  const sections = extractMarkdownSections(content);
  const plan_summary = firstNonEmpty(sections.summary ?? sections.goal ?? sections.overall_goal ?? sections["plan summary"] ?? sections["overall goal"])
    ?? firstNonEmpty(extractParagraphs(content).slice(0, 1))
    ?? content.slice(0, 240);
  const current_slice = firstNonEmpty(sections["current slice"] ?? sections.slice ?? sections.task ?? sections["current work"])
    ?? findFirstBullet(sections, ["current slice", "slice", "task", "next step"])
    ?? firstBullet(content)
    ?? plan_summary;
  const risks = collectRiskLines(content, sections);
  const next_action = firstNonEmpty(sections["next action"] ?? sections.next ?? sections.action)
    ?? "Review the plan display, confirm the current slice, then call kimi_start_implementation.";
  if (!plan_summary && !current_slice && risks.length === 0 && !next_action) return null;
  return { plan_summary, current_slice, risks, next_action };
}

function fallbackPlanContent(content) {
  const paragraphs = extractParagraphs(content);
  const bullets = extractBullets(content);
  const risks = collectRiskLines(content, {});
  return {
    plan_summary: paragraphs[0] ?? content.slice(0, 240),
    current_slice: bullets[0] ?? paragraphs[1] ?? paragraphs[0] ?? content.slice(0, 160),
    risks,
    next_action: "Review the plan display, confirm the current slice, then call kimi_start_implementation.",
  };
}

function extractMarkdownSections(content) {
  const sections = {};
  let current = null;
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const headingMatch = line.match(/^(?:#{1,6}\s*)?([A-Za-z][A-Za-z0-9 _-]{1,60}?|[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9 _-]{0,60})\s*[:：-]?\s*$/);
    if (headingMatch && !line.startsWith("-") && !line.startsWith("*")) {
      current = normalizeSectionName(headingMatch[1]);
      sections[current] = sections[current] ?? [];
      continue;
    }
    const labeled = line.match(/^(?:#{1,6}\s*)?([A-Za-z][A-Za-z0-9 _-]{1,60}?|[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9 _-]{0,60})\s*[:：]\s*(.+)$/);
    if (labeled) {
      const key = normalizeSectionName(labeled[1]);
      sections[key] = sections[key] ?? [];
      sections[key].push(labeled[2].trim());
      current = key;
      continue;
    }
    if (current) {
      sections[current] = sections[current] ?? [];
      sections[current].push(line);
    }
  }
  return Object.fromEntries(Object.entries(sections).map(([key, values]) => [key, values.join(" ").trim()]));
}

function normalizeSectionName(value) {
  return value.toLowerCase().replace(/^[#\s]+/, "").replace(/\s+/g, " ").trim();
}

function findFirstBullet(sections, names) {
  for (const name of names) {
    const text = sections[name];
    if (text) {
      const bullet = extractBullets(text)[0];
      if (bullet) return bullet;
    }
  }
  return null;
}

function collectRiskLines(content, sections) {
  const lines = new Set();
  const candidates = [
    sections.risks,
    sections.risk,
    sections["risk notes"],
    sections["known risks"],
    sections["risk considerations"],
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    for (const item of extractBullets(candidate)) lines.add(item);
    for (const item of extractParagraphs(candidate)) if (/\brisk|风险|注意|caution\b/i.test(item)) lines.add(item);
  }
  for (const item of extractParagraphs(content)) {
    if (/\brisk|风险|注意|caution\b/i.test(item)) lines.add(item);
  }
  return [...lines].filter(Boolean);
}

function extractParagraphs(content) {
  return content
    .split(/\r?\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => paragraph.replace(/\r?\n+/g, " ").trim());
}

function extractBullets(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .filter(Boolean);
}

function firstBullet(content) {
  return extractBullets(content)[0] ?? null;
}

function firstNonEmpty(value) {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

function waitReturnGuardMs(maxWaitMs) {
  if (maxWaitMs < DEFAULT_WAIT_RETURN_GUARD_TRIGGER_MS) return 0;
  return Math.min(DEFAULT_WAIT_RETURN_GUARD_MS, Math.max(0, maxWaitMs - 1_000));
}
