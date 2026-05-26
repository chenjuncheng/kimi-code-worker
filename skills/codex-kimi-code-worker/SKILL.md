---
name: codex-kimi-code-worker
description: "Install and operate the Kimi Code worker workflow for Codex Desktop. Trigger on requests such as '让 Kimi 帮我修这个 bug', '让 Kimi 跑这个任务', '用 Kimi 处理当前项目', 'kimi 修复这个报错', or 'kimi 帮我做这个'. Use when Codex needs to: (1) check or install Kimi Code CLI, (2) complete Kimi login and verify a minimal hello-world call, (3) install or configure `kimi-code-worker-mcp`, (4) update `~/.codex/config.toml` for cross-platform MCP startup, or (5) run coding tasks through the Kimi worker flow with plan, start, short wait, get, and terminal review while minimizing Codex token usage."
---

# Codex Kimi Code Worker

Use this skill to turn Codex into a planner and reviewer for `kimi-code-worker-mcp`.

Simple ways to invoke it:

- 让 Kimi 帮我修这个 bug
- 让 Kimi 跑这个任务
- 用 Kimi 处理当前项目
- kimi 修复这个报错
- kimi 帮我做这个
- `$codex-kimi-code-worker`

Keep the contract fixed:

- Codex plans, narrows scope, defines checks, and performs final acceptance.
- Kimi executes one slice at a time through `kimi-code-worker-mcp`.
- Running status stays compact and factual.
- MCP runs one authoritative host-side `checks` pass at terminal state.
- Codex requests `diff` only when terminal evidence is insufficient.

Do not let the workflow drift into long blocking waits or running-time chatter.

## Core Principles

Apply these principles whenever Codex delegates work to Kimi:

1. Think before coding.
   - Codex must define the current slice, scope, assumptions, and success criteria before starting the worker.
   - If the task has multiple plausible interpretations, prefer `kimi_plan_implementation` instead of silently choosing one.
   - If the task is still ambiguous after local inspection, stop and clarify before dispatching.

2. Simplicity first.
   - Ask Kimi for the minimum change that satisfies the slice.
   - Do not let Kimi add speculative features, abstractions, configurability, or refactors that were not requested.
   - If a 20-line change solves the problem, do not accept a 200-line rewrite.

3. Surgical changes.
   - Every changed file should trace directly to the current slice.
   - Use narrow `allowed_dirs` whenever practical.
   - If Kimi notices unrelated dead code or cleanup opportunities, report them later instead of touching them now.

4. Goal-driven execution.
   - Each slice must have explicit `Success` and `Validation`.
   - Do not dispatch vague tasks such as "make it work" or "clean this up".
   - For fixes, prefer a check that proves the bug is gone. For refactors, prefer checks that prove behavior stayed intact.

5. Codex decides before dispatch, Kimi executes after dispatch.
   - Before dispatch: Codex resolves tradeoffs, defines boundaries, and chooses the slice.
   - After dispatch: Kimi should not broaden scope on its own. If more work remains, it should stop after the current slice.

## Phase 1: Onboarding

Use this phase when Kimi Code CLI or the MCP is not yet ready on the machine.

### 1. Check prerequisites

Check these first:

- Node.js 20+
- `kimi` command
- `kimi-code-worker-mcp` command
- `~/.codex/config.toml`

If `kimi` is missing, install it with the official platform command:

- Windows:

```powershell
irm https://code.kimi.com/install.ps1 | iex
```

- macOS / Linux:

```bash
curl -L code.kimi.com/install.sh | bash
```

### 2. Complete Kimi login and hello-world verification

After installation:

1. Run `kimi login`
2. Wait for the user to complete browser or device authorization
3. Verify the CLI with a real minimal call:

```bash
kimi --print -p "say hi"
```

Treat this as required. Do not proceed to MCP install if Kimi CLI cannot return a real response.

### 3. Install `kimi-code-worker-mcp`

Preferred public install path:

```bash
npm install -g github:chenjuncheng/kimi-code-worker
```

Use the local checkout path only for development or local validation:

- local link:

```bash
npm link
```

- or direct local install:

```bash
npm install -g <local-checkout-path>
```

If `kimi-code-worker-mcp` is already on PATH and `kimi-code-worker-mcp --doctor` passes, skip reinstall.

### 4. Write Codex MCP config

Prefer the official Codex MCP CLI first:

macOS / Linux:

```bash
codex mcp add kimi-code-worker-mcp -- kimi-code-worker-mcp
```

Windows:

```powershell
codex mcp add kimi-code-worker-mcp -- cmd /d /s /c kimi-code-worker-mcp
```

If Windows reports `Access is denied` when running `codex mcp`, do not stop there. Some Codex Desktop installs expose a `WindowsApps` alias that is visible on PATH but not callable from the current shell. In that case, retry with the real Codex binary under `%LOCALAPPDATA%\OpenAI\Codex\bin`:

