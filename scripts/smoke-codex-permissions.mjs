import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const codexHome = join(tmpdir(), `kimi-code-worker-permission-smoke-${Date.now()}`);
mkdirSync(codexHome, { recursive: true });

const targetThreadId = "thread-pinned-1";
const otherThreadId = "thread-other-2";
const state = {
  "pinned-thread-ids": [targetThreadId],
  "heartbeat-thread-permissions-by-id": {
    [targetThreadId]: {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
    [otherThreadId]: {
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "readOnly" },
    },
  },
};

writeFileSync(join(codexHome, ".codex-global-state.json"), JSON.stringify(state, null, 2));

const originalCodexHome = process.env.CODEX_HOME;
const originalThreadId = process.env.CODEX_THREAD_ID;
delete process.env.CODEX_THREAD_ID;
process.env.CODEX_HOME = codexHome;

try {
  const { readCodexPermissionContext } = await import(`../src/core/codex-permissions.mjs?ts=${Date.now()}`);
  const resolved = readCodexPermissionContext();
  const checks = {
    resolved_thread_from_pinned: resolved.thread_id === targetThreadId,
    resolved_source_reported: resolved.resolution_source === "inferred_thread",
    permission_found: resolved.found === true,
    profile_is_full_access: resolved.permission_profile?.label === "full-access",
  };
  process.stdout.write(`${JSON.stringify({ ok: Object.values(checks).every(Boolean), checks, resolved }, null, 2)}\n`);
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} finally {
  if (originalCodexHome == null) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalThreadId == null) delete process.env.CODEX_THREAD_ID;
  else process.env.CODEX_THREAD_ID = originalThreadId;
  try {
    rmSync(codexHome, { recursive: true, force: true });
  } catch {}
}
