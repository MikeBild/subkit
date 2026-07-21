// Canonical types used across the documentation ingestion pipeline.
//
// The pipeline fetches raw bytes from a source, normalizes them into a
// flat list of chunks, deduplicates within the run, and writes them into
// connector_documents + connector_document_chunks. Every stage passes
// the same shapes so the orchestrator never branches on source kind.

export type DocSourceType =
  | "openapi"
  | "google_discovery"
  | "markdown"
  | "llms_txt"
  | "graphql"
  | "postgres"
  | "file_upload"
  | "cascade";

/** A pre-write chunk: the normalizer emits these, the service persists them. */
export interface RawChunk {
  title?: string | null;
  path?: string | null;
  content: string;
}

/** A chunk after fingerprinting — carries dedup state. */
export interface FingerprintedChunk extends RawChunk {
  byte_size: number;
  fingerprint: string;
  shingles: Set<number>;
  /** Set when the chunker had to trim a single chunk over the per-page cap. */
  truncated?: boolean;
}

/** Input to `ingest(...)`. Exactly one of `url` / `content` must be present. */
export interface IngestSourceInput {
  source_type: DocSourceType;
  url?: string;
  content?: string;
  /** For postgres source: optional schema list (default ["public"]). */
  schemas?: string[];
  /** For file_upload source. */
  upload?: {
    buffer: Buffer | Uint8Array | string;
    filename?: string;
    mime?: string;
  };
}

/** Result of an ingest run — surfaced on the HTTP response and job log. */
export interface IngestResult {
  document_id: string | null;
  ingested_count: number;
  skipped_count: number;
  total_bytes: number;
  budget_exceeded: boolean;
  source_type: DocSourceType;
  source_uri: string;
}

/**
 * Budget enforcement snapshot. The orchestrator passes one of these into
 * every fetch / chunk callback so nested helpers can refuse new work as
 * soon as any of the caps trip.
 */
export interface BudgetState {
  bytes_used: number;
  links_followed: number;
  specs_fetched: number;
  budget_exceeded: boolean;
  /** Soft warnings the chunker / link follower attach as caps are hit. */
  warnings?: string[];
}

export class NotImplementedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "NotImplementedError";
  }
}
