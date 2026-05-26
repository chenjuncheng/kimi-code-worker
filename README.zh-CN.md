# Kimi Code Worker MCP

语言：[English](README.md) | [简体中文](README.zh-CN.md)

给 Codex Desktop 用的 MCP 服务，负责把代码工作委派给 **Kimi Code CLI 的 Wire 模式**。

这套工作流故意做得很窄：

- Codex 压缩任务，切出当前 slice，定义最终检查。
- Kimi Code 只执行一个 slice。
- MCP 只回轻量运行态。
- 终态只由 MCP 跑一次权威 `checks`。
- Codex 只在终态看摘要，必要时再拉 `diff`。

这套流程的目标是尽量减少 Codex 主线程 token 消耗，不是做运行中对话式引导。

## 它做什么

- 通过 Kimi Code CLI 的 `--wire` 模式运行 worker
- 暴露 6 个 worker 工具：
  - `kimi_plan_implementation`
  - `kimi_start_implementation`
  - `kimi_get_job`
  - `kimi_wait_for_job`
  - `kimi_steer_job`
  - `kimi_cancel_job`
- 支持显式计划模式，并用 `PlanDisplay` 生成可审阅的计划摘要
- 运行中状态输出保持紧凑、只说事实
- 终态时由主机侧只跑一次 `checks`
- 自动继承当前 Codex 线程权限，读取来源是 `~/.codex/.codex-global-state.json`
- 提供 `setup` / `doctor` 方便安装和检查环境

## 依赖

- Node.js 20+
- 已安装并登录的 Kimi Code CLI
- Codex Desktop 环境里存在 `~/.codex/.codex-global-state.json`

Windows 安装 Kimi Code CLI：

```powershell
irm https://code.kimi.com/install.ps1 | iex
kimi login
```

macOS / Linux：

```bash
curl -L code.kimi.com/install.sh | bash
kimi login
```

## 快速开始

在本仓库里执行：

```bash
npm install
npm run mcp:setup
npm run mcp:doctor
```

开发阶段可以先把本地 checkout 链接成命令：

```bash
npm link
kimi-code-worker-mcp --doctor
```

发布到 npm 后，用户可以直接全局安装：

```bash
npm install -g kimi-code-worker
kimi-code-worker-mcp --doctor
```

macOS / Linux 的 Codex Desktop MCP 配置，写入 `~/.codex/config.toml`：

```toml
[mcp_servers."kimi-code-worker-mcp"]
command = "kimi-code-worker-mcp"
args = []
```

Windows 上建议通过 `cmd` 启动 npm 生成的命令 shim：

```toml
[mcp_servers."kimi-code-worker-mcp"]
command = "cmd"
args = ["/d", "/s", "/c", "kimi-code-worker-mcp"]
startup_timeout_sec = 120
```

本地开发如果不使用 `npm link`，也可以直接用 `node src/kimi-code-worker-mcp.mjs` 或 `npm run mcp:start`。

## 仓库内 Skill

本仓库还内置了一个 Codex skill，路径是：

```text
skills/codex-kimi-code-worker
```

仓库公开后，可以按 GitHub repo path 安装：

```bash
python ~/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py --repo chenjuncheng/kimi-code-worker --path skills/codex-kimi-code-worker
```

安装完 skill 后，重启 Codex 才会加载新的 skill。

这个 skill 固化两类能力：

- Kimi Code CLI 和 `kimi-code-worker-mcp` 的安装与体检
- `plan -> start -> short wait -> get -> terminal review` 的 worker 工作流指引

skill 内固化的工作原则：

- 先定当前 slice，再派工
- 最小改动优先，不做顺手重构
- 每个 slice 都要有明确 `Success` 和 `Validation`
- 运行中只看事实、弱推断、下一步动作
- 终态先看 `failure_reason / useful_outputs_present / produced_files`

常用触发说法：

