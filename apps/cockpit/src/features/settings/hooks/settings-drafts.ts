import { useCallback, useMemo, useState } from "react";
import {
  NO_SETTING_DRAFTS,
  pendingSettingDrafts,
  type SettingDraftScope,
  type SettingDrafts,
  type SettingItem,
  settingDraftTexts,
  withoutSettingDraft,
  withSettingDraft,
} from "@/features/settings/model/settings-model";

interface SettingsDraftState {
  drafts: SettingDrafts;
  pending: SettingDrafts;
  texts(items: readonly SettingItem[], scope: SettingDraftScope): Record<string, string>;
  setDraft(path: string, text: string, scope: SettingDraftScope): void;
  dropDraft(path: string, scope: SettingDraftScope): void;
  clear(scope?: SettingDraftScope): void;
}

export function useSettingsDrafts(items: readonly SettingItem[]): SettingsDraftState {
  const [drafts, setDrafts] = useState<SettingDrafts>(NO_SETTING_DRAFTS);
  const pending = useMemo(() => pendingSettingDrafts(items, drafts), [items, drafts]);
  const find = useCallback(
    (path: string) => items.find((candidate) => candidate.path === path),
    [items],
  );
  return {
    drafts,
    pending,
    texts: (scoped, scope) => settingDraftTexts(drafts, scoped, scope),
    setDraft: (path, text, scope) =>
      setDrafts((current) => withSettingDraft(current, find(path), path, text, scope)),
    dropDraft: (path, scope) =>
      setDrafts((current) => withoutSettingDraft(current, find(path), path, scope)),
    clear: (scope) =>
      setDrafts((current) => (scope ? { ...current, [scope]: {} } : NO_SETTING_DRAFTS)),
  };
}
