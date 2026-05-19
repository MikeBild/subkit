// Binary file parser strategy + priority registry.
//
// Scoped to binary office formats only (PDF, DOCX, XLSX, PPTX). Text
// formats stay in `docs-ingestion/sources/file-upload.ts` and the
// `knowledge/parsers.ts` dispatcher; this module is invoked from those
// surfaces and the LLM `text_extract` path when the format hint matches
// a binary id.
//
// Priority semantics: lower runs first. GZIP/ZIP wrappers would sit at
// 1-2 but we don't unwrap them here — the docs-ingestion service refuses
// pre-compressed inputs. The two priority bands we use:
//
//   - ZIP_BASED_SPECIFIC (2): DOCX / XLSX / PPTX. Detected by walking
//     the ZIP central directory and matching `word/`, `xl/`, `ppt/`
//     entry prefixes. Must run before a generic ZIP detector would
//     classify the file as "just a ZIP".
//   - BINARY_SIGNATURE (10): PDF. Magic bytes `%PDF` (0x25 0x50 0x44 0x46).
//
// Registry is module-local; subsystem code calls `parseBinaryFile()` /
// `detectBinaryFormat()` from `./index.ts` and never imports this file
// directly.

export type BinaryFormat = "pdf" | "docx" | "xlsx" | "xls" | "pptx";

export enum DetectionPriority {
  ZIP_BASED_SPECIFIC = 2,
  BINARY_SIGNATURE = 10,
}

export interface FileParsingStrategy<TResult = unknown> {
  readonly format: BinaryFormat;
  readonly priority: DetectionPriority;
  canHandle(buffer: Buffer): boolean | Promise<boolean>;
  parse(buffer: Buffer): Promise<TResult>;
}

export class BinaryParseError extends Error {
  readonly format: BinaryFormat | null;
  constructor(format: BinaryFormat | null, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BinaryParseError";
    this.format = format;
  }
}

export class FileStrategyRegistry {
  private readonly strategies: FileParsingStrategy[] = [];

  register(s: FileParsingStrategy): void {
    this.strategies.push(s);
    this.strategies.sort((a, b) => a.priority - b.priority);
  }

  get(format: BinaryFormat): FileParsingStrategy | null {
    return this.strategies.find((s) => s.format === format) ?? null;
  }

  list(): readonly FileParsingStrategy[] {
    return this.strategies;
  }

  async detect(buffer: Buffer): Promise<BinaryFormat | null> {
    for (const s of this.strategies) {
      try {
        if (await s.canHandle(buffer)) return s.format;
      } catch {
        // canHandle failures are non-fatal — try the next strategy.
      }
    }
    return null;
  }
}
