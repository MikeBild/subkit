import { type ProviderKind, readOpenAiBaseUrl } from "./model-init.ts";

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

// The openai slot serves the real OpenAI Files API (and audio/video parts) only
// when no custom base_url is set. Any custom base_url points at an arbitrary
// OpenAI-compatible host that is assumed not to implement POST /v1/files (nor
// audio/video inputs), so those are disabled and the assembler falls back to
// inline file_part / text_extract. Read per call (not memoised) on purpose:
// the base_url leaf is hot-reloadable via settings, and a cached value would
// go stale after a reload. The lookup is a cheap config-leaf/env read, and
// getStaticCapabilities runs once per content-assembly pass (bounded by the
// turn's attachment count) — not inside a per-token loop — so the cost is
// negligible. If it ever moves onto a hot path, memoise on the config
// generation rather than caching unconditionally.
function openaiHasCustomBaseUrl(): boolean {
  const v = readOpenAiBaseUrl();
  return Boolean(v && v.length > 0);
}

export function getStaticCapabilities(provider: ProviderKind): ModelCapabilities {
  const base = STATIC_CAPABILITIES[provider] ?? STATIC_CAPABILITIES.gateway;
  if (provider === "openai" && openaiHasCustomBaseUrl()) {
    return { ...base, filesApiSupport: false, supportsAudio: false, supportsVideo: false };
  }
  return base;
}

// Resolve model capabilities. Falls back to static defaults on error.
export async function resolveModelCapabilities(
  provider: ProviderKind,
  _modelId: string,
): Promise<ModelCapabilities> {
  return getStaticCapabilities(provider);
}

/** Media the model providers natively understand as raw bytes: images
 *  (image content blocks) and PDFs (document blocks). Everything else
 *  (docx, xlsx, csv, json, …) must be parsed to text before it reaches
 *  the model — the provider SDKs throw `UnsupportedFunctionalityError`
 *  for a raw-bytes file part with any other media type. */
export function isProviderNativeMedia(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.startsWith("image/") || ct === "application/pdf";
}

// Generic per-file strategy used by the conversation LLM-context
// assembler. The single decision ladder — no parallel copies. Three
// outcomes:
//
//   - `file_api`     — upload the bytes via the provider Files API and
//                      reference by id (no per-turn token cost).
//   - `file_part`    — inline the bytes (base64) as a content block.
//   - `text_extract` — parse the bytes into text and emit a text block;
//                      the fallback when neither file path is viable
//                      (media the provider can't read natively, no
//                      Files API for an oversized file, or — decided by
//                      the stateful caller — per-turn inline budget
//                      exhausted).
export type FileStrategy = "file_api" | "file_part" | "text_extract";

export function chooseFileStrategy(
  caps: ModelCapabilities,
  fileSizeBytes: number,
  contentType: string | null | undefined,
): FileStrategy {
  // Raw-bytes paths are only viable for media the provider natively
  // reads (images, PDFs). Anything else routed as file_part would make
  // the provider SDK throw at request-build time, so it goes straight
  // to the parser.
  if (!isProviderNativeMedia(contentType)) return "text_extract";
  const mb = fileSizeBytes / (1024 * 1024);
  if (caps.filesApiSupport && mb > 5) return "file_api";
  if (caps.supportsFile && mb <= caps.maxFileSizeMB) return "file_part";
  // Native media too large to inline: upload + reference when the
  // provider has a Files API; otherwise degrade to the parser.
  if (caps.filesApiSupport) return "file_api";
  return "text_extract";
}
