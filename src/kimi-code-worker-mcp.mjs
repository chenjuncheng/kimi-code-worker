#!/usr/bin/env node
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  CODEX_CONFIG_FILE,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_FOREGROUND_WAIT_CAP_MS,
  DEFAULT_PLAN_TIMEOUT_MS,
  DEFAULT_SETUP_TIMEOUT_MS,
  DEFAULT_SYNC_TIMEOUT_MS,
  JOB_ROOT,
  KIMI_BIN,
  PLATFORM_INSTALL_HINTS,
  SERVER_VERSION,
  TOOL_NAMES,
} from "./core/config.mjs";
import { formatPermissionSummary, readCodexPermissionContext } from "./core/codex-permissions.mjs";
import { readCodexMcpRegistrationStatus } from "./core/codex-mcp-registration.mjs";
import { getKimiInfo, isExecutable, probeKimiPrint } from "./kimi-wire-backend.mjs";
import { JobRuntime } from "./job-runtime.mjs";

const runtime = new JobRuntime();
const execFileAsync = promisify(execFile);

const outputSchema = z.object({
  server_version: z.string(),
  status: z.string(),
}).passthrough();

const planSchema = z.object({
  cwd: z.string(),
  task: z.string(),
  allowed_dirs: z.array(z.string()).optional(),
  forbidden_paths: z.array(z.string()).optional(),
  ignored_dirs: z.array(z.string()).optional(),
  model: z.string().optional(),
  timeout_ms: z.number().optional(),
  kimi_bin: z.string().optional(),
});

const startSchema = z.object({
  cwd: z.string(),
  task: z.string().describe("One implementation slice. Codex should define scope and final acceptance before calling this tool."),
  allowed_dirs: z.array(z.string()).optional(),
  forbidden_paths: z.array(z.string()).optional(),
  ignored_dirs: z.array(z.string()).optional(),
  checks: z.array(z.string()).optional(),
  model: z.string().optional(),
  timeout_ms: z.number().optional(),
  check_timeout_ms: z.number().optional(),
  kimi_bin: z.string().optional(),
});

const getSchema = z.object({
  job_id: z.string(),
  include_logs: z.boolean().optional(),
  include_events: z.boolean().optional(),
  include_diff: z.boolean().optional(),
});

const waitSchema = getSchema.extend({
  max_wait_ms: z.number().optional().describe("Short foreground observation window. Prefer about 15000-30000ms."),
  poll_interval_ms: z.number().optional().describe("Short internal observation interval. Prefer about 5000-15000ms."),
});

const steerSchema = z.object({
  job_id: z.string(),
  guidance: z.string().describe("One concise correction for a running job. Use only when direction is clearly wrong."),
});

const cancelSchema = z.object({
  job_id: z.string(),
});

