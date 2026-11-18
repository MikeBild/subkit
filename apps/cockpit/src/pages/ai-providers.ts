import type { TranslationKey } from "@/lib/i18n";

export const PROVIDER_MARK: Readonly<Record<string, string>> = {
  openai: "AI",
  anthropic: "AN",
  gemini: "GE",
  azure: "AZ",
  bedrock: "BR",
  vertex: "VX",
  ai_gateway: "GW",
};

export const PROVIDER_KEY_PAGES: Readonly<Record<string, string>> = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  gemini: "https://aistudio.google.com/apikey",
};

export const OWN_KEY_PROVIDERS = ["anthropic", "openai", "gemini"] as const;
export type OwnKeyProvider = (typeof OWN_KEY_PROVIDERS)[number];

export function isOwnKeyProvider(value: string | null | undefined): value is OwnKeyProvider {
  return (OWN_KEY_PROVIDERS as readonly string[]).includes(value ?? "");
}

export const OWN_KEY_PROVIDER_COPY: Readonly<
  Record<OwnKeyProvider, { name: TranslationKey; line: TranslationKey; placeholder: string }>
> = {
  anthropic: {
    name: "aiAccess.provider.anthropic",
    line: "aiAccess.provider.anthropic.line",
    placeholder: "sk-ant-…",
  },
  openai: {
    name: "aiAccess.provider.openai",
    line: "aiAccess.provider.openai.line",
    placeholder: "sk-…",
  },
  gemini: {
    name: "aiAccess.provider.gemini",
    line: "aiAccess.provider.gemini.line",
    placeholder: "AIza…",
  },
};

export type AiAccessRefusal =
  | "keyRejected"
  | "unreachable"
  | "modelUnavailable"
  | "providerUnavailable"
  | "keyRequired";

const REFUSAL_OF_CODE: Readonly<Record<string, AiAccessRefusal>> = {
  llm_key_rejected: "keyRejected",
  llm_provider_unreachable: "unreachable",
  llm_model_unavailable: "modelUnavailable",
  llm_provider_unavailable: "providerUnavailable",
  llm_key_required: "keyRequired",
};

export function aiAccessRefusal(code: string | null): AiAccessRefusal | null {
  return REFUSAL_OF_CODE[code ?? ""] ?? null;
}

export const AI_ACCESS_REFUSAL_KEY: Readonly<Record<AiAccessRefusal, TranslationKey>> = {
  keyRejected: "aiAccess.keyRejected",
  unreachable: "aiAccess.unreachable",
  modelUnavailable: "aiAccess.modelUnavailable",
  providerUnavailable: "aiAccess.providerUnavailable",
  keyRequired: "aiAccess.keyRequired",
};
