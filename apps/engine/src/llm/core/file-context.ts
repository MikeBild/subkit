// LLM file-context assembly.
//
// Given a list of `$file` refs surfacing in a conversation turn, this
// module routes each file through the canonical `chooseFileStrategy`
// decision tree in `capabilities.ts` and produces a typed content block
// per strategy:
//
//   - `file_api`    — upload via the provider Files API (cached by row
//                     when `<provider>_file_id` is non-expired) and emit
//                     a provider-native file-id reference block. The
//                     uploader call is the side effect that owns DB
//                     persistence (tenant-scoped UPDATE on the `files`
//                     row).
//   - `file_part`   — load the bytes, base64-encode, emit an inline
//                     content block. Hard per-turn cap of 250 KiB total
//                     inline bytes; once a turn crosses the cap, every
//                     subsequent file is forced to `text_extract`.
//   - `text_extract` — load the bytes, run the knowledge-source parser,
//                      emit a text block. The fallback when no file-
//                      capable path is viable (oversized, unsupported
//                      media, or per-turn inline budget exhausted).
//
// Reuses the exact decision tree exposed by `capabilities.ts`. No
// parallel strategy ladder lives here — any new file routing rule
// belongs in `chooseFileStrategy` so every consumer (this module, the
// HTTP /v1/files/inline path, the connector preview) agrees on the
// answer. Tenant isolation
// is preserved at two seams:
//   1. The resolver — every fid we touch routes through
//      `walkAndResolve` / `requireFileForTenant`.
//   2. The provider-id persist UPDATE — scoped by
//      `(id=fid AND tenant_id=tenant_id)`.
//
// The `subkit_files_llm_inline_bytes_total` metric is fed from the
// `inline_bytes` counter this module exposes — see the observability
// ladder under `apps/engine/src/observability/`.

import { and, eq } from "drizzle-orm";
import {
  AuditAction,
  auditAwait,
  bucketSize,
  ContentPartSentMetadataSchema,
} from "../../audit/index.ts";
import type { Db } from "../../db/client.ts";
import { files } from "../../db/schema/files.ts";
import { BinaryParseError, parseBinaryFile } from "../../docs-ingestion/parsers/index.ts";
import { type ResolvedFile, resolveSingleFid } from "../../files/resolver.ts";
import { detectFormat, isBinaryFormat, parseFileToChunks } from "../../knowledge/parsers.ts";
import { logger } from "../../logging/logger.ts";
import { chooseFileStrategy, type ModelCapabilities } from "./capabilities.ts";
import { type FilesApiError, type UploadedFile, uploadFileViaApi } from "./files-api.ts";
import type { ProviderKind } from "./model-init.ts";

/** Per-turn hard cap on cumulative inline file bytes. Beyond this the
 *  next file is force-routed to `text_extract` even when its size +
 *  capabilities would otherwise pick `file_part`. */
export const FILE_PART_PER_TURN_CAP_BYTES = 250 * 1024;

/** Per-file ceiling on bytes read for the `text_extract` path. A 10 MB
 *  CSV would otherwise be loaded whole into the LLM context window;
 *  cap at 1 MB and append a truncation marker. The cap applies BEFORE
 *  the knowledge-source parser runs — the parser may produce more or
 *  fewer characters than bytes, but the upstream byte read is the only
 *  surface that can blow past the model's token budget. */
export const TEXT_EXTRACT_PER_FILE_MAX_BYTES = 1024 * 1024;

/** Per-file ceiling on RAW bytes read for the `text_extract` binary
 *  branch (pdf/docx/xlsx/pptx). Binary parsers need the full file —
 *  parsing a truncated PDF yields zero text — so the per-file cap is
 *  raised to 25 MB. The 1 MB `TEXT_EXTRACT_PER_FILE_MAX_BYTES` ceiling
 *  is then applied to the *parsed* text before it enters the context
 *  window, so the token budget is unchanged. Binaries larger than this
 *  ceiling get a `[file: <name>] (too large to parse)` placeholder
 *  instead of being read. */
