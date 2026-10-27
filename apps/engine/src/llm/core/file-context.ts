import { sanitizeForAudit } from "../../audit/index.ts";
import type { Db } from "../../db/client.ts";
import {
  type BinaryFormat,
  BinaryParseError,
  parseBinaryFile,
  renderBinaryParseResult,
} from "../../docs-ingestion/parsers/index.ts";
import { executionDataFileIds } from "../../files/model-context.ts";
import { type ResolvedFile, resolveSingleFid } from "../../files/resolver.ts";
import { detectFormat, isBinaryFormat, parseFileToChunks } from "../../knowledge/parsers.ts";
import { logger } from "../../logging/logger.ts";
import { chooseFileStrategy, type ModelCapabilities } from "./capabilities.ts";

export const FILE_PART_PER_TURN_CAP_BYTES = 250 * 1024;

export const TEXT_EXTRACT_PER_FILE_MAX_BYTES = 1024 * 1024;

export const TEXT_EXTRACT_BINARY_PER_FILE_MAX_BYTES = 25 * 1024 * 1024;

export const TEXT_EXTRACT_PER_TURN_CAP_BYTES = 4 * 1024 * 1024;

export type FileContentBlock =
  | {
      strategy: "file_part";
      filename: string;
      content_type: string;
      mediaType: string;
      data: Uint8Array;
    }
  | {
      strategy: "text_extract";
      filename: string;
      content_type: string;
      text: string;
      placeholder: boolean;
    };

export interface BuildFileContentBlocksParams {
  db: Db;
  tenant_id: string;
  capabilities: ModelCapabilities;
  fids: string[];
}

export interface BuildFileContentBlocksResult {
  blocks: FileContentBlock[];
  inline_bytes: number;
  inline_cap_downgrades: number;
}

export async function buildFileContentBlocks(
  p: BuildFileContentBlocksParams,
): Promise<BuildFileContentBlocksResult> {
  const blocks: FileContentBlock[] = [];
  let inline_bytes = 0;
  let inline_cap_downgrades = 0;
  let text_extract_bytes = 0;

  const resolveCache = new Map<string, ResolvedFile>();
  const executionData = await executionDataFileIds(p.db, p.tenant_id, p.fids);
  for (const fid of p.fids) {
    if (executionData.has(fid.replace(/^fid_/, ""))) continue;
    let resolved: ResolvedFile;
    try {
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
      strategy = "text_extract";
    }

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

  const detectedFormat = detectFormat(resolved.filename, resolved.content_type ?? undefined);
  if (isBinaryFormat(detectedFormat)) {
    return assembleBinaryTextExtractBlock(resolved, detectedFormat, budget);
  }

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

async function assembleBinaryTextExtractBlock(
  resolved: ResolvedFile,
  format: BinaryFormat,
  budget: { perTurnBudgetRemaining: number },
): Promise<{ block: FileContentBlock; bytes_read: number }> {
  const contentType = resolved.content_type ?? "application/octet-stream";
  const placeholderText = `[file: ${resolved.filename}]`;
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
