// LLM file-context assembly.
//
// Given a list of `$file` refs surfacing in a conversation turn, this
// module routes each file through the canonical `chooseFileStrategy`
// decision tree in `capabilities.ts` and produces a typed content block
// per strategy:
//
//   - `file_part`   — load the bytes, base64-encode, emit an inline
//                     content block. Hard per-turn cap of 250 KiB total
//                     inline bytes; once a turn crosses the cap, every
//                     subsequent file is forced to `text_extract`.
//   - `text_extract` — load the bytes, run the knowledge-source parser,
//                      emit a text block. The fallback when the inline
//                      path isn't viable (oversized, unsupported media,
//                      or per-turn inline budget exhausted).
//
// There is deliberately NO provider Files-API upload path — customer
// files never leave subkit's own object store; the provider only sees
// transient inline request bytes. See `chooseFileStrategy` for the
// rationale.
//
// Reuses the exact decision tree exposed by `capabilities.ts`. No
// parallel strategy ladder lives here — any new file routing rule
// belongs in `chooseFileStrategy` so every consumer (this module, the
// HTTP /v1/files/inline path, the connector preview) agrees on the
// answer. Tenant isolation is preserved at the resolver seam — every
// fid we touch routes through `walkAndResolve` / `requireFileForTenant`.
//
// The `subkit_files_llm_inline_bytes_total` metric is fed from the
// `inline_bytes` counter this module exposes — see the observability
// ladder under `apps/engine/src/observability/`.

import { sanitizeForAudit } from "../../audit/index.ts";
import type { Db } from "../../db/client.ts";
import {
  type BinaryFormat,
  BinaryParseError,
  parseBinaryFile,
  renderBinaryParseResult,
} from "../../docs-ingestion/parsers/index.ts";
import { type ResolvedFile, resolveSingleFid } from "../../files/resolver.ts";
import { detectFormat, isBinaryFormat, parseFileToChunks } from "../../knowledge/parsers.ts";
import { logger } from "../../logging/logger.ts";
import { chooseFileStrategy, type ModelCapabilities } from "./capabilities.ts";

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

/** Discriminated union for one assembled content block. */
export type FileContentBlock =
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

export interface BuildFileContentBlocksParams {
  db: Db;
  tenant_id: string;
  capabilities: ModelCapabilities;
  /** Wire-format file ids (`fid_<uuid>`) — typically extracted from
   *  the user message (`[file:fid_...]` sentinel) or from the
   *  conversation's linked attachments. The resolver enforces tenant
   *  scope; cross-tenant fids throw `FileNotFoundError`. */
  fids: string[];
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
 * through `chooseFileStrategy`, performs the side effects (reads,
 * parses), and returns the typed blocks plus per-turn accounting. The
 * caller decides how to splice the blocks into the model-message array.
 */
export async function buildFileContentBlocks(
  p: BuildFileContentBlocksParams,
): Promise<BuildFileContentBlocksResult> {
  const blocks: FileContentBlock[] = [];
  let inline_bytes = 0;
  let inline_cap_downgrades = 0;
  // Per-turn `text_extract` budget. Tracked separately from
  // `inline_bytes` because the two strategies have different cost
  // models: `file_part` ships raw bytes (LLM has its own image / PDF
  // tokeniser), while `text_extract` lands as plain text directly in
  // the context window — so much smaller files still dwarf the budget.
  let text_extract_bytes = 0;

  // Resolve each fid through the tenant-isolation chokepoint (with a
  // shared cache so repeated refs in the same turn pay one DB hit).
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

    let strategy = chooseFileStrategy(p.capabilities, resolved.size_bytes, resolved.content_type);

    // Per-turn inline budget guard — once we'd exceed the cap, the
    // next file that would have chosen `file_part` downgrades to
    // `text_extract` (counted for telemetry).
    if (
      strategy === "file_part" &&
      inline_bytes + resolved.size_bytes > FILE_PART_PER_TURN_CAP_BYTES
    ) {
      strategy = "text_extract";
      inline_cap_downgrades += 1;
    }

    if (strategy === "file_part") {
      const block = await assembleFilePartBlock(resolved);
      if (block && block.strategy === "file_part") {
        blocks.push(block);
        inline_bytes += block.data.byteLength;
        continue;
      }
      // Byte read failed — fall through to text_extract placeholder.
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
  let truncated: boolean;
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
  format: BinaryFormat,
  budget: { perTurnBudgetRemaining: number },
): Promise<{ block: FileContentBlock; bytes_read: number }> {
  const contentType = resolved.content_type ?? "application/octet-stream";
  const placeholderText = `[file: ${resolved.filename}]`;
  // Defence-in-depth: `assembleTextExtractBlock` (the only caller)
  // already returns early on an exhausted per-turn budget *before*
  // the `isBinaryFormat` branch reaches here. This re-check guards
  // against a future caller wiring this helper in without that
  // guard — the parser would otherwise do up to 25 MB of work whose
  // output we'd clamp to zero anyway.
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
    // `format` is already narrowed to `BinaryFormat` by the
    // `isBinaryFormat(detectedFormat)` predicate at the call site
    // (`assembleTextExtractBlock`), so no cast is needed.
    const parsed = await parseBinaryFile(buffer, format);
    parsedText = renderBinaryParseResult(parsed);
  } catch (err) {
    const rawCause = err instanceof BinaryParseError ? err.message : String(err);
    const cause = sanitizeForAudit(rawCause);
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
        // `cause` is sanitized (length-capped, control chars stripped)
        // because the parser library's verbatim message can echo a
        // small slice of user-controlled input that would otherwise
        // land directly in the model's prompt.
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
