export type DocSourceType =
  | "openapi"
  | "google_discovery"
  | "markdown"
  | "llms_txt"
  | "graphql"
  | "postgres"
  | "file_upload"
  | "cascade";

export interface RawChunk {
  title?: string | null;
  path?: string | null;
  content: string;
}

export interface FingerprintedChunk extends RawChunk {
  byte_size: number;
  fingerprint: string;
  shingles: Set<number>;
  truncated?: boolean;
}

export interface IngestSourceInput {
  source_type: DocSourceType;
  url?: string;
  content?: string;
  schemas?: string[];
  upload?: {
    buffer: Buffer | Uint8Array | string;
    filename?: string;
    mime?: string;
  };
}

export interface IngestResult {
  document_id: string | null;
  ingested_count: number;
  skipped_count: number;
  total_bytes: number;
  budget_exceeded: boolean;
  source_type: DocSourceType;
  source_uri: string;
}

export interface BudgetState {
  bytes_used: number;
  links_followed: number;
  specs_fetched: number;
  budget_exceeded: boolean;
  warnings?: string[];
}

export class NotImplementedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "NotImplementedError";
  }
}

export class DocumentSourceCredentialsError extends Error {
  constructor() {
    super(
      "Use a public documentation URL without embedded credentials, or upload the documentation content.",
    );
    this.name = "DocumentSourceCredentialsError";
  }
}
