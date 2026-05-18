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

// Generic per-file strategy used by the conversation LLM-context
// assembler. Shares the same matrix as `pickPdfStrategy` — there
// is no parallel decision ladder. Three outcomes:
//
//   - `file_api`     — upload the bytes via the provider Files API and
//                      reference by id (no per-turn token cost).
//   - `file_part`    — inline the bytes (base64) as a content block.
//   - `text_extract` — parse the bytes into text and emit a text block;
//                      the fallback when neither file path is viable
//                      (oversized, provider doesn't accept the media
//                      type, or per-turn inline budget exhausted).
export type FileStrategy = "file_api" | "file_part" | "text_extract";

export function chooseFileStrategy(caps: ModelCapabilities, fileSizeBytes: number): FileStrategy {
  const mb = fileSizeBytes / (1024 * 1024);
  if (caps.filesApiSupport && mb > 5) return "file_api";
  if (caps.supportsFile && mb <= caps.maxFileSizeMB) return "file_part";
  return "text_extract";
}
