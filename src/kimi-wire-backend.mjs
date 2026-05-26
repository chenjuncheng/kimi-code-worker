import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_WIRE_REQUEST_TIMEOUT_MS,
  KIMI_BIN,
} from "./core/config.mjs";
import {
  formatPermissionSummary,
  inferPermissionProfile,
  readCodexPermissionContext,
} from "./core/codex-permissions.mjs";
import {
  extractPlanDisplay,
  extractStatusUpdate,
  extractTextDelta,
  stageFromWireEvent,
  summarizeWireEvent,
  wireType,
} from "./core/stream-events.mjs";

const infoCache = new Map();

export async function getKimiInfo(kimiBin = KIMI_BIN) {
  if (infoCache.has(kimiBin)) return infoCache.get(kimiBin);
  const invocation = nodeScriptInvocation(kimiBin, ["info"]);
  const result = await runCommand(invocation.command, invocation.args, { timeout_ms: DEFAULT_CONNECT_TIMEOUT_MS });
  if (result.exit_code !== 0) {
    throw new Error(`kimi info failed: ${result.stderr || result.stdout || `exit ${result.exit_code}`}`);
  }
  const info = parseKimiInfo(result.stdout);
  infoCache.set(kimiBin, info);
  return info;
}

export async function probeKimiPrint(kimiBin = KIMI_BIN) {
  const invocation = nodeScriptInvocation(kimiBin, ["--print", "--final-message-only", "-p", "Return exactly OK"]);
  const result = await runCommand(invocation.command, invocation.args, { timeout_ms: DEFAULT_CONNECT_TIMEOUT_MS });
  return {
    ok: result.exit_code === 0 && /\bOK\b/.test(result.stdout),
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exit_code: result.exit_code,
  };
}

export class KimiWireBackend {
  constructor({
    cwd,
    model = null,
    kimi_bin = KIMI_BIN,
    plan_mode = false,
    codex_permission = null,
    permission_profile = null,
    request_timeout_ms = DEFAULT_WIRE_REQUEST_TIMEOUT_MS,
    onEvent = null,
    onRequest = null,
    onStdout = null,
    onStderr = null,
    onExit = null,
  }) {
    this.cwd = cwd;
    this.model = model;
    this.kimi_bin = kimi_bin;
    this.plan_mode = plan_mode;
    this.codex_permission = codex_permission;
    this.permission_profile = permission_profile;
    this.permission_summary = formatPermissionSummary(permission_profile);
    this.request_timeout_ms = request_timeout_ms;
    this.onEvent = onEvent;
    this.onRequest = onRequest;
    this.onStdout = onStdout;
    this.onStderr = onStderr;
    this.onExit = onExit;
    this.child = null;
    this.protocol_version = null;
    this.server_info = null;
    this.pending = new Map();
    this.request_counter = 0;
    this.closed = false;
    this.exitPromise = new Promise((resolvePromise) => {
      this._resolveExit = resolvePromise;
    });
  }

  async start() {
    if (this.child) return;
    const info = await getKimiInfo(this.kimi_bin);
    this.protocol_version = info.wire_protocol_version || "1.10";
    if (!this.codex_permission) this.codex_permission = readCodexPermissionContext();
    if (!this.permission_profile) this.permission_profile = inferPermissionProfile(this.codex_permission);
    this.permission_summary = formatPermissionSummary(this.permission_profile);
    const args = ["--wire", "--work-dir", this.cwd];
    if (!this.plan_mode && this.permission_profile.auto_approve) {
      args.splice(1, 0, "--afk");
    }
    if (this.model) args.push("--model", this.model);
    const invocation = nodeScriptInvocation(this.kimi_bin, args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (this.onStdout) this.onStdout(line);
      this.#handleLine(line);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (this.onStderr) this.onStderr(text);
    });
    child.on("close", (code, signal) => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Kimi Wire process exited before response: code=${code} signal=${signal}`));
      }
      this.pending.clear();
      if (this.onExit) this.onExit({ code, signal });
      this._resolveExit({ code, signal });
    });
    await this.initialize();
  }

  async initialize() {
    const response = await this.sendRequest("initialize", {
      protocol_version: this.protocol_version,
      client: { name: "kimi-code-worker", version: "0.1.0" },
      capabilities: {
        supports_question: this.permission_profile?.allow_questions !== false,
        supports_plan_mode: true,
      },
    });
    this.server_info = response.server ?? null;
    if (response.protocol_version) {
      this.protocol_version = response.protocol_version;
    }
    return response;
  }

  async setPlanMode(enabled) {
    return this.sendRequest("set_plan_mode", { enabled });
  }

  async prompt(user_input) {
    return this.sendRequest("prompt", { user_input }, this.request_timeout_ms);
  }

  async steer(user_input) {
    return this.sendRequest("steer", { user_input }, 30_000);
  }

  async cancel() {
    return this.sendRequest("cancel", {}, 30_000);
  }

  async close() {
    if (!this.child || this.closed) return;
    this.child.kill("SIGTERM");
    await Promise.race([
      this.exitPromise,
      new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
    ]);
    if (!this.closed) this.child.kill("SIGKILL");
  }

  sendRequest(method, params = {}, timeout_ms = DEFAULT_WIRE_REQUEST_TIMEOUT_MS) {
    if (!this.child || this.closed) {
      return Promise.reject(new Error("Kimi Wire process is not running"));
    }
    const id = `${Date.now()}-${++this.request_counter}`;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Timed out waiting for Wire response: ${method}`));
      }, timeout_ms);
      this.pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async #handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id && (message.result != null || message.error != null) && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || "Wire request failed");
        error.code = message.error.code;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "event") {
      const params = message.params ?? {};
      if (this.onEvent) {
        const stage = stageFromWireEvent(params);
        this.onEvent({
          raw: params,
          type: wireType(params),
          summary: summarizeWireEvent(params),
          stage,
          text: extractTextDelta(params),
          plan: extractPlanDisplay(params),
          status_update: extractStatusUpdate(params),
        });
      }
      return;
    }

    if (message.method === "request") {
      const params = message.params ?? {};
      if (this.onRequest) {
        this.onRequest({
          id: message.id,
          type: wireType(params),
          raw: params,
          summary: summarizeWireEvent(params),
        });
      }
      await this.#respondToRequest(message.id, params);
    }
  }

  async #respondToRequest(id, params) {
    const type = wireType(params);
    const payload = params?.payload ?? {};
    if (!this.child || this.closed) return;
    if (type === "ApprovalRequest") {
      const decision = decideApprovalResponse(payload, this.permission_profile);
      this.child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          request_id: payload.id ?? id,
          response: decision.response,
          ...(decision.feedback ? { feedback: decision.feedback } : {}),
        },
      })}\n`);
      return;
    }
    if (type === "QuestionRequest") {
      this.child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { request_id: payload.id ?? id, answers: {} },
      })}\n`);
      return;
    }
    if (type === "HookRequest") {
      const decision = decideHookResponse(payload, this.permission_profile);
      this.child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          request_id: payload.id ?? id,
          action: decision.action,
          reason: decision.reason,
        },
      })}\n`);
      return;
    }
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32003,
        message: `Unsupported Wire client request: ${type}`,
      },
    })}\n`);
  }
}