export const TEXT_EXTRACT_BINARY_PER_FILE_MAX_BYTES = 25 * 1024 * 1024;

/** Per-turn ceiling on cumulative `text_extract` bytes. Three medium
 *  CSVs at the per-file cap would still bury the model. Once the
 *  running total would exceed this, subsequent files emit a one-line
 *  placeholder ("skipped, per-turn cap reached") instead of being read. */
export const TEXT_EXTRACT_PER_TURN_CAP_BYTES = 4 * 1024 * 1024;

/** The three supported providers for the Files API path. `chooseFileStrategy`
 *  returns `file_api` only for caps with `filesApiSupport: true`, which in
 *  the static matrix maps to anthropic / openai / gemini. */
export type FilesApiProvider = "anthropic" | "openai" | "gemini";

function isFilesApiProvider(p: ProviderKind): p is FilesApiProvider {
  return p === "anthropic" || p === "openai" || p === "gemini";
}

/** Discriminated union for one assembled content block. The shape per
 *  variant intentionally mirrors the provider-native wire format the
 *  upstream raw API expects — the SDK consumer translates as needed. */
export type FileContentBlock =
  | {
      strategy: "file_api";
      file_id: string;
      filename: string;
      content_type: string;
      provider: FilesApiProvider;
      /** Provider-native content block exactly as the upstream API expects.
       *  - anthropic: `{ type: "document", source: { type: "file", file_id } }`
       *  - openai:    `{ type: "input_file", file_id }`
       *  - gemini:    `{ fileData: { fileUri, mimeType } }`
       */
      native: AnthropicFileBlock | OpenAIFileBlock | GeminiFileBlock;
    }
  | {
      strategy: "file_part";
      filename: string;
      content_type: string;
      mediaType: string;
      /** Raw bytes — the SDK consumer base64-encodes or streams. */
      data: Uint8Array;
    }
  | {
      strategy: "text_extract";
      filename: string;
      content_type: string;
      /** Extracted markdown / plain text from the knowledge-source
       *  parser. Truncated and chunk-joined by `text_extract`. */
      text: string;
      /** True when the parser could not handle the format and the text
       *  is a `[file: filename]` placeholder. */
      placeholder: boolean;
    };

interface AnthropicFileBlock {
  type: "document";
  source: { type: "file"; file_id: string };
}

interface OpenAIFileBlock {
  type: "input_file";
  file_id: string;
}

interface GeminiFileBlock {
  fileData: { fileUri: string; mimeType: string };
}

export interface BuildFileContentBlocksParams {
  db: Db;
  tenant_id: string;
  provider: ProviderKind;
  capabilities: ModelCapabilities;
  /** Wire-format file ids (`fid_<uuid>`) — typically extracted from
   *  the user message (`[file:fid_...]` sentinel) or from the
   *  conversation's linked attachments. The resolver enforces tenant
   *  scope; cross-tenant fids throw `FileNotFoundError`. */
  fids: string[];
  /** Override for tests — defaults to the real provider Files API.
   *  Wraps `uploadFileViaApi` so individual tests can fake the upload
   *  without an environment + network roundtrip. */
  uploader?: typeof uploadFileViaApi;
  /** Override for tests — defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface BuildFileContentBlocksResult {
  blocks: FileContentBlock[];
  /** Total inline bytes consumed by the assembled `file_part` blocks
   *  in this turn — observability hook for the
   *  `subkit_files_llm_inline_bytes_total` counter. */
  inline_bytes: number;
  /** Number of files force-downgraded to `text_extract` because the
   *  cumulative inline budget exceeded `FILE_PART_PER_TURN_CAP_BYTES`. */
  inline_cap_downgrades: number;
}

/**
 * Assemble file content blocks for a single LLM turn. Walks each fid
 * through `chooseFileStrategy`, performs the side effects (uploads,
 * reads, parses, persists provider ids), and returns the typed blocks
 * plus per-turn accounting. The caller decides how to splice the
 * blocks into the model-message array.
 */
