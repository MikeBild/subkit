import { apiRequest } from "@/api/client";
import {
  type SettingsPatch,
  type SettingsResponse,
  sameSettingValue,
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

export function settingsPatchEndpoint(patch: SettingsPatch): string {
  return patch.scope === "tenant"
    ? `${SETTINGS_ENDPOINT}?tenant=${encodeURIComponent(patch.tenant_id)}`
    : SETTINGS_ENDPOINT;
}

export function settingsReflect(
  data: Pick<SettingsResponse, "items">,
  changes: Readonly<Record<string, unknown>>,
): boolean {
  return Object.entries(changes).every(([path, value]) => {
    const item = data.items.find((candidate) => candidate.path === path);
    if (!item || item.meta.sensitive || item.meta.requiresRestart) return true;
    return sameSettingValue(item.value, value);
  });
}

export async function settleSettings(
  read: () => Promise<SettingsResponse>,
  changes: Readonly<Record<string, unknown>>,
  { attempts = 12, delayMs = 400 }: { attempts?: number; delayMs?: number } = {},
): Promise<SettingsResponse | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const data = await read().catch(() => null);
    if (data && settingsReflect(data, changes)) return data;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
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
