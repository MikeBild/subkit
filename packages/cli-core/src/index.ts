// Shared CLI helpers reused across `apps/cli` (the operator CLI) and
// `apps/sk` (the end-user CLI). Extracting these out keeps the two
// binaries behavior-compatible — a bug fix in one place lands in
// both — without forcing either to import from the other app.
//
// Modules live as flat files under `packages/cli-core/src/` and are
// imported via the `@cli-core/*` path alias (see tsconfig.json).

export {
  type BrowserLoginOptions,
  type BrowserLoginResult,
  runBrowserLogin,
} from "./browser-login.ts";
export {
  type DeviceFlowOptions,
  type DeviceFlowResult,
  runDeviceFlow,
} from "./device-flow.ts";
export { readSse, type SseFrame } from "./sse.ts";
export {
  applyTurnEvent,
  initialSessionState,
  lastAssistantText,
  type MessageState,
  type PendingApproval,
  type SkSessionState,
  type ToolCallState,
  type ToolStatus,
  type TurnEvent,
  type TurnUsage,
} from "./turn-event.ts";
