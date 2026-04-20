import type { ProviderKind } from "./model-init.ts";

export interface ModelCapabilities {
  supportsImage: boolean;
  supportsFile: boolean; // PDF FilePart
  supportsAudio: boolean;
  supportsVideo: boolean;
  maxFileSizeMB: number;
  maxPdfPages: number;
  filesApiSupport: boolean; // can upload via Files API (>5MB)
}

// Static fallback defaults per provider (used when gateway resolution unavailable)
const STATIC_CAPABILITIES: Record<ProviderKind, ModelCapabilities> = {
  anthropic: {
    supportsImage: true,
    supportsFile: true,
    supportsAudio: false,
    supportsVideo: false,
    maxFileSizeMB: 32,
    maxPdfPages: 600,
    filesApiSupport: true,
  },
  openai: {
    supportsImage: true,
    supportsFile: true,
    supportsAudio: true,
    supportsVideo: true,
    maxFileSizeMB: 32,
    maxPdfPages: 100,
    filesApiSupport: true,
  },
  gemini: {
    supportsImage: true,
    supportsFile: true,
    supportsAudio: true,
    supportsVideo: true,
    maxFileSizeMB: 50,
    maxPdfPages: 1000,
    filesApiSupport: true,
  },
  azure: {
    supportsImage: true,
    supportsFile: true,
    supportsAudio: true,
    supportsVideo: true,
    maxFileSizeMB: 32,
    maxPdfPages: 100,
    filesApiSupport: false,
  },
  bedrock: {
    supportsImage: true,
    supportsFile: true,
    supportsAudio: true,
    supportsVideo: true,
    maxFileSizeMB: 20,
    maxPdfPages: 200,
    filesApiSupport: false,
  },
  vertex: {
    supportsImage: true,
    supportsFile: true,
    supportsAudio: true,
    supportsVideo: true,
    maxFileSizeMB: 50,
    maxPdfPages: 1000,
    filesApiSupport: false,
  },
  gateway: {
    supportsImage: true,
    supportsFile: true,
    supportsAudio: false,
    supportsVideo: false,
    maxFileSizeMB: 32,
    maxPdfPages: 100,
    filesApiSupport: false,
  },
  mock: {
    supportsImage: true,
    supportsFile: true,
    supportsAudio: false,
    supportsVideo: false,
    maxFileSizeMB: 32,
    maxPdfPages: 100,
    filesApiSupport: false,
  },
};

export function getStaticCapabilities(provider: ProviderKind): ModelCapabilities {
  return STATIC_CAPABILITIES[provider] ?? STATIC_CAPABILITIES.gateway;
}

// Resolve model capabilities. Falls back to static defaults on error.
export async function resolveModelCapabilities(
  provider: ProviderKind,
  _modelId: string,
): Promise<ModelCapabilities> {
  return getStaticCapabilities(provider);
}

// Pick the best content strategy for a PDF given provider capabilities.
export type PdfStrategy = "text" | "file_api" | "file_part" | "images";

export function pickPdfStrategy(
  caps: ModelCapabilities,
  fileSizeBytes: number,
  hasTextLayer: boolean,
): PdfStrategy {
  if (hasTextLayer) return "text";
  const mb = fileSizeBytes / (1024 * 1024);
  if (caps.filesApiSupport && mb > 5) return "file_api";
  if (caps.supportsFile && mb <= caps.maxFileSizeMB) return "file_part";
  if (caps.supportsImage) return "images";
  throw new Error(
    `AI_UnsupportedFunctionalityError: provider supports neither file nor image parts`,
  );
}