if (process.argv.includes("--setup")) {
  runSetup().then((ok) => process.exit(ok ? 0 : 1));
} else if (process.argv.includes("--doctor")) {
  runDoctor({ live: process.argv.includes("--live") }).then((ok) => process.exit(ok ? 0 : 1));
} else {
  runMcpServer().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

async function runMcpServer() {
  installLifecycleHandlers();
  const server = new McpServer({
    name: "kimi-code-worker-mcp",
    version: SERVER_VERSION,
  });

  server.registerTool(
    TOOL_NAMES.plan,
    {
      title: "Plan Kimi implementation slice",
      description: "Run one explicit planning pass in Kimi plan mode. Returns a compact JSON-ready plan summary without editing files.",
      inputSchema: planSchema,
      outputSchema,
    },
    async (args) => {
      try {
        return toolResult(await runtime.planImplementation(args));
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.start,
    {
      title: "Start Kimi implementation job",
      description: "Start one implementation slice. Codex stays responsible for scope, checks, and final review.",
      inputSchema: startSchema,
      outputSchema,
    },
    async (args) => {
      try {
        return toolResult(await runtime.startImplementation(args));
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.get,
    {
      title: "Read Kimi job status",
      description: "Read compact status or terminal summary. Logs, events, and diffs are opt-in.",
      inputSchema: getSchema,
      outputSchema,
    },
    async (args) => toolResult(await runtime.getJob(args))
  );

  server.registerTool(
    TOOL_NAMES.wait,
    {
      title: "Observe Kimi job briefly",
      description: "Wait briefly for a terminal result. Prefer short windows and switch back to kimi_get_job for the main loop.",
      inputSchema: waitSchema,
      outputSchema,
    },
    async (args) => toolResult(await runtime.waitForJob(args))
  );

  server.registerTool(
    TOOL_NAMES.steer,
    {
      title: "Steer running Kimi job",
      description: "Inject one concise correction into a running job. This is for clear misdirection, not routine interaction.",
      inputSchema: steerSchema,
      outputSchema,
    },
    async (args) => {
      try {
        return toolResult(await runtime.steerJob(args));
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  );

  server.registerTool(
    TOOL_NAMES.cancel,
    {
      title: "Cancel running Kimi job",
      description: "Request cancellation of a running job.",
      inputSchema: cancelSchema,
      outputSchema,
    },
    async (args) => {
      try {
        return toolResult(await runtime.cancelJob(args));
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  );

  await server.connect(new StdioServerTransport());
}

async function runDoctor({ live = false } = {}) {
  const checks = [];
  checks.push({
    name: "node_version",
    ok: Number(process.versions.node.split(".")[0]) >= 20,
    detail: process.version,
  });
  checks.push({
    name: "kimi_cli_path",
    ok: isExecutable(KIMI_BIN),
    detail: KIMI_BIN,
  });
  try {
    const info = await getKimiInfo(KIMI_BIN);
    checks.push({
      name: "kimi_cli_info",
      ok: Boolean(info.version),
      detail: `version=${info.version ?? "unknown"}, wire=${info.wire_protocol_version ?? "unknown"}`,
    });
  } catch (error) {
    checks.push({
      name: "kimi_cli_info",
      ok: false,
      detail: error.message,
    });
  }
  try {
    const probe = await probeKimiPrint(KIMI_BIN);
    checks.push({
      name: "kimi_minimal_call",
      ok: probe.ok,
      detail: probe.ok ? probe.stdout : probe.stderr || probe.stdout || `exit ${probe.exit_code}`,
    });
  } catch (error) {
    checks.push({
      name: "kimi_minimal_call",
      ok: false,
      detail: error.message,
    });
  }
  const codexPermission = readCodexPermissionContext();
  checks.push({
    name: "codex_thread_permission",
    ok: codexPermission.found,
    detail: codexPermission.found ? formatPermissionSummary(codexPermission.permission_profile) : `thread=${codexPermission.thread_id ?? "unknown"}`,
  });
  const codexMcpRegistration = await readCodexMcpRegistrationStatus("kimi-code-worker-mcp");
  checks.push({
    name: "codex_mcp_registration",
    ok: codexMcpRegistration.ok,
    detail: codexMcpRegistration.ok
      ? `registered via ${codexMcpRegistration.source}`
      : `missing registration; checked ${CODEX_CONFIG_FILE} and codex mcp list`,
  });
  checks.push({
    name: "job_root",
    ok: existsSync(JOB_ROOT),
    detail: JOB_ROOT,
  });
  let doctorLive = null;
  if (live) {
    doctorLive = await runDoctorLiveCheck();
    checks.push({
      name: "doctor_live_roundtrip",
      ok: doctorLive.ok,
      detail: doctorLive.ok
        ? `job=${doctorLive.job_id} result=${doctorLive.result_status} permission=${doctorLive.codex_permission_profile}`
        : doctorLive.detail,
    });
  }

  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({
    server: "kimi-code-worker-mcp",
    server_version: SERVER_VERSION,
    checks,
    codex_permission: codexPermission,
    codex_mcp_registration: codexMcpRegistration,
    ...(doctorLive ? { doctor_live: doctorLive } : {}),
    defaults: {
      plan_timeout_ms: DEFAULT_PLAN_TIMEOUT_MS,
      timeout_ms: DEFAULT_SYNC_TIMEOUT_MS,
      check_timeout_ms: DEFAULT_CHECK_TIMEOUT_MS,
      foreground_wait_cap_ms: DEFAULT_FOREGROUND_WAIT_CAP_MS,
    },
  }, null, 2)}\n`);
  return ok;
}

async function runDoctorLiveCheck() {
  const cwd = join(tmpdir(), `kimi-code-worker-doctor-live-${Date.now()}`);
  const liveFile = join(cwd, "reports", "kimi-doctor-live.txt");
  const checkScript = join(cwd, "check-live-output.mjs");
  mkdirSync(join(cwd, "reports"), { recursive: true });
  writeFileSync(checkScript, [
    'import { readFileSync } from "node:fs";',
    'const content = readFileSync("reports/kimi-doctor-live.txt", "utf8").trim();',
    'if (content !== "LIVE_OK") {',
    '  console.error(`Unexpected content: ${content}`);',
    '  process.exit(1);',
    '}',
    'process.stdout.write("LIVE_OK\\n");',
  ].join("\n"));

  const liveRuntime = new JobRuntime();
  try {
    const started = await liveRuntime.startImplementation({
      cwd,
      task: "Create reports/kimi-doctor-live.txt containing exactly LIVE_OK. Only do this slice.",
      allowed_dirs: ["reports", "src"],
      checks: ["node ./check-live-output.mjs"],
      timeout_ms: 120_000,
      check_timeout_ms: 30_000,
    });
    const terminal = await liveRuntime.waitForJob({
      job_id: started.job_id,
      max_wait_ms: 90_000,
      poll_interval_ms: 1_000,
      include_logs: false,
      include_events: false,
      include_diff: false,
    });
    const file_exists = existsSync(liveFile);
    const file_content = file_exists ? readFileSync(liveFile, "utf8").trim() : null;
    const result = terminal.result ?? null;
    const ok = terminal.status === "completed"
      && result?.status === "changed_files"
      && result?.codex_permission_profile !== "unknown"
      && file_exists
      && file_content === "LIVE_OK"
      && Array.isArray(result?.checks_run)
      && result.checks_run.every((check) => check.exit_code === 0 && !check.timed_out);
    return {
      ok,
      detail: ok ? "live roundtrip succeeded" : `live roundtrip failed: terminal=${terminal.status} result=${result?.status ?? "unknown"}`,
      job_id: started.job_id,
      terminal_status: terminal.status,
      result_status: result?.status ?? null,
      codex_permission_profile: result?.codex_permission_profile ?? null,
      useful_outputs_present: Boolean(result?.useful_outputs_present),
      produced_files: result?.produced_files ?? [],
      checks_run: result?.checks_run ?? [],
      file_exists,
      file_content,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error.message,
      job_id: null,
      terminal_status: null,
      result_status: null,
      codex_permission_profile: null,
      useful_outputs_present: false,
      produced_files: [],
      checks_run: [],
      file_exists: existsSync(liveFile),
      file_content: existsSync(liveFile) ? readFileSync(liveFile, "utf8").trim() : null,
    };
  } finally {
    await liveRuntime.shutdown();
    cleanupDoctorLiveDirectory(cwd);
  }
}

function cleanupDoctorLiveDirectory(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Best effort cleanup only.
  }
}

async function runSetup() {
  const hint = PLATFORM_INSTALL_HINTS[platform()] ?? PLATFORM_INSTALL_HINTS.linux;
  if (!isExecutable(KIMI_BIN)) {
    process.stdout.write(`kimi CLI is not available on PATH.\nInstall command: ${hint}\n`);
    if (!(await promptYesNo("Run the official install command now? [y/N] "))) return false;
    const ok = await runInstallCommand();
    if (!ok) return false;
  }

  process.stdout.write("Starting `kimi login` ...\n");
  const { stdout, stderr } = await execFileAsync(KIMI_BIN, ["login"], {
    timeout: DEFAULT_SETUP_TIMEOUT_MS,
    windowsHide: true,
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.stdout.write("Run `node src/kimi-code-worker-mcp.mjs --doctor` to verify the environment.\n");
  return true;
}

async function runInstallCommand() {
  if (platform() === "win32") {
    await execFileAsync("pwsh", ["-NoProfile", "-Command", PLATFORM_INSTALL_HINTS.win32], {
      timeout: DEFAULT_SETUP_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  }
  await execFileAsync("bash", ["-lc", PLATFORM_INSTALL_HINTS[platform()] ?? PLATFORM_INSTALL_HINTS.linux], {
    timeout: DEFAULT_SETUP_TIMEOUT_MS,
    windowsHide: true,
  });
  return true;
}

function installLifecycleHandlers() {
  const shutdown = async (code) => {
    await runtime.shutdown();
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown(130));
  process.on("SIGTERM", () => void shutdown(0));
  process.stdin.on("end", () => void shutdown(0));
}

function promptYesNo(question) {
  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolvePromise(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function toolResult(value) {
  const payload = {
    server_version: SERVER_VERSION,
    ...value,
  };
  return {
    structuredContent: payload,
    content: [
      {
        type: "text",
        text: JSON.stringify(payload),
      },
    ],
  };
}

function toolErrorResult(error) {
  return toolResult({
    status: "error",
    error: error.message,
  });
}
