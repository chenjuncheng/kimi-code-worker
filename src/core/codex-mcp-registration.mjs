import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CODEX_CONFIG_FILE } from "./config.mjs";

const execFileAsync = promisify(execFile);

export function inspectCodexConfigRegistration(serverName, configFile = CODEX_CONFIG_FILE) {
  if (!existsSync(configFile)) {
    return {
      ok: false,
      config_file: configFile,
      has_entry: false,
      detail: "config_missing",
    };
  }

  const content = readFileSync(configFile, "utf8");
  const quotedSection = `[mcp_servers."${serverName}"]`;
  const bareSection = `[mcp_servers.${serverName}]`;
  const hasEntry = content.includes(quotedSection) || content.includes(bareSection);

  return {
    ok: hasEntry,
    config_file: configFile,
    has_entry: hasEntry,
    detail: hasEntry ? "config_entry_found" : "config_entry_missing",
  };
}

export function resolveCodexCliCandidates() {
  const candidates = [];
  const seen = new Set();

  const add = (value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };

  add(process.env.CODEX_CLI_PATH);
  if (platform() === "win32" && process.env.LOCALAPPDATA) {
    add(join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "codex.exe"));
  }
  add("codex");

  return candidates;
}

export async function inspectCodexCliRegistration(serverName, candidates = resolveCodexCliCandidates()) {
  const attempts = [];

  for (const candidate of candidates) {
    try {
      const { stdout, stderr } = await execFileAsync(candidate, ["mcp", "list"], {
        timeout: 15_000,
        windowsHide: true,
      });
      const combined = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
      const registered = combined.includes(serverName);
      return {
        ok: registered,
        registered,
        cli_path: candidate,
        detail: registered ? "cli_list_found" : "cli_list_missing",
        attempts,
        output_sample: combined.slice(0, 500),
      };
    } catch (error) {
      attempts.push({
        cli_path: candidate,
        error: error.message,
      });
    }
  }

  return {
    ok: false,
    registered: false,
    cli_path: null,
    detail: "cli_unavailable",
    attempts,
    output_sample: "",
  };
}

export async function readCodexMcpRegistrationStatus(serverName) {
  const config = inspectCodexConfigRegistration(serverName);
  const cli = await inspectCodexCliRegistration(serverName);
  const ok = config.has_entry || cli.registered;

  return {
    ok,
    server_name: serverName,
    source: config.has_entry ? "config" : cli.registered ? "cli_list" : "missing",
    config,
    cli,
  };
}
