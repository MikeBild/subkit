import { apiRequest } from "@/api/client";
import {
  type SettingsPatch,
  type SettingsResponse,
  settingsActivationPath,
} from "@/pages/settings-model";

export const SETTINGS_ENDPOINT = "/v1/settings";

export async function applySettingsPatch(patch: SettingsPatch): Promise<void> {
  const saved = await apiRequest<Parameters<typeof settingsActivationPath>[0]>(SETTINGS_ENDPOINT, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  await apiRequest(settingsActivationPath(saved), { method: "POST" });
}

export async function saveSettingChanges(changes: Record<string, unknown>): Promise<void> {
  const current = await apiRequest<Pick<SettingsResponse, "saved_revision">>(SETTINGS_ENDPOINT);
  if (current.saved_revision === null) throw new Error("settings have no saved revision");
  await applySettingsPatch({
    expected_revision: current.saved_revision,
    changes,
    scope: "global",
  });
}
