import { createAzure } from "@ai-sdk/azure";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { type TranscriptionModel, transcribe } from "ai";
import type { Executor } from "../../db/index.ts";
import { checkAndDecrement } from "../accounting/budget.ts";
import { LlmError } from "../errors.ts";
import { modelKeyOwner, readLlmSetting } from "./model-init.ts";
import { assertOperatorKeyAllowed } from "./operator-key-guard.ts";
import { fetchWithResponseTimeout } from "./response-timeout.ts";

export type TranscriptionProviderId = "openai" | "azure" | "gemini";

export const DEFAULT_TRANSCRIPTION_MODEL: Record<TranscriptionProviderId, string> = {
  openai: "gpt-4o-mini-transcribe",
  azure: "gpt-4o-mini-transcribe",
  gemini: "gemini-3.5-transcribe",
};

export interface TranscribeAudioRequest {
  readonly provider: TranscriptionProviderId;
  readonly tenantId: string;
  readonly audio: Uint8Array;
  readonly model?: string | undefined;
  readonly language?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface TranscribedAudio {
  readonly text: string;
  readonly model: string;
  readonly audio_seconds: number | undefined;
}

export type TranscriptionKeyOwner = "workspace" | "operator";

function hasCredentials(provider: TranscriptionProviderId, tenantId: string): boolean {
  if (provider === "openai")
    return (
      Boolean(readLlmSetting("OPENAI_API_KEY", tenantId)) &&
      !readLlmSetting("OPENAI_BASE_URL", tenantId)
    );
  if (provider === "azure")
    return (
      Boolean(readLlmSetting("AZURE_API_KEY", tenantId)) &&
      Boolean(
        readLlmSetting("AZURE_RESOURCE_NAME", tenantId) ||
          readLlmSetting("AZURE_BASE_URL", tenantId),
      )
    );
  return Boolean(readLlmSetting("GEMINI_API_KEY", tenantId));
}

export async function transcriptionKeyOwner(
  provider: TranscriptionProviderId,
  tenantId: string,
  exec?: Executor,
): Promise<TranscriptionKeyOwner | null> {
  if (!hasCredentials(provider, tenantId)) return null;
  if (modelKeyOwner(provider, tenantId) === "workspace") return "workspace";
  try {
    await assertOperatorKeyAllowed(tenantId, exec);
    return "operator";
  } catch (error) {
    if (error instanceof LlmError) return null;
    throw error;
  }
}

export async function transcriptionSpendAllows(
  tenantId: string,
  exec?: Executor,
): Promise<boolean> {
  return (await checkAndDecrement(tenantId, 0, exec)).ok;
}

export const transcriptionModelName = (
  provider: TranscriptionProviderId,
  model: string | undefined,
): string => `${provider}/${model || DEFAULT_TRANSCRIPTION_MODEL[provider]}`;

function keyedOptions(
  setting: string,
  tenantId: string,
  baseUrlSetting?: string,
): Record<string, unknown> {
  const options: Record<string, unknown> = {
    apiKey: readLlmSetting(setting, tenantId),
    fetch: fetchWithResponseTimeout(),
  };
  const baseURL = baseUrlSetting ? readLlmSetting(baseUrlSetting, tenantId) : undefined;
  if (baseURL) options.baseURL = baseURL;
  return options;
}

function azureOptions(tenantId: string): Record<string, unknown> {
  const options = keyedOptions("AZURE_API_KEY", tenantId, "AZURE_BASE_URL");
  const resourceName = readLlmSetting("AZURE_RESOURCE_NAME", tenantId);
  const apiVersion = readLlmSetting("AZURE_API_VERSION", tenantId);
  if (resourceName) options.resourceName = resourceName;
  if (apiVersion) options.apiVersion = apiVersion;
  return options;
}

function transcriptionModel(
  provider: TranscriptionProviderId,
  tenantId: string,
  modelId: string,
): TranscriptionModel {
  if (provider === "openai")
    return createOpenAI(keyedOptions("OPENAI_API_KEY", tenantId)).transcription(modelId);
  if (provider === "azure") return createAzure(azureOptions(tenantId)).transcription(modelId);
  return createGoogleGenerativeAI(
    keyedOptions("GEMINI_API_KEY", tenantId, "GEMINI_BASE_URL"),
  ).transcription(modelId);
}

export async function transcribeAudio(request: TranscribeAudioRequest): Promise<TranscribedAudio> {
  const modelId = request.model || DEFAULT_TRANSCRIPTION_MODEL[request.provider];
  const result = await transcribe({
    model: transcriptionModel(request.provider, request.tenantId, modelId),
    audio: request.audio,
    maxRetries: 1,
    ...(request.language && request.provider !== "gemini"
      ? { providerOptions: { [request.provider]: { language: request.language } } }
      : {}),
    ...(request.signal ? { abortSignal: request.signal } : {}),
  });
  return { text: result.text, model: modelId, audio_seconds: result.durationInSeconds };
}
