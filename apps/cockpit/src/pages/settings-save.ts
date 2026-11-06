import { apiCall } from "@/api/call";
import {
  type SettingsPatch,
  type SettingsResponse,
  sameSettingValue,
} from "@/pages/settings-model";

export async function applySettingsPatch(patch: SettingsPatch): Promise<void> {
  const saved = await apiCall("patch", "/v1/settings", { body: patch });
  await apiCall("post", "/v1/settings/revisions/{revision}/activate", {
    path: { revision: saved.saved_revision },
  });
}

export function settingsReadQuery(patch: SettingsPatch): { tenant?: string } {
  return patch.scope === "tenant" ? { tenant: patch.tenant_id } : {};
}

function settingsReflect(
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

export async function saveWorkspaceSetting(
  path: string,
  tenantId: string,
  value: unknown,
): Promise<void> {
  await apiCall("put", "/v1/settings/{path}", {
    path: { path },
    query: { tenant: tenantId },
    body: { value },
  });
}
