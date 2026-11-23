import type { components } from "@cli-core/engine-api/openapi";
import { useQuery } from "@tanstack/react-query";
import { apiCall } from "./call";

export type Setup = components["schemas"]["Setup"] & { save_new_notes?: boolean };
export type SetupUpdate = components["schemas"]["UpdateSetupBody"] & { save_new_notes?: boolean };
export type SetupEnvironment = Setup["default_environment"];

export const SETUP_KEY = ["identity-setup"] as const;

export function readSetup(): Promise<Setup> {
  return apiCall("get", "/v1/identity/me/setup", {});
}

export function writeSetup(body: SetupUpdate): Promise<Setup> {
  return apiCall("put", "/v1/identity/me/setup", { body });
}

export function useSetup(enabled = true) {
  return useQuery({
    queryKey: SETUP_KEY,
    queryFn: readSetup,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function useDefaultEnvironment(): SetupEnvironment {
  return useSetup().data?.default_environment ?? "dev";
}