```powershell
$codexCli = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin\codex.exe"
& $codexCli mcp add kimi-code-worker-mcp -- cmd /d /s /c kimi-code-worker-mcp
& $codexCli mcp
```

After adding it, verify that Codex knows the server:

```bash
codex mcp
```

If the CLI path is unavailable or the user specifically wants direct file edits, write `~/.codex/config.toml` with the correct platform-specific command. Treat this as fallback only. On some Codex Desktop installs the file may later be rewritten by the app, so do not present manual file edits as the primary path.

macOS / Linux:

```toml
[mcp_servers."kimi-code-worker-mcp"]
command = "kimi-code-worker-mcp"
args = []
startup_timeout_sec = 120
```

Windows:

```toml
[mcp_servers."kimi-code-worker-mcp"]
command = "cmd"
args = ["/d", "/s", "/c", "kimi-code-worker-mcp"]
startup_timeout_sec = 120
```

Do not write repo-specific absolute paths when the command shim is available.

### 5. Validate and restart

Run:

```bash
kimi-code-worker-mcp --doctor
```

Also confirm the MCP registration path:

```bash
codex mcp
```

If the plain `codex mcp` alias is not callable on Windows, use the `%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe` fallback shown above and verify there instead.

If `doctor` passes, tell the user:

- Codex Desktop must be restarted to load the new MCP
- the current thread will not auto-reconnect across restart
- after restart, open a new thread and call `$codex-kimi-code-worker` again

## Phase 2: Detect Whether Setup Is Already Done

At the start of a later session:

1. Check whether `kimi-code-worker-mcp` tools are already available.
2. If the MCP is loaded, skip onboarding and go straight to the worker workflow.
3. If the MCP is missing but the command exists, first check `codex mcp` to confirm registration. On Windows, if that alias fails with `Access is denied`, retry with `%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe`. Only after registration is confirmed should you remind the user to restart Codex.
4. If the command is missing or `doctor` fails, return to onboarding.

Do not redo installation if the machine is already healthy.

## Phase 3: Run The Worker Workflow

Use this default flow:

1. `kimi_plan_implementation` for broad, ambiguous, cross-module, or long-running tasks
2. `kimi_start_implementation` for one bounded slice
3. `kimi_wait_for_job` once with `15000-30000ms`
4. `kimi_get_job` for the main polling loop
5. terminal review with `status`, `files_changed`, `policy`, `checks_run`, `failure_reason`
6. request `include_diff: true` only when needed

Keep each slice narrow:

```text
Goal: <single slice goal>
Scope: <allowed files or directories>
Do not touch: <forbidden files or behaviors>
Success: <observable terminal condition>
Validation: <checks>
Strategy: prefer minimal change; do not refactor unrelated code
```

## Running-State Rules

Use running output in this order:

1. `progress.facts`
2. `progress.weak_inference`
3. `progress.next_action`

Do not over-interpret activity.

Do not claim:

- "正在落盘"
- "文档同步中"
- "验证即将通过"
- "没有越权"

unless terminal evidence proves it.

Use short polling:

- one short `kimi_wait_for_job`
- then `kimi_get_job` every `15000-30000ms`

Do not:

- hold a long blocking `wait`
- repeatedly request logs, events, or diff during normal running observation
- steer a running job by default
- launch one giant multi-phase slice

## Best Practices From Known Failure Modes

Apply these rules by default:

- Prefer a short local Python or shell script for large structured outputs.
- For data collection or content-generation tasks, default to:
  - `fetch`
  - `normalize`
  - `document`
- If `suspected_stall=true`, obtain one stronger evidence sample with `include_logs` or `include_events`, then decide.
- If `process_alive=false`, do not keep waiting as if the worker were healthy.
- If `failure_reason=worker_protocol_timeout`, inspect `produced_files` and `useful_outputs_present` before deciding to rerun.
- If `worker_exit_without_terminal_event=true`, trust the MCP's reconciled terminal summary first.
- Prefer cancel and restart over repeated steer commands.

Use `kimi_steer_job` only when the direction is mostly right and one concise correction is enough.

## Review Terminal State

Review in this order:

1. `status`
2. `files_changed`
3. `policy`
4. `checks_run`
5. `failure_reason`
6. `useful_outputs_present`
7. `produced_files`
8. `contract_failed_on`
9. `worker_exit_without_terminal_event`

Only request `include_diff` when:

- logic changed
- scope looks broader than expected
- checks do not fully prove correctness
- the next slice needs exact patch context

## Follow-Up Behavior

If the result is accepted:

- report the changed files
- report checks outcome
- report only real residual risk

If the result is not accepted:

1. state the mismatch or failure
2. cancel only if the worker is still active
3. start a tighter new slice
4. carry forward only the last job id, terminal status, and the minimum diff or check summary needed

Do not carry the full prior conversation into the next slice.

If `kimi-code-worker-mcp` tools are unavailable in the current thread, say that clearly and return to onboarding or restart guidance instead of pretending the worker exists.
