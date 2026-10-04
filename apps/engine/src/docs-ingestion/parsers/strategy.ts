export type BinaryFormat = "pdf" | "docx" | "xlsx" | "xls" | "pptx" | "zip" | "gzip";

export enum DetectionPriority {
  COMPRESSED_WRAPPER = 1,
  ZIP_BASED_SPECIFIC = 2,
  BINARY_SIGNATURE_LEGACY = 5,
  BINARY_SIGNATURE = 10,
  GENERIC_CONTAINER = 20,
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

export function withParserTimeout<T>(
  format: BinaryFormat,
  workMs: number,
  work: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new BinaryParseError(format, `${format}: parser timed out after ${workMs}ms`));
    }, workMs);
    timer.unref?.();
    work().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export const PARSER_TIMEOUT_MS: Record<BinaryFormat, number> = {
  pdf: 30_000,
  docx: 30_000,
  xlsx: 60_000,
  xls: 60_000,
  pptx: 30_000,
  zip: 120_000,
  gzip: 60_000,
};

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
      } catch {}
    }
    return null;
  }
}
