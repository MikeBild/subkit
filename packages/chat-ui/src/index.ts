// @chat-ui — shared Ink component library for the subkit CLIs.
//
// Both `apps/sk` and `apps/cli` mount these components and inject a
// `Platform` adapter (clipboard, $EDITOR, native image paste) plus an
// `EngineApi` client. Every interaction pattern (elicit router, slash
// palette, status line, diff, step tree) lives here and ships once.

export {
  ConversationBrowser,
  type ConversationBrowserProps,
  type ConversationItem,
} from "./ConversationBrowser.tsx";
export { StructuredDiff, type StructuredDiffProps } from "./diff/StructuredDiff.tsx";
export { ExitFlow, type ExitFlowProps } from "./ExitFlow.tsx";
export {
  type ChoiceOption,
  ChoicePrompt,
  type ChoicePromptProps,
} from "./elicit/ChoicePrompt.tsx";
export {
  type ConfirmKind,
  ConfirmPrompt,
  type ConfirmPromptProps,
} from "./elicit/ConfirmPrompt.tsx";
export {
  type FormField,
  type FormFieldOption,
  FormPrompt,
  type FormPromptProps,
} from "./elicit/FormPrompt.tsx";
export {
  type MultiChoiceOption,
  MultiChoicePrompt,
  type MultiChoicePromptProps,
} from "./elicit/MultiChoicePrompt.tsx";
export {
  type ElicitationResponse,
  ElicitRouter,
  type ElicitRouterProps,
} from "./elicit/Router.tsx";
export { TextPrompt, type TextPromptProps } from "./elicit/TextPrompt.tsx";
export { HistorySearch, type HistorySearchProps } from "./HistorySearch.tsx";
export {
  KeybindingProvider,
  useActiveContext,
  useKeybinding,
} from "./keybindings/Provider.tsx";
export {
  defaultKeybindings,
  type KeybindingContext,
  type KeybindingKey,
  type KeybindingSpec,
} from "./keybindings/schema.ts";
export { Code, type CodeProps } from "./markdown/Code.tsx";
export { Table, type TableColumn, type TableProps } from "./markdown/Table.tsx";
export { Pane, type PaneProps } from "./Pane.tsx";
export type { Platform, PlatformImage } from "./platform.ts";
export {
  FilePreview,
  type FilePreviewLine,
  type FilePreviewProps,
} from "./preview/FilePreview.tsx";
export { ScrollView, type ScrollViewProps } from "./ScrollView.tsx";
export {
  type SlashCommand,
  SlashPalette,
  type SlashPaletteProps,
} from "./SlashPalette.tsx";
export {
  type Mode,
  StatusLine,
  type StatusLineContext,
  type StatusLineProps,
} from "./StatusLine.tsx";
export { StatusPane, type StatusPaneProps, type StatusPaneRow } from "./StatusPane.tsx";
export {
  type StepNode,
  type StepStatus,
  StepTree,
  type StepTreeProps,
} from "./spinner/StepTree.tsx";
export { ThemeProvider, useTheme } from "./theme/Provider.tsx";
export { defaultTheme, type ThemeTokens } from "./theme/tokens.ts";
