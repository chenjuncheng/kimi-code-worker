import { resolve } from "node:path";
import { KimiWireBackend, getKimiInfo, probeKimiPrint } from "../src/kimi-wire-backend.mjs";

const kimi_bin = resolve("scripts/mock-kimi-wire.mjs");
const info = await getKimiInfo(kimi_bin);
const probe = await probeKimiPrint(kimi_bin);

const events = [];
const requests = [];
const backend = new KimiWireBackend({
  cwd: process.cwd(),
  kimi_bin,
  onEvent(event) {
    events.push(event);
  },
  onRequest(event) {
    requests.push(event);
  },
});

await backend.start();
const planMode = await backend.setPlanMode(true);
const planPrompt = await backend.prompt("PLAN ONLY");
await backend.setPlanMode(false);

const steeringBackend = new KimiWireBackend({
  cwd: process.cwd(),
  kimi_bin,
  onEvent(event) {
    events.push(event);
  },
  onRequest(event) {
    requests.push(event);
  },
});
await steeringBackend.start();
const longPrompt = steeringBackend.prompt("LONG_RUNNING NEEDS_APPROVAL");
await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
const steered = await steeringBackend.steer("correct the approach");
await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
const cancelled = await steeringBackend.cancel();
const terminal = await longPrompt;
await backend.close();
await steeringBackend.close();

const checks = {
  info_parsed: info.version === "1.44.0" && info.wire_protocol_version === "1.10",
  print_probe_ok: probe.ok === true,
  permission_profile_inherited: backend.permission_profile?.mode === "full_access",
  plan_mode_accepted: planMode.plan_mode === true,
  prompt_finished: planPrompt.status === "finished",
  plan_event_seen: events.some((event) => event.type === "PlanDisplay"),
  approval_request_seen: requests.some((request) => request.type === "ApprovalRequest"),
  steer_acknowledged: steered.status === "steered",
  cancel_acknowledged: Object.keys(cancelled).length === 0,
  cancel_terminal_status: terminal.status === "cancelled",
};

process.stdout.write(`${JSON.stringify({ ok: Object.values(checks).every(Boolean), checks }, null, 2)}\n`);
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
