import { existsSync, readFileSync } from "node:fs";
import { CODEX_GLOBAL_STATE_FILE } from "./config.mjs";

const APPROVAL_POLICY_ALIASES = new Map([
  ["never", "full_access"],
  ["on-request", "auto_review"],
  ["on-failure", "auto_review"],
  ["untrusted", "request_consent"],
]);

const SANDBOX_ALIASES = new Map([
  ["danger-full-access", "full_access"],
  ["dangerFullAccess", "full_access"],
  ["workspace-write", "auto_review"],
  ["workspaceWrite", "auto_review"],
  ["read-only", "request_consent"],
  ["readOnly", "request_consent"],
]);

export function readCodexPermissionContext(threadId = process.env.CODEX_THREAD_ID) {
  if (!existsSync(CODEX_GLOBAL_STATE_FILE)) {
    return {
      source_file: CODEX_GLOBAL_STATE_FILE,
      thread_id: threadId ?? null,
      resolution_source: threadId ? "env" : "unresolved",
      found: false,
      approval_policy: null,
      approvals_reviewer: null,
      sandbox_policy: null,
      permission_profile: inferPermissionProfile(null),
    };
  }

  let state;
  try {
    state = JSON.parse(readFileSync(CODEX_GLOBAL_STATE_FILE, "utf8"));
  } catch {
    return {
      source_file: CODEX_GLOBAL_STATE_FILE,
      thread_id: threadId,
      resolution_source: threadId ? "env" : "unresolved",
      found: false,
      approval_policy: null,
      approvals_reviewer: null,
      sandbox_policy: null,
      permission_profile: inferPermissionProfile(null),
    };
  }

  const resolved = resolvePermissionRecord(state, threadId);
  const record = resolved?.record ?? null;
  const resolvedThreadId = resolved?.thread_id ?? threadId ?? null;
  const approval_policy = normalizeApprovalPolicy(record?.approvalPolicy ?? null);
  const approvals_reviewer = typeof record?.approvalsReviewer === "string" ? record.approvalsReviewer : null;
  const sandbox_policy = normalizeSandboxPolicy(record?.sandboxPolicy ?? null);
  return {
    source_file: CODEX_GLOBAL_STATE_FILE,
    thread_id: resolvedThreadId,
    resolution_source: resolved?.source ?? (threadId ? "env" : "unresolved"),
    found: Boolean(record),
    approval_policy,
    approvals_reviewer,
    sandbox_policy,
    permission_profile: inferPermissionProfile({
      approval_policy,
      approvals_reviewer,
      sandbox_policy,
    }),
  };
}

export function inferPermissionProfile(context) {
  if (!context) {
    return {
      mode: "unknown",
      label: "unknown",
      summary: "Codex permission could not be read.",
      auto_approve: false,
      allow_questions: false,
      approval_policy: null,
      sandbox_policy: null,
    };
  }

  const approval_policy = normalizeApprovalPolicy(context.approval_policy ?? null);
  const sandbox_policy = normalizeSandboxPolicy(context.sandbox_policy ?? null);
  const sandboxMode = sandbox_policy?.type ? SANDBOX_ALIASES.get(sandbox_policy.type) ?? "unknown" : "unknown";
  const policyMode = approval_policy ? APPROVAL_POLICY_ALIASES.get(approval_policy) ?? "unknown" : "unknown";

  let mode = "unknown";
  if (sandboxMode === "full_access" || policyMode === "full_access") mode = "full_access";
  else if (sandboxMode === "auto_review" || policyMode === "auto_review") mode = "auto_review";
  else if (sandboxMode === "request_consent" || policyMode === "request_consent") mode = "request_consent";

  const label = {
    full_access: "full-access",
    auto_review: "auto-review",
    request_consent: "request-consent",
    unknown: "unknown",
  }[mode];

  return {
    mode,
    label,
    summary: formatPermissionSummary({ approval_policy, sandbox_policy, mode, label }),
    auto_approve: mode === "full_access",
    allow_questions: mode !== "request_consent",
    approval_policy,
    sandbox_policy,
  };
}

export function formatPermissionSummary(permissionProfile) {
  if (!permissionProfile) return "Permission profile unknown.";
  const approval = permissionProfile.approval_policy ?? "unknown";
  const sandbox = permissionProfile.sandbox_policy?.type ?? "unknown";
  return `Codex permission profile: ${permissionProfile.label ?? "unknown"} (approval_policy=${approval}, sandbox=${sandbox}).`;
}

export function permissionSummaryLine(permissionProfile) {
  return formatPermissionSummary(permissionProfile);
}

function findPermissionRecord(state, threadId) {
  if (!threadId) return null;
  const stack = [state];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, value] of Object.entries(current)) {
      if (isThreadPermissionMapKey(key) && value && typeof value === "object" && value[threadId]) {
        return value[threadId];
      }
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return null;
}

function resolvePermissionRecord(state, threadId) {
  const direct = findPermissionRecord(state, threadId);
  if (direct) return { thread_id: threadId, record: direct, source: threadId ? "env" : "direct_lookup" };
  if (!threadId) {
    const inferredThreadId = inferLikelyThreadId(state);
    const inferredRecord = findPermissionRecord(state, inferredThreadId);
    if (inferredThreadId && inferredRecord) {
      return { thread_id: inferredThreadId, record: inferredRecord, source: "inferred_thread" };
    }
  }
  const all = collectPermissionRecords(state);
  if (!threadId && all.length === 1) {
    return { ...all[0], source: "single_permission_record" };
  }
  return { thread_id: threadId ?? null, record: null, source: threadId ? "env" : "unresolved" };
}

function collectPermissionRecords(state) {
  const stack = [state];
  const records = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, value] of Object.entries(current)) {
      if (isThreadPermissionMapKey(key) && value && typeof value === "object") {
        for (const [thread_id, record] of Object.entries(value)) {
          if (record && typeof record === "object") {
            records.push({ thread_id, record });
          }
        }
      }
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return records;
}

function isThreadPermissionMapKey(key) {
  return typeof key === "string" && key.endsWith("thread-permissions-by-id");
}

function inferLikelyThreadId(state) {
  const pinned = state?.["pinned-thread-ids"];
  if (Array.isArray(pinned)) {
    const normalized = pinned.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
    if (normalized.length === 1) return normalized[0];
  }
  const directCandidates = [
    state?.["current-thread-id"],
    state?.currentThreadId,
    state?.["active-thread-id"],
    state?.activeThreadId,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return null;
}

function normalizeApprovalPolicy(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim();
}

function normalizeSandboxPolicy(value) {
  if (!value || typeof value !== "object") return null;
  const type = typeof value.type === "string" ? value.type.trim() : null;
  const networkAccess = typeof value.networkAccess === "boolean" ? value.networkAccess : null;
  const writableRoots = Array.isArray(value.writableRoots)
    ? value.writableRoots.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim())
    : null;
  return {
    ...value,
    type,
    networkAccess,
    writableRoots,
  };
}
