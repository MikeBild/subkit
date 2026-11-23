import { detectBinaryFormat, parseBinaryFile, parseTableFile } from "../../docs-ingestion/index.ts";
import type { ResolvedFile } from "../../files/index.ts";
import type { TransformStep } from "../../workflows/index.ts";
import { SYSTEM_CLOCK } from "../clock.ts";
import {
  PARSE_FILE_FAILED,
  type ParsedFile,
  type ParseFileDecision,
  type ParseFileFailure,
  type ParseFileFormat,
  parseFileFormat,
  parseFileOutput,
  parseFileRowLimit,
  parseFileSizeRefusal,
  parseFileSource,
  parseFileTable,
} from "../core/parse-file.ts";
import type { StepResult, StepRunContext } from "../types.ts";

interface RunParseFileParams {
  ctx: StepRunContext;
  step: TransformStep;
  scope: Record<string, unknown>;
  input: unknown;
}

async function readAll(file: ResolvedFile): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of await file.openRead()) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function parse(
  format: ParseFileFormat,
  bytes: Buffer,
  table: { max_rows: number; sheet: string | undefined; signal: AbortSignal },
): Promise<ParseFileDecision<ParsedFile>> {
  if (format === "csv" || format === "xlsx") {
    return parseFileTable(await parseTableFile(bytes, { format, ...table }), table.sheet);
  }
  const parsed = await parseBinaryFile(bytes, format);
  return { ok: true, value: parsed as ParsedFile };
}

export async function runParseFile(p: RunParseFileParams): Promise<StepResult> {
  const clock = p.ctx.clock ?? SYSTEM_CLOCK;
  const start = clock.now();
  const failed = (failure: ParseFileFailure): StepResult => ({
    status: "failed",
    retry_count: 0,
    duration_ms: Math.max(0, clock.now() - start),
    error: {
      code: failure.code,
      message: failure.message,
      ...(failure.details ? { details: failure.details } : {}),
    },
  });
  const config = p.step.file;
  if (!config) return failed({ code: PARSE_FILE_FAILED, message: "parse-file needs a file block" });
  const source = parseFileSource({ ...p.scope, $input: p.input }, config.source);
  if (!source.ok) return failed(source.failure);
  try {
    const { walkAndResolve } = await import("../../files/index.ts");
    const file = await walkAndResolve(
      { $file: source.value },
      { db: p.ctx.db, tenant_id: p.ctx.tenant_id, resolve_references: true },
      new Map(),
    );
    const resolved = file as unknown as ResolvedFile;
    const tooLarge = parseFileSizeRefusal(resolved.size_bytes);
    if (tooLarge) return failed(tooLarge);
    const bytes = await readAll(resolved);
    const format = parseFileFormat({
      declared: config.format,
      filename: resolved.filename,
      content_type: resolved.content_type,
      detected: config.format ? null : await detectBinaryFormat(bytes),
    });
    if (!format.ok) return failed(format.failure);
    const parsed = await parse(format.value, bytes, {
      max_rows: parseFileRowLimit(config.max_rows),
      sheet: config.sheet,
      signal: p.ctx.signal,
    });
    if (!parsed.ok) return failed(parsed.failure);
    const output = parseFileOutput(parsed.value, {
      filename: resolved.filename,
      max_rows: config.max_rows,
    });
    if (!output.ok) return failed(output.failure);
    return {
      status: "succeeded",
      output: output.value,
      retry_count: 0,
      duration_ms: Math.max(0, clock.now() - start),
    };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return failed({
      code: code === "file_not_found" ? "file_not_found" : PARSE_FILE_FAILED,
      message: `The file could not be read: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
