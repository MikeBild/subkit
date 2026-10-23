import { apiRequest } from "@/api/client";
import { type SettingsPatch, settingsActivationPath } from "@/pages/settings-model";

export const SETTINGS_ENDPOINT = "/v1/settings";

export async function applySettingsPatches(patches: readonly SettingsPatch[]): Promise<void> {
  let saved: Parameters<typeof settingsActivationPath>[0] | null = null;
  for (const patch of patches) {
    const body: SettingsPatch = saved
      ? { ...patch, expected_revision: saved.saved_revision }
      : patch;
    saved = await apiRequest<Parameters<typeof settingsActivationPath>[0]>(SETTINGS_ENDPOINT, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }
  if (saved) await apiRequest(settingsActivationPath(saved), { method: "POST" });
}

export function workspaceSettingEndpoint(path: string, tenantId: string): string {
  return `${SETTINGS_ENDPOINT}/${encodeURIComponent(path)}?tenant=${encodeURIComponent(tenantId)}`;
}

export async function saveWorkspaceSetting(
  path: string,
  tenantId: string,
  value: unknown,
): Promise<void> {
  await apiRequest(workspaceSettingEndpoint(path, tenantId), {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}
