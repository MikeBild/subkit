import type { components } from "@cli-core/engine-api/openapi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import { useLiveQueryOptions } from "@/app/live-events";
import type { TranslationKey } from "@/lib/i18n";
import {
  type AppActivationOutcome,
  type AppSettingsChanges,
  appActivationOutcome,
  appSettingsPatch,
} from "@/pages/apps-model";
import { settingsSaveFailure } from "@/pages/settings-model";
import type { Translate } from "./data";

type SettingsSnapshot = components["schemas"]["SettingsListResponse"];

const fetchApps = () => apiCall("get", "/v1/apps", {});

export const fetchApp = (id: string) => apiCall("get", "/v1/apps/{id}", { path: { id } });

const fetchSettings = () => apiCall("get", "/v1/settings", {});

const SETTINGS_KEY = ["admin", "settings"] as const;

export const appKey = (id: string) => ["admin", "apps", id] as const;

export function useApps(enabled = true) {
  const live = useLiveQueryOptions();
  return useQuery({ queryKey: ["admin", "apps"], queryFn: fetchApps, enabled, ...live });
}

export function useSettingsSnapshot(enabled: boolean) {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: fetchSettings, enabled });
}

export function settingValue(data: SettingsSnapshot | undefined, path: string): unknown {
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
      const saved = await apiCall("patch", "/v1/settings", {
        body: appSettingsPatch(data, changes),
      });
      const activated = await apiCall("post", "/v1/settings/revisions/{revision}/activate", {
        path: { revision: saved.saved_revision },
      });
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
