import { createAzure } from "@ai-sdk/azure";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { type TranscriptionModel, transcribe } from "ai";
import { getConfig } from "../../config/loader.ts";
import { modelKeyOwner, readLlmSetting } from "../../llm/runtime/model-init.ts";
import { fetchWithResponseTimeout } from "../../llm/runtime/response-timeout.ts";
import type { CloudTranscriberId } from "../core/order.ts";
import type { TranscribeRequest, Transcriber } from "../port.ts";

const DEFAULT_MODEL: Record<CloudTranscriberId, string> = {
  openai: "gpt-4o-mini-transcribe",
  azure: "gpt-4o-mini-transcribe",
  gemini: "gemini-3.5-transcribe",
};

const hostedAuth = (): boolean => {
  try {
    return getConfig().auth.hosted.enabled;
  } catch {
    return false;
  }
};

function hasCredentials(id: CloudTranscriberId, tenantId: string): boolean {
  if (id === "openai")
    return (
      Boolean(readLlmSetting("OPENAI_API_KEY", tenantId)) &&
      !readLlmSetting("OPENAI_BASE_URL", tenantId)
    );
  if (id === "azure")
    return (
      Boolean(readLlmSetting("AZURE_API_KEY", tenantId)) &&
      Boolean(
        readLlmSetting("AZURE_RESOURCE_NAME", tenantId) ||
          readLlmSetting("AZURE_BASE_URL", tenantId),
      )
    );
  return Boolean(readLlmSetting("GEMINI_API_KEY", tenantId));
}

export function cloudTranscriberConfigured(id: CloudTranscriberId, tenantId: string): boolean {
  if (!hasCredentials(id, tenantId)) return false;
  return modelKeyOwner(id, tenantId) === "workspace" || !hostedAuth();
}

function azureOptions(tenantId: string): Record<string, unknown> {
  const options: Record<string, unknown> = {
    apiKey: readLlmSetting("AZURE_API_KEY", tenantId),
    fetch: fetchWithResponseTimeout(),
  };
  const resourceName = readLlmSetting("AZURE_RESOURCE_NAME", tenantId);
  const baseURL = readLlmSetting("AZURE_BASE_URL", tenantId);
  const apiVersion = readLlmSetting("AZURE_API_VERSION", tenantId);
  if (resourceName) options.resourceName = resourceName;
  if (baseURL) options.baseURL = baseURL;
  if (apiVersion) options.apiVersion = apiVersion;
  return options;
}

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

function transcriptionModel(
  id: CloudTranscriberId,
  tenantId: string,
  modelId: string,
): TranscriptionModel {
  if (id === "openai")
    return createOpenAI(keyedOptions("OPENAI_API_KEY", tenantId)).transcription(modelId);
  if (id === "azure") return createAzure(azureOptions(tenantId)).transcription(modelId);
  return createGoogleGenerativeAI(
    keyedOptions("GEMINI_API_KEY", tenantId, "GEMINI_BASE_URL"),
  ).transcription(modelId);
}

export function createCloudTranscriber(id: CloudTranscriberId): Transcriber {
  return {
    id,
    async transcribe(request: TranscribeRequest): Promise<string> {
      const result = await transcribe({
        model: transcriptionModel(id, request.tenantId, request.model || DEFAULT_MODEL[id]),
        audio: request.audio,
        maxRetries: 1,
        ...(request.language && id !== "gemini"
          ? { providerOptions: { [id]: { language: request.language } } }
          : {}),
        ...(request.signal ? { abortSignal: request.signal } : {}),
      });
      return result.text;
    },
  };
}