- `让 Kimi 帮我修这个 bug`
- `让 Kimi 跑这个任务`
- `用 Kimi 处理当前项目`
- `kimi 修复这个报错`
- `kimi 帮我做这个`
- 或直接写 `$codex-kimi-code-worker`

Codex 重启后，当前线程不会自动恢复之前的 MCP 连接。正确做法是新开一个会话，再次调用 `$codex-kimi-code-worker`。

## 权限继承

启动时，MCP 会读取 `CODEX_THREAD_ID`，然后去 `~/.codex/.codex-global-state.json` 查当前线程的权限策略。

当前线程策略会被归一化成以下之一：

- `full-access`
- `auto-review`
- `request-consent`

然后 worker 按这个策略调整 Kimi Code 行为：

- `full-access`：自动批准工具调用，并启用类似 AFK 的自动执行
- `auto-review`：继续自动运行，但对请求按继承策略做判断
- `request-consent`：遇到高权限请求时直接拒绝，不会静默提权

这是自动继承，不需要额外配置。

## 计划模式

`kimi_plan_implementation` 会把 Kimi Code 切进 plan mode，让它通过 Wire 提交一份 markdown 计划，然后返回紧凑的计划摘要：

- `plan_summary`
- `current_slice`
- `risks`
- `next_action`
- `plan_path`

plan mode 在临时沙箱里运行。如果计划过程改动了沙箱或原工作区，MCP 会拒绝这个计划结果。

## 推荐用法

任务分流建议：

- 小修复：直接 `kimi_start_implementation`，把 `allowed_dirs` 和 `checks` 写窄。
- 跨模块或需求模糊：先 `kimi_plan_implementation`，只确认 `current_slice`，再启动执行。
- 长任务：拆成多个 slice。运行中只做短轮询，不反复拉 logs/events。
- 明显偏航：优先取消重开；只有方向基本正确但需要一句修正时才用 `kimi_steer_job`。
- 失败结果：以 `failure_reason` 为准，常见值包括 `checks_failed`、`changed_outside_allowed_scope`、`worker_failed`、`worker_max_steps_reached`。

启动 worker：

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

读取紧凑状态：

```json
{
  "name": "kimi_get_job",
  "arguments": {
    "job_id": "kcw_..."
  }
}
```

稳定轮询建议：

1. 先调用 `kimi_start_implementation`。
2. 再用一次 `kimi_wait_for_job`，窗口控制在 `15000-30000ms`。
3. 如果仍然是 running，就切到 `kimi_get_job`，每 `15000-30000ms` 查一次。
4. 只有怀疑卡住时，才用 `kimi_get_job` 打开 `include_logs` 或 `include_events` 取一次强证据。

## Windows 下的 checks

Windows 上的 `checks` 尽量写成 PowerShell 兼容命令：

```json
{
  "checks": [
    "Get-Content -LiteralPath hello.txt",
    "npm test"
  ]
}
```

## 大仓库与长任务

MCP 会对 workspace snapshot 和 plan sandbox 设置预算，避免大仓库把 Codex 主线程拖进长时间等待。

可调环境变量：

- `KIMI_CODE_WORKER_MAX_SNAPSHOT_FILES`
- `KIMI_CODE_WORKER_MAX_SNAPSHOT_CONTENT_BYTES`
- `KIMI_CODE_WORKER_MAX_PLAN_SANDBOX_FILES`
- `KIMI_CODE_WORKER_MAX_PLAN_SANDBOX_BYTES`

如果 snapshot 达到预算，运行态会在 `progress.facts` 里说明。终态结果会带 `workspace_snapshot` 摘要，方便判断这次结果是否需要更窄的 `allowed_dirs` 重新跑。

## Smoke

```bash
npm run mcp:smoke:wire
npm run mcp:smoke:workflow
npm run mcp:smoke:edge
```

## 状态

这是 beta 仓库。适合内部流程先用 smoke 和真实小任务反复校验，再逐步放大使用范围。
