# Kimi Code Worker MCP

Languages: [English](README.md) | [简体中文](README.zh-CN.md)

MCP server for Codex Desktop that delegates coding work to **Kimi Code CLI over Wire**.

The workflow is intentionally narrow:

- Codex compresses the task, defines the current slice, and defines final checks.
- Kimi Code executes one slice.
- MCP returns lightweight running status.
- MCP runs one authoritative host-side check pass at terminal state.
- Codex reviews the terminal summary and requests diff only when needed.

This project is optimized for lower Codex main-thread token usage on suitable coding tasks, not for interactive mid-run chatting.

## What It Does

- Runs Kimi Code CLI in `--wire` mode as the worker backend
- Exposes six worker tools:
  - `kimi_plan_implementation`
  - `kimi_start_implementation`
  - `kimi_get_job`
  - `kimi_wait_for_job`
  - `kimi_steer_job`
  - `kimi_cancel_job`
- Supports explicit plan mode with `PlanDisplay`-based plan summaries
- Keeps running-state output compact and factual
- Runs host-side `checks` once at terminal state
- Inherits the current Codex thread permission profile automatically from `~/.codex/.codex-global-state.json`
- Includes `setup` and `doctor` for install and environment checks

## Requirements

- Node.js 20+
- Kimi Code CLI installed and logged in
- A Codex Desktop environment with `~/.codex/.codex-global-state.json`

Install Kimi Code CLI on Windows:

```powershell
irm https://code.kimi.com/install.ps1 | iex
kimi login
```

Or on macOS / Linux:

```bash
curl -L code.kimi.com/install.sh | bash
kimi login
```

## Quick Start

From this repository:

```bash
npm install
npm run mcp:setup
npm run mcp:doctor
```

Codex Desktop MCP config example for `~/.codex/config.toml`:

```toml
[mcp_servers."kimi-code-worker-mcp"]
command = "node"
args = ['C:\absolute\path\to\kimi-code-worker\bin\kimi-code-worker-mcp.mjs']
```

If you prefer a local script entry point, use `node src/kimi-code-worker-mcp.mjs` or `npm run mcp:start`.

## Permission Inheritance

At startup, the MCP reads the current Codex thread id from `CODEX_THREAD_ID` and looks up the thread policy in `~/.codex/.codex-global-state.json`.

The current thread policy is normalized into one of these profiles:

- `full-access`
- `auto-review`
- `request-consent`

The worker then adjusts Kimi Code behavior accordingly:

- `full-access`: auto-approve tool calls and enable AFK-style execution
- `auto-review`: keep the worker autonomous, but apply inherited policy-based request handling
- `request-consent`: fail closed on privileged requests instead of silently escalating

This inheritance is automatic. No extra config is needed when Codex Desktop already has a thread policy.

## Plan Mode

`kimi_plan_implementation` switches Kimi Code into plan mode, asks it to submit a markdown plan through Wire, and returns a compact plan summary with:

- `plan_summary`
- `current_slice`
- `risks`
- `next_action`
- `plan_path`

Plan mode runs in a temporary sandbox. If the plan mutates either the sandbox or the original workspace, the MCP rejects the plan result.

## Recommended Use

Task routing:

- Small fix: call `kimi_start_implementation` directly with narrow `allowed_dirs` and `checks`.
- Cross-module or ambiguous work: call `kimi_plan_implementation` first, review only `current_slice`, then start execution.
- Long task: split it into multiple slices. During execution, use short polling and avoid repeated logs/events.
- Clear misdirection: prefer cancel and restart. Use `kimi_steer_job` only when the direction is mostly right and one correction is enough.
- Failed result: rely on `failure_reason`, such as `checks_failed`, `changed_outside_allowed_scope`, `worker_failed`, or `worker_max_steps_reached`.

Start a worker:

```json
{
  "name": "kimi_start_implementation",
  "arguments": {
    "cwd": "/absolute/project/path",
    "task": "Make the requested code change.",
    "checks": [
      "npm test"
    ]
  }
}
```

Read compact status:

```json
{
  "name": "kimi_get_job",
  "arguments": {
    "job_id": "kcw_..."
  }
}
```

Stable polling pattern:

1. Start with `kimi_start_implementation`.
2. Use `kimi_wait_for_job` once with a short window, around `15000-30000ms`.
3. If the job is still running, switch to `kimi_get_job` every `15000-30000ms`.
4. Request one stronger evidence sample through `kimi_get_job` with `include_logs` or `include_events` only when debugging a suspected stall.

## Windows Checks

On Windows, write `checks` as PowerShell-compatible commands when possible:

```json
{
  "checks": [
    "Get-Content -LiteralPath hello.txt",
    "npm test"
  ]
}
```

## Large Repositories And Long Tasks

The MCP applies budgets to workspace snapshots and planning sandboxes so large repositories do not turn status checks into long blocking operations.

Configurable environment variables:

- `KIMI_CODE_WORKER_MAX_SNAPSHOT_FILES`
- `KIMI_CODE_WORKER_MAX_SNAPSHOT_CONTENT_BYTES`
- `KIMI_CODE_WORKER_MAX_PLAN_SANDBOX_FILES`
- `KIMI_CODE_WORKER_MAX_PLAN_SANDBOX_BYTES`

If a snapshot reaches its budget, `progress.facts` reports that explicitly. Terminal results include a `workspace_snapshot` summary so Codex can decide whether to rerun with narrower `allowed_dirs`.

## Smoke Tests

```bash
npm run mcp:smoke:wire
npm run mcp:smoke:workflow
npm run mcp:smoke:edge
```

## Status

This is a beta repository. Use it for internal workflows and iterate with the smoke tests before broad rollout.
