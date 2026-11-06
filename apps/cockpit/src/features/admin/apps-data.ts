import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "@/api/client";
import { useLiveQueryOptions } from "@/app/live-events";
import type { TranslationKey } from "@/lib/i18n";
import {
  type AppActivationOutcome,
  type AppSettingsChanges,
  type AppSummary,
  type AppView,
  appActivationOutcome,
  appSettingsPatch,
} from "@/pages/apps-model";
import {
  type SettingsResponse,
  settingsActivationPath,
  settingsSaveFailure,
} from "@/pages/settings-model";
import type { Envelope, Translate } from "./data";

const fetchApps = () => apiRequest<Envelope<AppSummary>>("/v1/apps");

export const fetchApp = (id: string) => apiRequest<AppView>(`/v1/apps/${encodeURIComponent(id)}`);

const fetchSettings = () => apiRequest<SettingsResponse>("/v1/settings");

const SETTINGS_KEY = ["admin", "settings"] as const;

export const appKey = (id: string) => ["admin", "apps", id] as const;

export function useApps(enabled = true) {
  const live = useLiveQueryOptions();
  return useQuery({ queryKey: ["admin", "apps"], queryFn: fetchApps, enabled, ...live });
}

export function useSettingsSnapshot(enabled: boolean) {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: fetchSettings, enabled });
}

export function settingValue(data: SettingsResponse | undefined, path: string): unknown {
  return data?.items.find((item) => item.path === path)?.value;
}

class ActivationRefused extends Error {}

export function useAppSettingsSave() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: AppSettingsChanges): Promise<AppActivationOutcome> => {
      const data = await client.fetchQuery({
        queryKey: SETTINGS_KEY,
        queryFn: fetchSettings,
        staleTime: 0,
      });
      const saved = await apiRequest<{ saved_revision: number }>("/v1/settings", {
        method: "PATCH",
        body: JSON.stringify(appSettingsPatch(data, changes)),
      });
      const activated = await apiRequest<{ activation_status: string }>(
        settingsActivationPath(saved),
        { method: "POST" },
      );
      const outcome = appActivationOutcome(activated.activation_status);
      if (outcome === "failed") throw new ActivationRefused(activated.activation_status);
      return outcome;
    },
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["admin", "apps"] }),
        client.invalidateQueries({ queryKey: SETTINGS_KEY }),
      ]),
  });
}

export function appSaveError(error: unknown, t: Translate): string {
  if (error instanceof ActivationRefused) return t("apps.save.notActivated");
  if (settingsSaveFailure(error) === "conflict") return t("apps.save.conflict");
  return t("apps.save.failed", {
    reason: error instanceof ApiError ? error.message : t("resource.loadFailedDescription"),
  });
}

export function dialogError(
  tried: boolean,
  errors: readonly TranslationKey[],
  failure: unknown,
  t: Translate,
): string | null {
  if (tried && errors.length > 0) return errors.map((key) => t(key)).join(" ");
  return failure ? appSaveError(failure, t) : null;
}

export function environmentLabel(environment: string, t: Translate): string {
  if (environment === "prod") return t("apps.environment.prod");
  if (environment === "dev") return t("apps.environment.dev");
  return environment;
}
