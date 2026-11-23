import { logger } from "../../logging/index.ts";
import { getMetrics, METRIC_NAMES } from "../../observability/metrics.ts";
import { instrument } from "../../observability/runtime-telemetry.ts";
import { runSandboxWorkerJob } from "../../sandboxes/quickjs/runtime.ts";
import { type ArchiveParseOutput, makeArchiveStrategies } from "./archive.ts";
import { type CsvRowsResult, parseCsvRows } from "./csv.ts";
import { type DocxParseOutput, docxStrategy } from "./docx.ts";
import { type PdfParseOutput, pdfStrategy } from "./pdf.ts";
import { type PptxParseOutput, pptxStrategy } from "./pptx.ts";
import {
  type BinaryFormat,
  BinaryParseError,
  FileStrategyRegistry,
  PARSER_TIMEOUT_MS,
} from "./strategy.ts";
import { type XlsxParseOutput, xlsStrategy, xlsxStrategy } from "./xlsx.ts";

export type {
  ArchiveEntry,
  ArchiveParseOutput,
  ArchiveSkip,
} from "./archive.ts";
export type { CsvRowError, CsvRowsResult } from "./csv.ts";
export { parseCsvRows } from "./csv.ts";
export type { DocxParseOutput } from "./docx.ts";
export type { PdfParseOutput } from "./pdf.ts";
export { PDF_PAGE_SEPARATOR } from "./pdf.ts";
export type { PptxParseOutput, PptxSlide } from "./pptx.ts";
export type { BinaryFormat, FileParsingStrategy } from "./strategy.ts";
export { BinaryParseError } from "./strategy.ts";
export type { XlsxFormat, XlsxParseOutput } from "./xlsx.ts";

type BinaryParseResult =
  | PdfParseOutput
  | DocxParseOutput
  | XlsxParseOutput
  | PptxParseOutput
  | ArchiveParseOutput;

type BinaryParseResultFor<F extends BinaryFormat> = F extends "pdf"
  ? PdfParseOutput
  : F extends "docx"
    ? DocxParseOutput
    : F extends "xlsx" | "xls"
      ? XlsxParseOutput
      : F extends "pptx"
        ? PptxParseOutput
        : F extends "zip" | "gzip"
          ? ArchiveParseOutput
          : never;

export const BINARY_FORMATS = new Set<BinaryFormat>([
  "pdf",
  "docx",
  "xlsx",
  "xls",
  "pptx",
  "zip",
  "gzip",
]);

export function isBinaryFormat(format: string): format is BinaryFormat {
  return BINARY_FORMATS.has(format as BinaryFormat);
}

export function renderBinaryParseResult(parsed: BinaryParseResult): string {
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
    case "zip":
    case "gzip":
      return parsed.text;
  }
}

const registry = new FileStrategyRegistry();
registry.register(pdfStrategy);
registry.register(docxStrategy);
registry.register(xlsxStrategy);
registry.register(xlsStrategy);
registry.register(pptxStrategy);
const { zipStrategy, gzipStrategy } = makeArchiveStrategies({
  detect: (buffer) => detectBinaryFormat(buffer),
  parse: (buffer, format) => parseBinaryFile(buffer, format),
  render: (parsed) => renderBinaryParseResult(parsed as BinaryParseResult),
});
registry.register(zipStrategy);
registry.register(gzipStrategy);

export async function detectBinaryFormat(buffer: Buffer): Promise<BinaryFormat | null> {
  return registry.detect(buffer);
}

export async function parseBinaryFile<F extends BinaryFormat>(
  buffer: Buffer,
  format: F,
): Promise<BinaryParseResultFor<F>> {
  if (!process.argv.includes("--sandbox-worker")) {
    return parseBinaryFileInWorker(buffer, format);
  }
  return parseBinaryFileInCurrentProcess(buffer, format);
}

export async function parseBinaryFileInCurrentProcess<F extends BinaryFormat>(
  buffer: Buffer,
  format: F,
): Promise<BinaryParseResultFor<F>> {
  const strategy = registry.get(format);
  if (!strategy) {
    throw new BinaryParseError(format, `no strategy registered for ${format}`);
  }
  const metrics = getMetrics();
  metrics.inc(METRIC_NAMES.DOCS_BINARY_PARSE_INPUT_BYTES_TOTAL, { format }, buffer.byteLength);
  try {
    const result = (await instrument({
      module: "docs-ingestion",
      action: "binary_parse",
      memory: true,
      fields: { format, bytes: buffer.byteLength },
      fn: () => strategy.parse(buffer),
    })) as BinaryParseResultFor<F>;
    metrics.inc(METRIC_NAMES.DOCS_BINARY_PARSE_TOTAL, { format, result: "success" });
    return result;
  } catch (err) {
    metrics.inc(METRIC_NAMES.DOCS_BINARY_PARSE_TOTAL, { format, result: "error" });
    logger.warn({
      module: "docs_ingestion.binary_parsers",
      action: "parse_failed",
      format,
      bytes: buffer.byteLength,
      error: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof BinaryParseError) throw err;
    throw new BinaryParseError(format, `${format}: ${(err as Error).message}`, { cause: err });
  }
}

async function parseBinaryFileInWorker<F extends BinaryFormat>(
  buffer: Buffer,
  format: F,
): Promise<BinaryParseResultFor<F>> {
  if (buffer.byteLength > 32 * 1024 * 1024) {
    throw new BinaryParseError(format, `${format}: parser input exceeds worker transport limit`);
  }
  try {
    return await runSandboxWorkerJob<BinaryParseResultFor<F>>({
      op: "parse_binary",
      format,
      buffer: buffer.toString("base64"),
      wall_ms: PARSER_TIMEOUT_MS[format],
    });
  } catch (err) {
    throw new BinaryParseError(
      format,
      err instanceof Error ? err.message : "Parser worker failed",
      { cause: err },
    );
  }
}

export const CSV_PARSER_TIMEOUT_MS = 60_000;

export async function parseCsvFile(
  buffer: Buffer,
  options: { max_rows: number; signal?: AbortSignal },
): Promise<CsvRowsResult> {
  if (process.argv.includes("--sandbox-worker")) {
    return parseCsvRows(buffer, { max_rows: options.max_rows });
  }
  if (buffer.byteLength > 32 * 1024 * 1024) {
    throw new Error("csv: parser input exceeds worker transport limit");
  }
  return runSandboxWorkerJob<CsvRowsResult>({
    op: "parse_csv",
    buffer: buffer.toString("base64"),
    max_rows: options.max_rows,
    wall_ms: CSV_PARSER_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
