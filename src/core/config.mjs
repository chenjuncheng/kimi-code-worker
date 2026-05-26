import { dirname, resolve, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const SERVER_VERSION = "0.1.0";
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SELF_SCRIPT = resolve(process.argv[1] ?? "kimi-code-worker-mcp.mjs");
export const JOB_ROOT = resolve(tmpdir(), "kimi-code-worker", "jobs");
export const CODEX_HOME = process.env.CODEX_HOME || resolve(homedir(), ".codex");
export const CODEX_GLOBAL_STATE_FILE = join(CODEX_HOME, ".codex-global-state.json");
export const KIMI_BIN = process.env.KIMI_BIN || "kimi";

export const DEFAULT_SYNC_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_PLAN_TIMEOUT_MS = positiveEnvMs("KIMI_CODE_WORKER_PLAN_TIMEOUT_MS", 5 * 60 * 1000);
export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_FOREGROUND_WAIT_CAP_MS = 10 * 60 * 1000;
export const DEFAULT_WAIT_RETURN_GUARD_MS = positiveEnvMs("KIMI_CODE_WORKER_WAIT_RETURN_GUARD_MS", 5 * 1000);
export const DEFAULT_WAIT_RETURN_GUARD_TRIGGER_MS = positiveEnvMs("KIMI_CODE_WORKER_WAIT_RETURN_GUARD_TRIGGER_MS", 45 * 1000);
export const DEFAULT_RECOMMENDED_WAIT_MS = positiveEnvMs("KIMI_CODE_WORKER_RECOMMENDED_WAIT_MS", 30 * 1000);
export const DEFAULT_RECOMMENDED_POLL_INTERVAL_MS = positiveEnvMs("KIMI_CODE_WORKER_RECOMMENDED_POLL_INTERVAL_MS", 15 * 1000);
export const DEFAULT_IDLE_AFTER_MS = 45 * 1000;
export const DEFAULT_STALL_AFTER_MS = 4 * 60 * 1000;
export const DEFAULT_SETUP_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_WIRE_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 15 * 1000;

export const MAX_OUTPUT_CHARS = 20_000;
export const MAX_STREAM_EVENTS = 200;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SNAPSHOT_FILES = positiveEnvNumber("KIMI_CODE_WORKER_MAX_SNAPSHOT_FILES", 20_000);
export const MAX_SNAPSHOT_CONTENT_BYTES = positiveEnvNumber("KIMI_CODE_WORKER_MAX_SNAPSHOT_CONTENT_BYTES", 50 * 1024 * 1024);
export const MAX_PLAN_SANDBOX_FILES = positiveEnvNumber("KIMI_CODE_WORKER_MAX_PLAN_SANDBOX_FILES", 5_000);
export const MAX_PLAN_SANDBOX_BYTES = positiveEnvNumber("KIMI_CODE_WORKER_MAX_PLAN_SANDBOX_BYTES", 25 * 1024 * 1024);
export const MAX_DIFF_LINES = 2_000;
export const MAX_DIFF_BYTES = 1 * 1024 * 1024;
export const TOOLS_SCHEMA_BUDGET = 12_000;

export const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "out",
  "coverage",
]);

export const DEFAULT_FORBIDDEN_PATHS = [
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".pypirc",
];

export const TOOL_NAMES = {
  plan: "kimi_plan_implementation",
  start: "kimi_start_implementation",
  get: "kimi_get_job",
  wait: "kimi_wait_for_job",
  steer: "kimi_steer_job",
  cancel: "kimi_cancel_job",
};

export const PLATFORM_INSTALL_HINTS = {
  win32: "irm https://code.kimi.com/install.ps1 | iex",
  darwin: "curl -L code.kimi.com/install.sh | bash",
  linux: "curl -L code.kimi.com/install.sh | bash",
};

export function positiveEnvMs(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function positiveEnvNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