export function isExecutable(path) {
  try {
    if (isAbsolute(path)) {
      accessSync(path, fsConstants.X_OK);
      return true;
    }
    return true;
  } catch {
    return false;
  }
}

function parseKimiInfo(stdout) {
  const version = stdout.match(/kimi-cli version:\s*([^\r\n]+)/i)?.[1]?.trim() ?? null;
  const wire = stdout.match(/wire protocol:\s*([^\r\n]+)/i)?.[1]?.trim() ?? null;
  const python = stdout.match(/python version:\s*([^\r\n]+)/i)?.[1]?.trim() ?? null;
  return {
    version,
    wire_protocol_version: wire,
    python_version: python,
    raw: stdout,
  };
}

function nodeScriptInvocation(command, args) {
  if (/\.(mjs|cjs|js)$/i.test(command) && existsSync(command)) {
    return {
      command: process.execPath,
      args: [command, ...args],
    };
  }
  return { command, args };
}

function decideApprovalResponse(payload, permissionProfile) {
  const profile = permissionProfile?.mode ?? "unknown";
  if (profile === "full_access") {
    return { response: "approve_for_session" };
  }
  if (profile === "request_consent") {
    return {
      response: "reject",
      feedback: "Inherited Codex thread permission is request-consent; rerun with a narrower slice or higher permission.",
    };
  }
  if (isLikelySafeApprovalRequest(payload)) {
    return { response: "approve_for_session" };
  }
  return {
    response: "reject",
    feedback: "Blocked by inherited Codex thread permission profile; narrow the task or request a higher-privilege run.",
  };
}

function decideHookResponse(payload, permissionProfile) {
  const profile = permissionProfile?.mode ?? "unknown";
  if (profile === "full_access") {
    return { action: "allow", reason: "" };
  }
  if (profile === "request_consent") {
    return isLikelySafeHookRequest(payload)
      ? { action: "allow", reason: "" }
      : { action: "block", reason: "Inherited Codex thread permission is request-consent." };
  }
  return isLikelySafeHookRequest(payload)
    ? { action: "allow", reason: "" }
    : { action: "block", reason: "Blocked by inherited Codex thread permission profile." };
}

function isLikelySafeApprovalRequest(payload) {
  const text = [payload?.sender, payload?.action, payload?.description]
    .filter((item) => typeof item === "string")
    .join(" ")
    .toLowerCase();
  if (text === "") return true;
  if (/\b(read|inspect|list|glob|grep|status|help|show|view|open)\b/.test(text)) return true;
  if (/\b(write|edit|delete|remove|rm|move|rename|truncate|append|patch|shell|command|install|network|curl|wget|chmod|chown|sudo)\b/.test(text)) {
    return false;
  }
  return true;
}

function isLikelySafeHookRequest(payload) {
  const text = JSON.stringify(payload ?? {}).toLowerCase();
  if (/\b(write|delete|remove|rm|move|rename|truncate|append|patch|sudo|chmod|chown|network)\b/.test(text)) {
    return false;
  }
  return true;
}

function runCommand(command, args, { timeout_ms = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeout_ms);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exit_code: code, stdout, stderr });
    });
  });
}
