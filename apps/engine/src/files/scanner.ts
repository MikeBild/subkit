export interface ScanResult {
  verdict: "clean" | "infected" | "timeout";
  engine: string;
  signature?: string;
}

export interface ScanMeta {
  content_type?: string | null;
  filename: string;
}

export interface FileScanner {
  scan(stream: AsyncIterable<Uint8Array>, meta: ScanMeta): Promise<ScanResult>;
}

export const SCANNER_TIMEOUT_SECONDS = 10;

export const NoopScanner: FileScanner = {
  async scan(_stream, _meta) {
    return { verdict: "clean", engine: "noop" };
  },
};

export function getScanner(): FileScanner {
  return NoopScanner;
}
