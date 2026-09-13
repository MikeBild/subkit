// @chat-ui — shared Ink component library for the `sk` CLI surfaces.
//
// Interactive conversation views and admin panes in `apps/sk` mount
// these components and inject a `Platform` adapter (clipboard, $EDITOR,
// native image paste) plus an `EngineApi` client. Every interaction
// pattern (elicit router, slash palette, status line, diff, step tree)
// lives here and ships once.

export {
  type AssistantTurnRef,
  ConversationBrowser,
  type ConversationBrowserProps,
  type ConversationItem,
} from "./ConversationBrowser.tsx";
export { StructuredDiff, type StructuredDiffProps } from "./diff/StructuredDiff.tsx";
export { type ChoiceOption, ChoicePrompt, type ChoicePromptProps } from "./elicit/ChoicePrompt.tsx";
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
  PartialApprovalPrompt,
  type PartialApprovalPromptProps,
  type PartialDiffEntry,
} from "./elicit/PartialApprovalPrompt.tsx";
export {
  type ElicitationResponse,
  ElicitRouter,
  type ElicitRouterProps,
} from "./elicit/Router.tsx";
export { TextPrompt, type TextPromptProps } from "./elicit/TextPrompt.tsx";
export { ExitFlow, type ExitFlowProps } from "./ExitFlow.tsx";
export { HistorySearch, type HistorySearchProps } from "./HistorySearch.tsx";
export {
  hyperlink,
  renderTextWithLinks,
  resetHyperlinkSupportCacheForTests,
  terminalSupportsHyperlinks,
} from "./hyperlink.ts";
export { Code, type CodeProps } from "./markdown/Code.tsx";
export { Table, type TableColumn, type TableProps } from "./markdown/Table.tsx";
export { Pane, type PaneProps } from "./Pane.tsx";
export type { Platform, PlatformImage } from "./platform.ts";
export { ScrollView, type ScrollViewProps } from "./ScrollView.tsx";
export { StatusPane, type StatusPaneProps, type StatusPaneRow } from "./StatusPane.tsx";
export { ThemeProvider, useTheme, useThemeControl } from "./theme/Provider.tsx";
export {
  defaultTheme,
  paletteFor,
  PALETTES,
  shouldForceNoColor,
  type ThemeName,
  type ThemeTokens,
} from "./theme/tokens.ts";
