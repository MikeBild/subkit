import { type ProviderKind, readOpenAiBaseUrl } from "./model-init.ts";

export interface ModelCapabilities {
  supportsImage: boolean;
  supportsFile: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  maxFileSizeMB: number;
  maxPdfPages: number;
}

const STATIC_CAPABILITIES: Record<ProviderKind, ModelCapabilities> = {
  anthropic: {
    supportsImage: true,
    supportsFile: true,
    supportsAudio: false,
    supportsVideo: false,
    maxFileSizeMB: 32,
    maxPdfPages: 600,
  },
  openai: {
    supportsImage: true,
    supportsFile: true,
    supportsAudio: true,
    supportsVideo: true,
    maxFileSizeMB: 32,
    maxPdfPages: 100,
  },
  gemini: {
    supportsImage: true,
    supportsFile: true,
    supportsAudio: true,
    supportsVideo: true,
    maxFileSizeMB: 50,
    maxPdfPages: 1000,
  },
  azure: {
    supportsImage: true,
    supportsFile: true,
    supportsAudio: true,
    supportsVideo: true,
    maxFileSizeMB: 32,
    maxPdfPages: 100,
  },
  bedrock: {
    supportsImage: true,
    supportsFile: true,
    supportsAudio: true,
    supportsVideo: true,
    maxFileSizeMB: 20,
    maxPdfPages: 200,
  },
  vertex: {
    supportsImage: true,
    supportsFile: true,
    supportsAudio: true,
    supportsVideo: true,
    maxFileSizeMB: 50,
    maxPdfPages: 1000,
  },
  gateway: {
    supportsImage: true,
    supportsFile: true,
    supportsAudio: false,
    supportsVideo: false,
    maxFileSizeMB: 32,
    maxPdfPages: 100,
  },
  mock: {
    supportsImage: true,
    supportsFile: true,
    supportsAudio: false,
    supportsVideo: false,
    maxFileSizeMB: 32,
    maxPdfPages: 100,
  },
};

function openaiHasCustomBaseUrl(): boolean {
  const v = readOpenAiBaseUrl();
  return Boolean(v && v.length > 0);
}

export function getStaticCapabilities(provider: ProviderKind): ModelCapabilities {
  const base = STATIC_CAPABILITIES[provider] ?? STATIC_CAPABILITIES.gateway;
  if (provider === "openai" && openaiHasCustomBaseUrl()) {
    return { ...base, supportsAudio: false, supportsVideo: false };
  }
  return base;
}

export async function resolveModelCapabilities(
  provider: ProviderKind,
  _modelId: string,
): Promise<ModelCapabilities> {
  return getStaticCapabilities(provider);
}

export function isProviderNativeMedia(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.startsWith("image/") || ct === "application/pdf";
}

export type FileStrategy = "file_part" | "text_extract";

export function chooseFileStrategy(
  caps: ModelCapabilities,
  fileSizeBytes: number,
  contentType: string | null | undefined,
): FileStrategy {
  if (!isProviderNativeMedia(contentType)) return "text_extract";
  const mb = fileSizeBytes / (1024 * 1024);
  if (caps.supportsFile && mb <= caps.maxFileSizeMB) return "file_part";
  return "text_extract";
}
