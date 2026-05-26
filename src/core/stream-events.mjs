export function wireType(message) {
  if (!message || typeof message !== "object") return "Unknown";
  if (typeof message.type === "string") return message.type;
  if (typeof message.event === "string") return message.event;
  return "Unknown";
}

export function wirePayload(message) {
  if (!message || typeof message !== "object") return {};
  if (message.payload && typeof message.payload === "object") return message.payload;
  return {};
}

export function innerWireMessage(message) {
  const payload = wirePayload(message);
  if (payload.event && typeof payload.event === "object") return payload.event;
  return null;
}

export function summarizeWireEvent(message) {
  const type = wireType(message);
  const payload = wirePayload(message);
  switch (type) {
    case "TurnBegin":
      return "turn_begin";
    case "TurnEnd":
      return "turn_end";
    case "StepBegin":
      return payload.n != null ? `step_begin:${payload.n}` : "step_begin";
    case "StepRetry":
      return "step_retry";
    case "StatusUpdate":
      return payload.plan_mode == null ? "status_update" : `status_update:plan_mode=${payload.plan_mode}`;
    case "TextPart":
      return "assistant_text";
    case "ThinkPart":
      return "assistant_thinking";
    case "ContentPart":
      if (payload.type === "text") return "assistant_text";
      if (payload.type === "think") return "assistant_thinking";
      return `content_part:${payload.type ?? "unknown"}`;
    case "PlanDisplay":
      return "plan_display";
    case "SteerInput":
      return "steer_input";
    case "HookTriggered":
      return payload.event ? `hook_triggered:${payload.event}` : "hook_triggered";
    case "HookResolved":
      return payload.event ? `hook_resolved:${payload.event}` : "hook_resolved";
    case "ToolCall":
      return payload.function?.name ? `tool_call:${payload.function.name}` : "tool_call";
    case "ToolCallPart":
      return "tool_call_part";
    case "ToolResult":
      return payload.tool_call_id ? `tool_result:${payload.tool_call_id}` : "tool_result";
    case "SubagentEvent":
      return payload.subagent_type
        ? `subagent_event:${payload.subagent_type}:${summarizeWireEvent(payload.event)}`
        : `subagent_event:${summarizeWireEvent(payload.event)}`;
    case "Notification":
      return payload.type ? `notification:${payload.type}` : "notification";
    case "MCPLoadingBegin":
      return "mcp_loading_begin";
    case "MCPLoadingEnd":
      return "mcp_loading_end";
    default:
      return type.toLowerCase();
  }
}

export function stageFromWireEvent(message) {
  const type = wireType(message);
  if (type === "SubagentEvent") return stageFromWireEvent(innerWireMessage(message));
  switch (type) {
    case "PlanDisplay":
      return { stage: "planning", message: "Kimi emitted a plan display." };
    case "TextPart":
    case "ThinkPart":
    case "ContentPart":
    case "TurnBegin":
    case "StepBegin":
      return { stage: "implementing", message: `Kimi emitted ${summarizeWireEvent(message)}.` };
    case "ToolCall":
    case "ToolCallPart":
    case "ToolResult":
      return { stage: "tooling", message: `Kimi emitted ${summarizeWireEvent(message)}.` };
    case "StatusUpdate":
      return { stage: "implementing", message: "Kimi reported a status update." };
    case "SteerInput":
      return { stage: "implementing", message: "Kimi accepted a steer message." };
    case "HookTriggered":
    case "HookResolved":
      return { stage: "tooling", message: `Kimi emitted ${summarizeWireEvent(message)}.` };
    default:
      return null;
  }
}

export function extractTextDelta(message) {
  const type = wireType(message);
  if (type === "SubagentEvent") return extractTextDelta(innerWireMessage(message));
  const payload = wirePayload(message);
  if (type === "TextPart") return typeof payload.text === "string" ? payload.text : "";
  if (type === "ContentPart" && payload.type === "text") {
    return typeof payload.text === "string" ? payload.text : "";
  }
  return "";
}

export function extractPlanDisplay(message) {
  if (wireType(message) === "SubagentEvent") return extractPlanDisplay(innerWireMessage(message));
  if (wireType(message) !== "PlanDisplay") return null;
  const payload = wirePayload(message);
  return {
    content: typeof payload.content === "string" ? payload.content : "",
    file_path: typeof payload.file_path === "string" ? payload.file_path : "",
  };
}

export function extractStatusUpdate(message) {
  if (wireType(message) === "SubagentEvent") return extractStatusUpdate(innerWireMessage(message));
  if (wireType(message) !== "StatusUpdate") return null;
  const payload = wirePayload(message);
  return {
    context_usage: typeof payload.context_usage === "number" ? payload.context_usage : null,
    context_tokens: typeof payload.context_tokens === "number" ? payload.context_tokens : null,
    max_context_tokens: typeof payload.max_context_tokens === "number" ? payload.max_context_tokens : null,
    token_usage: payload.token_usage ?? null,
    message_id: typeof payload.message_id === "string" ? payload.message_id : null,
    plan_mode: typeof payload.plan_mode === "boolean" ? payload.plan_mode : null,
    mcp_status: payload.mcp_status ?? null,
  };
}
