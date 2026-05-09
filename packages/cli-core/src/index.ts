// Shared CLI helpers reused across the `sk` CLI surfaces and any
// packaged compatibility aliases. Extracting these out keeps
// behavior-compatible code in one place without forcing app-local
// modules to import from each other.
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
  EngineError,
  type EngineErrorBody,
  exitCodeFor,
  formatError,
  TransportError,
} from "./errors.ts";
export {
  emitList,
  emitOne,
  printJson,
  printKeyValue,
  printTable,
  renderTable,
  toJson,
} from "./format.ts";
export {
  type InterruptController,
  type InterruptPhase,
  makeInterruptController,
} from "./interrupt.ts";
export { redact } from "./redact.ts";
export {
  SECRET_PATTERNS,
  SENSITIVE_KEY_PATTERN,
  type SecretKind,
  type SecretPattern,
  scrubSecrets,
  scrubString,
} from "./scrub-secrets.ts";
export {
  type FetchSetupStatusOptions,
  fetchSetupStatus,
  type SetupOverallStatus,
  type SetupStatusSnapshot,
} from "./setup-banner.ts";
export { readSse, type SseFrame } from "./sse.ts";
export {
  type ActivityState,
  applyTurnEvent,
  type DataPartState,
  initialSessionState,
  lastAssistantText,
  type MessageState,
  type PendingElicitation,
  parseRenderableMessageContent,
  type RenderableMessagePart,
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
  listRetainedVersions,
  type PerformUpdateResult,
  parseChecksum,
  performUpdate,
  platformArch,
  pruneRetainedVersions,
  RETAINED_VERSIONS_KEEP,
  type RetainedVersion,
  type RollbackResult,
  readCache,
  rollbackTo,
  type UpdateCache,
  type UpdateInfo,
  type UpdaterConfig,
  verifySignature,
  writeCache,
} from "./updater.ts";
export { VERSION } from "./version.ts";
