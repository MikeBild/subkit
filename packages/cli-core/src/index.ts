// Shared CLI helpers reused across the `sk` CLI surfaces and any
// packaged compatibility aliases. Extracting these out keeps
// behavior-compatible code in one place without forcing app-local
// modules to import from each other.
//
// Modules live as flat files under `packages/cli-core/src/` and are
// imported via the `@cli-core/*` path alias (see tsconfig.json).

export { osc52Copy, ringBell } from "./clipboard.ts";
export { type DeviceFlowOptions, type DeviceFlowResult, runDeviceFlow } from "./device-flow.ts";
export {
  createEngineClient,
  type paths as EngineApiPaths,
  type EngineClient,
  type EngineClientOptions,
} from "./engine-api/client.ts";
export {
  EngineError,
  exitCodeFor,
  formatError,
  isEngineError,
  isTransportError,
  reportCommandError,
  TransportError,
  wasReported,
} from "./errors.ts";
export {
  type CategoryBlockSummary,
  emitGroupedList,
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
  scrubSecrets,
  scrubString,
  SECRET_PATTERNS,
  type SecretKind,
  type SecretPattern,
  SENSITIVE_KEY_PATTERN,
} from "./scrub-secrets.ts";
export {
  fetchSetupStatus,
  type FetchSetupStatusOptions,
  type SetupOverallStatus,
  type SetupStatusSnapshot,
} from "./setup-banner.ts";
export { readSse, type SseFrame } from "./sse.ts";
export {
  type ActivityState,
  applyTurnEvent,
  type Citation,
  type DataPartState,
  errorFrameToEvents,
  type ExecutionResultRender,
  initialSessionState,
  lastAssistantText,
  lastExecutionResult,
  type MessageState,
  parseRenderableMessageContent,
  type PendingElicitation,
  type RenderableMessagePart,
  renderExecutionOutput,
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
  parseChecksum,
  performUpdate,
  type PerformUpdateResult,
  platformArch,
  pruneRetainedVersions,
  readCache,
  RETAINED_VERSIONS_KEEP,
  type RetainedVersion,
  type RollbackResult,
  rollbackTo,
  type UpdateCache,
  type UpdateInfo,
  type UpdaterConfig,
  verifySignature,
  writeCache,
} from "./updater.ts";
export { VERSION } from "./version.ts";
