import { getConfig } from "../../config/loader.ts";
import { readEnv } from "../../env.ts";
import {
  CATALOG_MODEL_PROVIDERS,
  type CatalogModelProvider,
  DEFAULT_MODELS,
} from "../model-catalog-view.ts";
import { validateProviderSetup, workspaceOwnsProviderKey } from "./model-init.ts";

export const WORKSPACE_KEY_PROVIDERS = CATALOG_MODEL_PROVIDERS;

export function mockProviderAllowed(): boolean {
  return readEnv("NODE_ENV") === "test" || readEnv("NODE_ENV") === "development";
}

export function workspaceKeyModel(provider: CatalogModelProvider, chosen?: string | null): string {
  return chosen?.trim() || DEFAULT_MODELS[provider].primary;
}

export interface WorkspaceAiAccess {
  configured: boolean;
  provider: string | null;
  model: string | null;
  own_key: boolean;
}

const NO_ACCESS: WorkspaceAiAccess = {
  configured: false,
  provider: null,
  model: null,
  own_key: false,
};

export function workspaceAiAccess(tenant: {
  id: string;
  origin: "self_hosted" | "self_service";
}): WorkspaceAiAccess {
  let config: ReturnType<typeof getConfig>;
  try {
    config = getConfig();
  } catch {
    return NO_ACCESS;
  }
  const setup = validateProviderSetup(tenant.id);
  if (setup.detected === "unconfigured") return NO_ACCESS;
  const provider = setup.detected;
  const model = config.tenants[tenant.id]?.llm?.model || null;
  const ownKey = workspaceOwnsProviderKey(tenant.id, provider);
  if (tenant.origin !== "self_service" || ownKey || provider === "mock") {
    return { configured: ownKey || setup.ok, provider, model, own_key: ownKey };
  }
  return { configured: false, provider, model, own_key: false };
}
