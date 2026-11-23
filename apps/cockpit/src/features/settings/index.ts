export {
  isStillRestarting,
  RESTART_CONFIRM_TIMEOUT_MS,
  RESTART_POLL_MS,
  type RestartAccepted,
  type RestartOffer,
  type RestartStatus,
  restartOffer,
  restartOfferAfterSave,
  restartRefusalKey,
  restartSaveNote,
  restartSignsEveryoneOut,
  restartVerdict,
} from "@/features/settings/api/settings-restart-model";
export {
  applySettingsPatch,
  settingsReadQuery,
  settleSettings,
} from "@/features/settings/api/settings-save";
export { useSettingsDrafts } from "@/features/settings/hooks/settings-drafts";
export { ApprovalPolicyPanel, ApprovalPolicyRow } from "./approval-policy";
export {
  nextPolicy,
  POLICY_PERMISSION,
  type PolicyView,
  policyErrorRows,
  policyView,
} from "./approval-policy-model";
export {
  type DesktopSettingsControl,
  LaunchAtLoginRow,
  PrivacyPanel,
  UpdatesPanel,
  useDesktopSettings,
} from "./desktop-settings";
export {
  type DesktopSettings,
  type DesktopSettingsBridge,
  type DesktopSettingsPatch,
  type DesktopUpdate,
  desktopSettingsBridge,
  desktopSettingsBridgeOf,
  parseDesktopSettings,
} from "./desktop-settings-model";
export {
  AI_ACCESS_REFUSAL_KEY,
  aiAccessRefusal,
  OWN_KEY_PROVIDER_COPY,
  OWN_KEY_PROVIDERS,
  type OwnKeyProvider,
  PROVIDER_KEY_PAGES,
  PROVIDER_MARK,
} from "./model/ai-providers";
export {
  CHANNEL_PLATFORMS,
  CURRENT_TARGET,
  channelTargetLabel,
  type DeliveryState,
  deliveryState,
  EVENT_KEYS,
  eventPatternLabels,
  INBOX_CHOICE,
  platformLabel,
  type RuleDraft,
  ruleDraftOf,
  ruleEditBody,
  ruleNameLabel,
  rulesUsing,
  ruleTarget,
  ruleTargetFields,
  SEVERITIES,
  type Severity,
  workflowPatternLabel,
} from "./model/notification-rules-model";
export {
  areaStatus,
  cockpitSettings,
  connectedChatPlatforms,
  ENGINE_AREA_IDS,
  type EngineAreaId,
  engineSettingsAccess,
  isPersonalArea,
  openSettingsLevel,
  ownObjectStore,
  pageScope,
  providerKeyPath,
  type ScopedArea,
  type SettingAreaId,
  type SettingNavGroup,
  type SettingsLevel,
  scopedAreaOf,
  settingAreaOf,
  settingNavigation,
  settingsGuidedErrors,
  settingsLevelFromUrl,
  shownInCockpit,
  visibleSettingAreas,
  workspaceAiEditable,
} from "./model/settings-areas";
export {
  catalogModelName,
  type ModelCatalog,
  type ModelCatalogEntry,
  modelCatalogQueryKey,
  modelsFor,
  recommendedModel,
} from "./model/settings-catalog";
export {
  canRevokeDevice,
  type DeviceRow,
  deviceRevocation,
  deviceRows,
} from "./model/settings-devices-model";
export {
  CAPABILITY_LABEL,
  countsLine,
  deviceScope,
  type LocalDeviceRow,
  localDeviceRows,
} from "./model/settings-local-devices-model";
export {
  changedSettings,
  isUnset,
  NO_SETTING_DRAFTS,
  nextSettingsSave,
  type SettingDraftScope,
  type SettingItem,
  type SettingsAttention,
  type SettingsFilter,
  type SettingsResponse,
  settingAppliesToShown,
  settingDiffersFromDefault,
  settingDraftError,
  settingFieldValue,
  settingHelpKey,
  settingIsChanged,
  settingLabel,
  settingLeafTarget,
  settingMetaLabel,
  settingResetDraft,
  settingSecretCover,
  settingSecretName,
  settingSecretStored,
  settingSectionLabel,
  settingSectionOf,
  settingSourceIsNotable,
  settingsAttention,
  settingsPatches,
  settingsSaveFailure,
  settingsSaveReason,
  settingsViewFromUrl,
  settingUnit,
  settingValueText,
} from "./model/settings-model";
export {
  ACTION_LABEL,
  actionTone,
  CATEGORY_SEARCH_THRESHOLD,
  canApplyPlan,
  canSubmitImport,
  exportCategoryOptions,
  failedItems,
  filterExportCategories,
  installSource,
  KIND_LABEL,
  KINDS_LABEL,
  nextSteps,
  type PackageExportPrefill,
  packageCategories,
  packageMenuItems,
  packagePermissions,
  planFromConflict,
  planHint,
  REQUIREMENT_LABEL,
  requirementCounts,
  sortedPlanItems,
  summaryEntries,
} from "./model/settings-packages-model";
export {
  type AiAccessView,
  aiAccessView,
  type PersonalDrafts,
  PersonalSaveError,
  personalChanges,
  personalRefusal,
  profileStatus,
  workspaceAiStatus,
} from "./model/settings-personal";
export { Notifications, NotificationsPanel } from "./notifications";
export {
  type ApproverState,
  approvalsTo,
  type NotificationChange,
  type NotificationView,
  notificationChange,
  notificationView,
  quietNow,
  type TerminalQuiet,
  terminalQuietError,
} from "./notifications-model";
export {
  PAUSE_OPTION_KEYS,
  PAUSE_OPTIONS,
  type PauseOption,
  pauseLabel,
  pauseRequest,
  tomorrowAt,
} from "./pause-model";
export { PauseRow } from "./pause-row";
export { SetupSection, SetupSectionPanel } from "./setup-section";
export { StartLayoutRows } from "./start-layout-rows";
export type { BrandingDraftHandle } from "./ui/branding";
export { BrandingAppearance, BrandingAttribution, BrandingWordmark } from "./ui/branding-mark";
export { NotificationSettings, useNotificationActions } from "./ui/notification-settings";
export { PackageExportDialog, PackageImportDialog, usePackageActions } from "./ui/package-dialogs";
export { AiArea } from "./ui/settings-ai";
export { AreaList } from "./ui/settings-area-list";
export { DevicesArea } from "./ui/settings-devices";
export { SettingsAreaFrame, UsageNote } from "./ui/settings-frame";
export type { GuidedContext } from "./ui/settings-guided";
export { HelpArea } from "./ui/settings-help";
export { LocalDevicesQuestion } from "./ui/settings-local-devices";
export { PackagesSettings } from "./ui/settings-packages";
export { ProfileArea } from "./ui/settings-profile";
export {
  RESTART_STATUS_QUERY_KEY,
  SettingsRestartDialog,
  SettingsRestartOffer,
  useRestartOffer,
} from "./ui/settings-restart";
export {
  SettingField,
  SettingsAttentionLine,
  SettingsReadOnlyNotice,
  SettingsSaveBar,
  SettingsSection,
  SettingsSectionNav,
  SettingsSummary,
} from "./ui/settings-rows";
export { RulesArea } from "./ui/settings-rules";
export { WorkspaceArea } from "./ui/settings-workspace";
export { WorkspaceAiArea } from "./ui/settings-workspace-ai";
export { WorkspaceRecovery } from "./ui/workspace-recovery";
export { WorkspaceSwitcher } from "./ui/workspace-switcher";
export { type PauseControl, usePauseControl } from "./use-notification-pause";
export { useSaveNotes } from "./use-save-notes";
