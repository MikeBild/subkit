// Public facade for the binary file parsers (PDF, DOCX, XLSX/XLS, PPTX).
//
// All other subsystems (`docs-ingestion/sources/file-upload.ts`,
// `knowledge/parsers.ts`, `llm/core/file-context.ts`,
// `http/routes/ai/extract.ts`, `apps/sk/src/commands/extract.ts`)
// import from here so format dispatch stays in one place.
//
// Each call records two counters defined in `observability/metrics.ts`:
//   - `subkit_docs_binary_parse_total{format,result}` — increments per
//     attempt; `result` is `success` or `error`.
//   - `subkit_docs_binary_parse_bytes_total{format}` — input byte volume
//     attempted (success or error), so operators can chart per-format
//     throughput.
//
// Failures raise a typed `BinaryParseError` carrying the format id. The
// caller maps it to its own surface's error envelope (HTTP 400, queue
// retry, etc.). No silent fallback to placeholder text here — the
// caller (e.g. `assembleTextExtractBlock`) decides whether a parser
// failure should crash the turn or degrade to a placeholder block.

import { logger } from "../../logging/logger.ts";
import { getMetrics, METRIC_NAMES } from "../../observability/metrics.ts";
import { type DocxParseOutput, docxStrategy } from "./docx.ts";
import { type PdfParseOutput, pdfStrategy } from "./pdf.ts";
import { type PptxParseOutput, pptxStrategy } from "./pptx.ts";
import { type BinaryFormat, BinaryParseError, FileStrategyRegistry } from "./strategy.ts";
import { type XlsxParseOutput, xlsStrategy, xlsxStrategy } from "./xlsx.ts";

export type { DocxParseOutput } from "./docx.ts";
export type { PdfParseOutput } from "./pdf.ts";
export { PDF_PAGE_SEPARATOR } from "./pdf.ts";
export type { PptxParseOutput, PptxSlide } from "./pptx.ts";
export type { BinaryFormat, FileParsingStrategy } from "./strategy.ts";
export { BinaryParseError } from "./strategy.ts";
export type { XlsxFormat, XlsxParseOutput } from "./xlsx.ts";

export type BinaryParseResult =
  | PdfParseOutput
  | DocxParseOutput
  | XlsxParseOutput
  | PptxParseOutput;

const registry = new FileStrategyRegistry();
registry.register(pdfStrategy);
registry.register(docxStrategy);
registry.register(xlsxStrategy);
registry.register(xlsStrategy);
registry.register(pptxStrategy);

/** Sniff the buffer header for a known binary format. Returns null when
 *  no strategy matches — caller falls back to text/structured handling. */
export async function detectBinaryFormat(buffer: Buffer): Promise<BinaryFormat | null> {
  return registry.detect(buffer);
}

/** Parse a buffer through the named strategy. Throws `BinaryParseError`
 *  on any parser failure. */
export async function parseBinaryFile(
  buffer: Buffer,
  format: BinaryFormat,
): Promise<BinaryParseResult> {
  const strategy = registry.get(format);
  if (!strategy) {
    throw new BinaryParseError(format, `no strategy registered for ${format}`);
  }
  const metrics = getMetrics();
  metrics.inc(METRIC_NAMES.DOCS_BINARY_PARSE_BYTES_TOTAL, { format }, buffer.byteLength);
  try {
    const result = (await strategy.parse(buffer)) as BinaryParseResult;
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