export async function buildFileContentBlocks(
  p: BuildFileContentBlocksParams,
): Promise<BuildFileContentBlocksResult> {
  const blocks: FileContentBlock[] = [];
  const now = p.now ?? (() => new Date());
  const uploader = p.uploader ?? uploadFileViaApi;
  let inline_bytes = 0;
  let inline_cap_downgrades = 0;
  // Per-turn `text_extract` budget. Tracked separately from
  // `inline_bytes` because the two strategies have different cost
  // models: `file_part` ships raw bytes (LLM has its own image / PDF
  // tokeniser), while `text_extract` lands as plain text directly in
  // the context window — so much smaller files still dwarf the budget.
  let text_extract_bytes = 0;

  // Resolve each fid through the tenant-isolation chokepoint. The
  // resolver returns a ResolvedFile leaf; we still need the raw row
  // for provider-id columns + expiry, so a direct row read per fid
  // sits inside `resolveSingleFid` (with a shared cache so repeated
  // refs in the same turn pay one DB hit).
  const resolveCache = new Map<string, ResolvedFile>();
  for (const fid of p.fids) {
    let resolved: ResolvedFile;
    try {
      // `resolveSingleFid` raises `FileNotFoundError` for cross-tenant
      // or unknown ids — let it propagate so the loop fails fast.
      resolved = await resolveSingleFid(p.db, p.tenant_id, fid, resolveCache);
    } catch (err) {
      logger.warn({
        module: "llm.file_context",
        action: "resolve_failed",
        tenant_id: p.tenant_id,
        file_id: fid,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let strategy = chooseFileStrategy(p.capabilities, resolved.size_bytes);

    // Per-turn inline budget guard — once we'd exceed the cap, force
    // the next file (which would have chosen `file_part`) to
    // `text_extract`. `file_api` is exempt: it doesn't consume the
    // inline budget. Counting after-the-fact for downgrade telemetry.
    if (
      strategy === "file_part" &&
      inline_bytes + resolved.size_bytes > FILE_PART_PER_TURN_CAP_BYTES
    ) {
      strategy = "text_extract";
      inline_cap_downgrades += 1;
    }

    if (strategy === "file_api") {
      if (!isFilesApiProvider(p.provider)) {
        // chooseFileStrategy said file_api but the provider isn't one
        // of the three with a Files API. Fall through to file_part if
        // the inline budget allows, else text_extract.
        if (inline_bytes + resolved.size_bytes <= FILE_PART_PER_TURN_CAP_BYTES) {
          strategy = "file_part";
        } else {
          strategy = "text_extract";
          inline_cap_downgrades += 1;
        }
      } else {
        const block = await assembleFileApiBlock({
          db: p.db,
          tenant_id: p.tenant_id,
          provider: p.provider,
          file_id: fid,
          resolved,
          uploader,
          now: now(),
        });
        if (block) {
          blocks.push(block);
          continue;
        }
        // Upload path failed — degrade to file_part (or text_extract
        // if the inline budget can't fit the bytes). This realises the
        // documented fallback chain: file_api → file_part → text_extract.
        if (inline_bytes + resolved.size_bytes <= FILE_PART_PER_TURN_CAP_BYTES) {
          strategy = "file_part";
        } else {
          strategy = "text_extract";
          inline_cap_downgrades += 1;
        }
      }
    }

    if (strategy === "file_part") {
      const block = await assembleFilePartBlock(resolved);
      if (block && block.strategy === "file_part") {
        blocks.push(block);
        inline_bytes += block.data.byteLength;
        continue;
      }
      // Byte read failed — fall through to text_extract placeholder.
      strategy = "text_extract";
    }

    // text_extract — always the safe fallback. The block helper caps
    // each file at `TEXT_EXTRACT_PER_FILE_MAX_BYTES` and returns the
    // truncated-byte count so we can accumulate against the per-turn
    // cap. Files arriving after the per-turn cap is exhausted get a
    // one-line placeholder instead of being read.
    const block = await assembleTextExtractBlock(resolved, {
      perTurnBudgetRemaining: TEXT_EXTRACT_PER_TURN_CAP_BYTES - text_extract_bytes,
    });
    blocks.push(block.block);
    text_extract_bytes += block.bytes_read;
  }

  return { blocks, inline_bytes, inline_cap_downgrades };
}

interface AssembleFileApiArgs {
  db: Db;
  tenant_id: string;
  provider: FilesApiProvider;
  file_id: string;
  resolved: ResolvedFile;
  uploader: typeof uploadFileViaApi;
  now: Date;
}

/** Build a `file_api` block — reuses the cached provider id when the
 *  row carries a non-expired one for this provider, else uploads and
 *  persists. Returns null on upload failure so the caller can degrade. */
async function assembleFileApiBlock(a: AssembleFileApiArgs): Promise<FileContentBlock | null> {
  // Re-read the row so the provider-id columns are fresh. The
  // resolver pulled bytes-metadata only; provider columns may have
  // been written by an earlier turn in this same conversation.
  const [row] = await a.db
    .select({
      anthropic_file_id: files.anthropic_file_id,
      openai_file_id: files.openai_file_id,
      gemini_file_id: files.gemini_file_id,
      llm_file_expires_at: files.llm_file_expires_at,
    })
    .from(files)
    .where(and(eq(files.id, a.resolved.id), eq(files.tenant_id, a.tenant_id)))
    .limit(1);

  const existing = row ? readProviderId(row, a.provider) : null;
  const expiresAt = row?.llm_file_expires_at ?? null;
  const fresh = existing !== null && expiresAt !== null && expiresAt.getTime() > a.now.getTime();

  if (fresh && existing !== null) {
    return makeFileApiBlock({
      provider: a.provider,
      file_id: existing,
      filename: a.resolved.filename,
      content_type: a.resolved.content_type ?? "application/octet-stream",
    });
  }

  // Need to upload. Buffer the bytes (the uploader takes a Uint8Array
  // — these provider Files APIs don't expose streamed multipart).
  let data: Uint8Array;
  try {
    const stream = await a.resolved.openRead();
    data = await collectStream(stream);
  } catch (err) {
    logger.warn({
      module: "llm.file_context",
      action: "file_api.read_failed",
      tenant_id: a.tenant_id,
      file_id: a.file_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  let uploaded: UploadedFile;
  try {
    uploaded = await a.uploader({
      provider: a.provider,
      data,
      mimeType: a.resolved.content_type ?? "application/octet-stream",
      filename: a.resolved.filename,
    });
  } catch (err) {
    logger.warn({
      module: "llm.file_context",
      action: "file_api.upload_failed",
      tenant_id: a.tenant_id,
      file_id: a.file_id,
      provider: a.provider,
      status: (err as FilesApiError | undefined)?.status,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Persist back to the row — tenant-scoped UPDATE. Per the layered
  // design the uploader stays pure (no DB binding); the file-context
  // module (this caller) owns the persistence side effect.
  await persistProviderUpload(a.db, a.tenant_id, a.resolved.id, a.provider, uploaded);

  // Audit the egress as a discrete `CONTENT_PART_SENT` row. The
  // wrapping `LLM_INVOCATION` still fires from the invocation side;
  // this audit isolates the per-file upload as a separately
  // queryable event so SIEM consumers can chart per-tenant byte
  // egress to provider Files APIs. Only fresh uploads land an audit
  // row — cached `<provider>_file_id` reuse short-circuited above
  // and pays no bandwidth.
  await auditAwait(
    {
      tenant_id: a.tenant_id,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.CONTENT_PART_SENT,
      resource_type: "file",
      resource_id: a.resolved.id,
      result: "success",
      metadata: ContentPartSentMetadataSchema.parse({
        provider: a.provider,
        file_id: a.resolved.id,
        content_type: a.resolved.content_type ?? "application/octet-stream",
        size_bytes_bucket: bucketSize(data.byteLength),
      }),
    },
    a.db,
  );

  return makeFileApiBlock({
    provider: a.provider,
    file_id: uploaded.file_id,
    filename: a.resolved.filename,
    content_type: a.resolved.content_type ?? "application/octet-stream",
  });
}

function readProviderId(
  row: {
    anthropic_file_id: string | null;
    openai_file_id: string | null;
    gemini_file_id: string | null;
  },
  provider: FilesApiProvider,
): string | null {
  if (provider === "anthropic") return row.anthropic_file_id;
  if (provider === "openai") return row.openai_file_id;
  return row.gemini_file_id;
}

/** Tenant-scoped UPDATE — writes the provider-side id + expiry the
 *  uploader returned back onto the canonical `files` row. Subsequent
 *  turns within the expiry window reuse this id instead of re-paying
 *  the upload roundtrip.
 *
 *  Exported so workflow-side file-output flows can call it directly
 *  when they upload outside the conversation context-assembly path. */
export async function persistProviderUpload(
  db: Db,
  tenant_id: string,
  file_uuid: string,
  provider: FilesApiProvider,
  uploaded: UploadedFile,
): Promise<void> {
  const patch: Partial<typeof files.$inferInsert> = {
    llm_file_expires_at: uploaded.expires_at ?? null,
  };
  if (provider === "anthropic") patch.anthropic_file_id = uploaded.file_id;
  else if (provider === "openai") patch.openai_file_id = uploaded.file_id;
  else patch.gemini_file_id = uploaded.file_id;
  await db
    .update(files)
    .set(patch)
    .where(and(eq(files.id, file_uuid), eq(files.tenant_id, tenant_id)));
}

function makeFileApiBlock(args: {
  provider: FilesApiProvider;
  file_id: string;
  filename: string;
  content_type: string;
}): FileContentBlock {
  if (args.provider === "anthropic") {
    return {
      strategy: "file_api",
      file_id: args.file_id,
      filename: args.filename,
      content_type: args.content_type,
      provider: "anthropic",
      native: {
        type: "document",
        source: { type: "file", file_id: args.file_id },
      },
    };
  }
  if (args.provider === "openai") {
    return {
      strategy: "file_api",
      file_id: args.file_id,
      filename: args.filename,
      content_type: args.content_type,
      provider: "openai",
      native: { type: "input_file", file_id: args.file_id },
    };
  }
  return {
    strategy: "file_api",
    file_id: args.file_id,
    filename: args.filename,
    content_type: args.content_type,
    provider: "gemini",
    native: {
      fileData: { fileUri: args.file_id, mimeType: args.content_type },
    },
  };
}

async function assembleFilePartBlock(resolved: ResolvedFile): Promise<FileContentBlock | null> {
  try {
    const stream = await resolved.openRead();
    const data = await collectStream(stream);
    return {
      strategy: "file_part",
      filename: resolved.filename,
      content_type: resolved.content_type ?? "application/octet-stream",
      mediaType: resolved.content_type ?? "application/octet-stream",
      data,
    };
  } catch (err) {
    logger.warn({
      module: "llm.file_context",
      action: "file_part.read_failed",
      file_id: resolved.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** text_extract — load + parse the file using the knowledge-source
 *  parser. On parse failure (unsupported format, binary garbage,
 *  decode error) returns a `[file: filename]` placeholder block so
 *  the turn never crashes.
 *
 *  Caps:
 *  - Per-file: read at most `TEXT_EXTRACT_PER_FILE_MAX_BYTES`; append a
 *    `[file truncated at N bytes]` marker when the file was longer.
 *  - Per-turn: if the caller signals the per-turn budget is exhausted
 *    (`perTurnBudgetRemaining <= 0`) skip the read entirely and emit a
 *    one-line `[file <name>: skipped, per-turn cap reached]` placeholder. */
async function assembleTextExtractBlock(
  resolved: ResolvedFile,
  budget: { perTurnBudgetRemaining: number },
): Promise<{ block: FileContentBlock; bytes_read: number }> {
  const placeholderText = `[file: ${resolved.filename}]`;
  const contentType = resolved.content_type ?? "application/octet-stream";

  if (budget.perTurnBudgetRemaining <= 0) {
    return {
      block: {
        strategy: "text_extract",
        filename: resolved.filename,
        content_type: contentType,
        text: `[file ${resolved.filename}: skipped, per-turn cap reached]`,
        placeholder: true,
      },
      bytes_read: 0,
    };
  }

  // Detect the format up front — binary files (pdf/docx/xlsx/pptx) need
  // the whole buffer for the parser to work, so we take a separate
  // branch that reads up to TEXT_EXTRACT_BINARY_PER_FILE_MAX_BYTES and
  // applies the per-file/per-turn text cap to the *parsed* output.
  const detectedFormat = detectFormat(resolved.filename, resolved.content_type ?? undefined);
  if (isBinaryFormat(detectedFormat)) {
    return assembleBinaryTextExtractBlock(resolved, detectedFormat, budget);
  }

  // Per-file cap: never read more than the per-file ceiling and never
  // more than the remaining per-turn budget.
  const perFileLimit = Math.min(
    TEXT_EXTRACT_PER_FILE_MAX_BYTES,
    Math.max(1, budget.perTurnBudgetRemaining),
  );

  let bytes: Uint8Array;
  let truncated = false;
  try {
    const stream = await resolved.openRead();
    const read = await collectStreamWithLimit(stream, perFileLimit);
    bytes = read.bytes;
    truncated = read.truncated;
  } catch (err) {
    logger.warn({
      module: "llm.file_context",
      action: "text_extract.read_failed",
      file_id: resolved.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      block: {
        strategy: "text_extract",
        filename: resolved.filename,
        content_type: contentType,
        text: placeholderText,
        placeholder: true,
      },
      bytes_read: 0,
    };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (err) {
    logger.warn({
      module: "llm.file_context",
      action: "text_extract.decode_failed",
      file_id: resolved.id,
      filename: resolved.filename,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      block: {
        strategy: "text_extract",
        filename: resolved.filename,
        content_type: contentType,
        text: placeholderText,
        placeholder: true,
      },
      bytes_read: bytes.byteLength,
    };
  }

  const truncationMarker = truncated ? `\n\n[file truncated at ${bytes.byteLength} bytes]` : "";

  try {
    const format = detectFormat(resolved.filename, resolved.content_type ?? undefined);
    const chunks = parseFileToChunks(text, resolved.filename, format);
    if (chunks.length === 0) {
      return {
        block: {
          strategy: "text_extract",
          filename: resolved.filename,
          content_type: contentType,
          text: placeholderText + truncationMarker,
          placeholder: true,
        },
        bytes_read: bytes.byteLength,
      };
    }
    const joined = chunks
      .map((c) => (c.title ? `## ${c.title}\n\n${c.content}` : c.content))
      .join("\n\n");
    return {
      block: {
        strategy: "text_extract",
        filename: resolved.filename,
        content_type: contentType,
        text: `[${resolved.filename}]\n${joined}${truncationMarker}`,
        placeholder: false,
      },
      bytes_read: bytes.byteLength,
    };
  } catch (err) {
    logger.warn({
      module: "llm.file_context",
      action: "text_extract.parse_failed",
      file_id: resolved.id,
      filename: resolved.filename,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      block: {
        strategy: "text_extract",
        filename: resolved.filename,
        content_type: contentType,
        text: placeholderText + truncationMarker,
        placeholder: true,
      },
      bytes_read: bytes.byteLength,
    };
  }
}

/** Binary `text_extract` branch — reads the whole file (subject to the
 *  binary per-file ceiling), runs the matching parser, then truncates
 *  the extracted text to the same per-file/per-turn budget the text
 *  branch applies. Falls back to the standard placeholder on any
 *  parser failure so the turn never crashes. */
async function assembleBinaryTextExtractBlock(
  resolved: ResolvedFile,
  format: ReturnType<typeof detectFormat>,
  budget: { perTurnBudgetRemaining: number },
): Promise<{ block: FileContentBlock; bytes_read: number }> {
  const contentType = resolved.content_type ?? "application/octet-stream";
  const placeholderText = `[file: ${resolved.filename}]`;
  if (resolved.size_bytes > TEXT_EXTRACT_BINARY_PER_FILE_MAX_BYTES) {
    return {
      block: {
        strategy: "text_extract",
        filename: resolved.filename,
        content_type: contentType,
        text: `${placeholderText} (too large to parse: ${resolved.size_bytes} bytes)`,
        placeholder: true,
      },
      bytes_read: 0,
    };
  }

  let raw: Uint8Array;
  try {
    const stream = await resolved.openRead();
    raw = await collectStream(stream);
  } catch (err) {
    logger.warn({
      module: "llm.file_context",
      action: "text_extract.binary_read_failed",
      file_id: resolved.id,
      format,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      block: {
        strategy: "text_extract",
        filename: resolved.filename,
        content_type: contentType,
        text: placeholderText,
        placeholder: true,
      },
      bytes_read: 0,
    };
  }

  let parsedText: string;
  try {
    const buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    const parsed = await parseBinaryFile(
      buffer,
      format as "pdf" | "docx" | "xlsx" | "xls" | "pptx",
    );
    parsedText = renderBinaryAsText(parsed);
  } catch (err) {
    const cause = err instanceof BinaryParseError ? err.message : String(err);
    logger.warn({
      module: "llm.file_context",
      action: "text_extract.binary_parse_failed",
      file_id: resolved.id,
      format,
      error: cause,
    });
    return {
      block: {
        strategy: "text_extract",
        filename: resolved.filename,
        content_type: contentType,
        text: `${placeholderText} (parse failed: ${cause})`,
        placeholder: true,
      },
      bytes_read: raw.byteLength,
    };
  }

  const textCap = Math.min(
    TEXT_EXTRACT_PER_FILE_MAX_BYTES,
    Math.max(1, budget.perTurnBudgetRemaining),
  );
  let body = parsedText;
  let truncationMarker = "";
  const parsedByteLen = Buffer.byteLength(parsedText, "utf8");
  if (parsedByteLen > textCap) {
    body = parsedText.slice(0, textCap);
    truncationMarker = `\n\n[file truncated at ${textCap} bytes of extracted text; original ${resolved.size_bytes} bytes]`;
  }
  return {
    block: {
      strategy: "text_extract",
      filename: resolved.filename,
      content_type: contentType,
      text: `[${resolved.filename}]\n${body}${truncationMarker}`,
      placeholder: false,
    },
    bytes_read: parsedByteLen,
  };
}

function renderBinaryAsText(parsed: Awaited<ReturnType<typeof parseBinaryFile>>): string {
  switch (parsed.format) {
    case "pdf":
      return parsed.text;
    case "docx":
      return parsed.markdown;
    case "xlsx":
    case "xls":
      return Object.entries(parsed.sheets)
        .map(([name, rows]) => `## ${name}\n\n${JSON.stringify(rows, null, 2)}`)
        .join("\n\n");
    case "pptx":
      return parsed.slides.map((slide) => `## Slide ${slide.index}\n\n${slide.text}`).join("\n\n");
  }
}

/** Drain an `AsyncIterable<Uint8Array>` into a single buffer. The
 *  bytes-API path needs a flat Uint8Array; we accept the buffering
 *  cost here because `chooseFileStrategy` already routes anything
 *  larger than the per-turn budget to `text_extract`. */
async function collectStream(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Variant of `collectStream` that stops reading once `limit` bytes
 *  have been buffered. Returns `truncated: true` when the underlying
 *  stream had more bytes than were read; the caller is responsible for
 *  surfacing the truncation to the user/LLM. */
async function collectStreamWithLimit(
  stream: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stream) {
    if (total >= limit) {
      truncated = true;
      break;
    }
    if (total + chunk.byteLength > limit) {
      const room = limit - total;
      chunks.push(chunk.subarray(0, room));
      total += room;
      truncated = true;
      break;
    }
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: out, truncated };
}
