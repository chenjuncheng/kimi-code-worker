import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const codexHome = join(tmpdir(), `kimi-code-worker-registration-smoke-${Date.now()}`);
mkdirSync(codexHome, { recursive: true });

writeFileSync(join(codexHome, "config.toml"), `
[mcp_servers."kimi-code-worker-mcp"]
command = "cmd"
args = ["/d", "/s", "/c", "kimi-code-worker-mcp"]
startup_timeout_sec = 120
`.trimStart());

const originalCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = codexHome;

try {
  const module = await import(`../src/core/codex-mcp-registration.mjs?ts=${Date.now()}`);
  const config = module.inspectCodexConfigRegistration("kimi-code-worker-mcp", join(codexHome, "config.toml"));
  const checks = {
    config_detected: config.has_entry === true,
    config_ok: config.ok === true,
    detail_reported: config.detail === "config_entry_found",
  };
  process.stdout.write(`${JSON.stringify({ ok: Object.values(checks).every(Boolean), checks, config }, null, 2)}\n`);
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} finally {
  if (originalCodexHome == null) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  try {
    rmSync(codexHome, { recursive: true, force: true });
  } catch {}
}
