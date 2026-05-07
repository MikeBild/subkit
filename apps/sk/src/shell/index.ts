// Public barrel for the new sk shell + domain components.
//
// Existing call sites (ink-app.tsx, ink-repl.ts, the readline REPL,
// onboarding wizard, settings UI) opt into the overhaul by importing
// from this barrel. The legacy modules continue to work; nothing
// imports from the new tree until a consumer flips the import.
//
// Treat this barrel as the contract. Re-exports here are stable;
// internal re-organization stays behind it.

export type { ThemeName, ThemeTokens } from "@chat-ui/index.ts";
// Theme re-exports for callers that don't import directly from chat-ui.
export {
  defaultTheme,
  PALETTES,
  paletteFor,
  shouldForceNoColor,
  ThemeProvider,
  useTheme,
  useThemeControl,
} from "@chat-ui/index.ts";
export type {
  ConnectorTemplate,
  IntegrationPickerProps,
} from "../domain/connectors/IntegrationPicker.tsx";
// Domain surfaces.
export { IntegrationPicker } from "../domain/connectors/IntegrationPicker.tsx";
export type { OAuthPollResponse, OAuthWaitViewProps } from "../domain/connectors/OAuthWaitView.tsx";
export { OAuthWaitView } from "../domain/connectors/OAuthWaitView.tsx";
export type { SecretFieldProps } from "../domain/connectors/SecretField.tsx";
export { SecretField } from "../domain/connectors/SecretField.tsx";
export type {
  SchemaFormError,
  SchemaFormMode,
  SchemaFormProps,
} from "../domain/schema/SchemaForm.tsx";
export { SchemaForm } from "../domain/schema/SchemaForm.tsx";
export type { TurnEvent, TurnEventKind } from "../domain/sessions/store.ts";
// Sessions + status-line.
export {
  appendEvent,
  deleteEvents,
  loadEvents,
  sessionEventsPath,
  sessionsDir,
} from "../domain/sessions/store.ts";
export type {
  DiffApproverProps,
  DiffHunk,
  DiffHunkLine,
} from "../domain/workflows/DiffApprover.tsx";
export { DiffApprover } from "../domain/workflows/DiffApprover.tsx";
export type { RunSummary, RunsFilter, RunsTableProps } from "../domain/workflows/RunsTable.tsx";
export { RunsTable } from "../domain/workflows/RunsTable.tsx";
export type {
  StepCarouselProps,
  StepCarouselTab,
  StepStatus,
  WorkflowRunSnapshot,
  WorkflowStepSnapshot,
} from "../domain/workflows/StepCarousel.tsx";
export { StepCarousel } from "../domain/workflows/StepCarousel.tsx";
export type { BootstrapOptions, SkBootstrapSnapshot } from "../lib/bootstrap.ts";
export { bootstrapCachePath, loadBootstrap } from "../lib/bootstrap.ts";
export type { SlashDispatchPlan, SlashRouting } from "../repl/slash/dispatcher.ts";
export { classifySlash } from "../repl/slash/dispatcher.ts";
export type { SlashSpan } from "../repl/slash/findPositions.ts";
// Slash + bootstrap.
export {
  findSlashCommandPositions,
  spanAtCursor,
} from "../repl/slash/findPositions.ts";
export { hasCommand, resolveSlashCommand } from "../repl/slash/hasCommand.ts";
export type { SlashSuggestProps } from "../repl/slash/SlashSuggest.tsx";
export { SlashSuggest } from "../repl/slash/SlashSuggest.tsx";
export type { ShellHookOptions, ShellHookResult } from "../repl/status-line/shell-hook.ts";
export { runShellHook } from "../repl/status-line/shell-hook.ts";
export type { UseStatusLineResult } from "../repl/status-line/useStatusLine.ts";
export { useStatusLine } from "../repl/status-line/useStatusLine.ts";
export type { SettingsDraftSnapshot } from "../settings-ui/lib/draft-store.ts";
// Settings draft store.
export { clearDraft, loadDraft, saveDraft } from "../settings-ui/lib/draft-store.ts";
export type {
  AuthPayload,
  EnginePayload,
  ErrorPanelKind,
  GenericPayload,
  NetworkPayload,
  RateLimitPayload,
  ValidationPayload,
} from "./ErrorPanel.tsx";
export { ErrorPanel, errorToPanel } from "./ErrorPanel.tsx";
export type { GutterTone, MessageGutterProps } from "./MessageGutter.tsx";
export { MessageGutter } from "./MessageGutter.tsx";
export type { ResizeBoundaryProps } from "./ResizeBoundary.tsx";
export { ResizeBoundary } from "./ResizeBoundary.tsx";
export type { Toast, ToastInput, ToastLevel, ToastQueueAPI } from "./ToastQueue.tsx";
// Core primitives.
export { ToastQueue, useToast } from "./ToastQueue.tsx";
export type { VirtualTranscriptProps } from "./VirtualTranscript.tsx";
export { VirtualTranscript } from "./VirtualTranscript.tsx";
