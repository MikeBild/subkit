import type { DeploymentMode } from "../config/deployment-mode.ts";

const CHECKED_CLOUD_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "gemini",
  "azure",
  "bedrock",
  "vertex",
  "ai_gateway",
]);

export interface ModelTrustInput {
  provider: string;
  providers: object;
}

export function writesModelChecked(mode: DeploymentMode, llm: ModelTrustInput): boolean {
  if (mode !== "local_workspace") return true;
  if (!CHECKED_CLOUD_PROVIDERS.has(llm.provider)) return false;
  const settings: unknown = (llm.providers as Record<string, unknown>)[llm.provider];
  const baseUrl =
    settings && typeof settings === "object" && "base_url" in settings ? settings.base_url : "";
  return typeof baseUrl !== "string" || baseUrl.trim() === "";
}
