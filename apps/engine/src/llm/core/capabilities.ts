import { type ProviderKind, readOpenAiBaseUrl } from "./model-init.ts";

export interface ModelCapabilities {
  supportsImage: boolean;
  supportsFile: boolean; // PDF FilePart
  supportsAudio: boolean;
  supportsVideo: boolean;
  maxFileSizeMB: number;
  maxPdfPages: number;
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

// The openai slot serves real OpenAI audio/video parts only when no
// custom base_url is set. Any custom base_url points at an arbitrary
// OpenAI-compatible host that is assumed not to accept audio/video
// inputs, so those are disabled. Read per call (not memoised) on
// purpose: the base_url leaf is hot-reloadable via settings, and a
// cached value would go stale after a reload. The lookup is a cheap
// config-leaf/env read, and getStaticCapabilities runs once per
// content-assembly pass (bounded by the turn's attachment count) — not
// inside a per-token loop — so the cost is negligible. If it ever moves
// onto a hot path, memoise on the config generation rather than caching
// unconditionally.
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
// assembler. The single decision ladder — no parallel copies. Two
// outcomes:
//
//   - `file_part`    — inline the bytes (base64) as a content block in
//                      the request. Nothing is persisted at the
//                      provider — customer files stay in subkit's own
//                      object store; the provider only sees transient
//                      request payload.
//   - `text_extract` — parse the bytes into text and emit a text block;
//                      the fallback when the inline path isn't viable
//                      (media the provider can't read natively,
//                      oversized files, or — decided by the stateful
//                      caller — per-turn inline budget exhausted).
//
// There is deliberately NO provider Files-API upload path: subkit does
// not hand customer files to provider-side storage (retention there is
// outside subkit's control and incompatible with zero-data-retention
// arrangements).
export type FileStrategy = "file_part" | "text_extract";

export function chooseFileStrategy(
  caps: ModelCapabilities,
  fileSizeBytes: number,
  contentType: string | null | undefined,
): FileStrategy {
  // The raw-bytes path is only viable for media the provider natively
  // reads (images, PDFs). Anything else routed as file_part would make
  // the provider SDK throw at request-build time, so it goes straight
  // to the parser.
  if (!isProviderNativeMedia(contentType)) return "text_extract";
  const mb = fileSizeBytes / (1024 * 1024);
  if (caps.supportsFile && mb <= caps.maxFileSizeMB) return "file_part";
  return "text_extract";
}
