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
export { osc52Copy, ringBell } from "./clipboard.ts";
export {
  type DeviceFlowOptions,
  type DeviceFlowResult,
  runDeviceFlow,
} from "./device-flow.ts";
export {
  createEngineClient,
  type EngineClient,
  type EngineClientOptions,
  type paths as EngineApiPaths,
} from "./engine-api/client.ts";
export {
  type InterruptController,
  type InterruptPhase,
  makeInterruptController,
} from "./interrupt.ts";
export { readSse, type SseFrame } from "./sse.ts";
export {
  applyTurnEvent,
  type DataPartState,
  initialSessionState,
  lastAssistantText,
  type MessageState,
  type PendingElicitation,
  type SkSessionState,
  type ToolCallState,
  type ToolLogEntry,
  type ToolStatus,
  type TurnEvent,
  type TurnUsage,
} from "./turn-event.ts";
export { notifyIfUpdateAvailable } from "./update-notifier.ts";
export {
  checkForUpdate,
  cleanupOldBinary,
  defaultUpdaterConfig,
  formatUpdateBanner,
  GITHUB_REPO,
  isNewer,
  parseChecksum,
  performUpdate,
  platformArch,
  readCache,
  type UpdateCache,
  type UpdateInfo,
  type UpdaterConfig,
  writeCache,
} from "./updater.ts";
export { VERSION } from "./version.ts";
