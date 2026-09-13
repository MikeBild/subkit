// Files surfaces of the engine client — inline + authenticated streamed uploads,
// downloads, links, and stats. Method group merged into `EngineClient`
// by `../engine-client.ts`.

import { EngineError, TransportError } from "@cli-core/errors.ts";
import { z } from "zod";

import type { EngineClient } from "../engine-client.ts";
import { parseResponseBody } from "./http.ts";

// ---------- Files wire types ----------
// Mirror `apps/engine/src/api/files-schemas.ts`. Kept structural (not
// Zod) here so the CLI's tsc graph doesn't pull in @hono/zod-openapi.

export type FileStatusWire = "pending" | "uploading" | "scanning" | "ready" | "failed" | "expired";

export interface FileWire {
  id: string;
  status: FileStatusWire;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  sha256: string | null;
  scan_result: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface BatchCreateEntry {
  filename: string;
  content_type?: string;
  size_bytes: number;
  sha256?: string;
}

export interface BatchCreateRequest {
  files: BatchCreateEntry[];
}

export interface BatchCreateResponseEntry {
  id: string;
  upload_url: string;
  headers: Record<string, string>;
  expires_in: number;
  dedup: boolean;
}

export interface BatchCreateResponse {
  files: BatchCreateResponseEntry[];
}

export interface FileLinkWire {
  id: string;
  file_id: string;
  resource_type: string;
  resource_id: string;
  slug: string | null;
  role: string | null;
  created_at: string;
}

export interface FileStatsWire {
  total: number;
  by_status: Record<string, number>;
  by_size_bucket: Record<string, number>;
  dedup_hits: number;
  scan_verdicts: Record<string, number>;
}

/** Inline-upload cap + link-resource-type enum — re-exported from the
 *  shared constants module so the CLI cannot drift from the engine's
 *  413 threshold or link-target whitelist. Above the inline cap the
 *  CLI must use `batchCreateFiles` + the authenticated streamed upload helper
 *  (`putToPresignedUrl` is retained as its legacy method name) +
 *  `finalizeFile`; the resource-type tuple is consumed by
 *  `parseResourceRef` to reject bad `--link-to` / `--linked-to`
 *  values locally. */
export {
  FILE_LINK_RESOURCE_TYPES,
  type FileLinkResourceType,
  MAX_INLINE_BYTES,
} from "@shared/files-constants.ts";

// ---------- Files Zod schemas ----------
// Mirror `apps/engine/src/api/files-schemas.ts` so a server that breaks
// the wire shape (or a future engine that adds an unknown field
// interpreted by the wrong path) is rejected at the CLI boundary
// instead of smuggled through as a TS-shape-only crash inside the
// command handler. Pattern matches the conversations module's
// `ForkResponseSchema` — plain `zod`, no `@hono/zod-openapi` (CLI's
// tsc graph stays small).

const FileStatusWireSchema = z.enum([
  "pending",
  "uploading",
  "scanning",
  "ready",
  "failed",
  "expired",
]);

const FileWireSchema = z.object({
  id: z.string(),
  status: FileStatusWireSchema,
  filename: z.string(),
  content_type: z.string().nullable(),
  size_bytes: z.number(),
  sha256: z.string().nullable(),
  scan_result: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});

const BatchCreateResponseEntrySchema = z.object({
  id: z.string(),
  upload_url: z.string(),
  headers: z.record(z.string(), z.string()),
  expires_in: z.number(),
  dedup: z.boolean(),
});

const BatchCreateResponseSchema = z.object({
  files: z.array(BatchCreateResponseEntrySchema),
});

const FileLinkWireSchema = z.object({
  id: z.string(),
  file_id: z.string(),
  resource_type: z.string(),
  resource_id: z.string(),
  slug: z.string().nullable(),
  role: z.string().nullable(),
  created_at: z.string(),
});

const FileStatsWireSchema = z.object({
  total: z.number(),
  by_status: z.record(z.string(), z.number()),
  by_size_bucket: z.record(z.string(), z.number()),
  dedup_hits: z.number(),
  scan_verdicts: z.record(z.string(), z.number()),
});

const FileListResponseSchema = z.object({
  items: z.array(FileWireSchema),
  next_cursor: z.string().nullable().optional(),
});

export const filesMethods = {
  // -------------------- Files --------------------
  // Public file types — the wire shape matches
  // `apps/engine/src/api/files-schemas.ts`. We re-declare here rather
  // than reach into the engine package because the sk CLI is a separate
  // build with its own typecheck graph and the engine's Zod schemas
  // pull in the Hono runtime. The shape is verified by the engine's
  // unit tests; drift would surface as a Zod parse error at the route
  // boundary.

  /** Inline upload — wire shape of `POST /v1/files/inline`. */
  async uploadInline(
    this: EngineClient,
    file: {
      filename: string;
      content_type?: string;
      content_base64: string;
    },
  ): Promise<FileWire> {
    const raw = await this.request<unknown>("POST", "/v1/files/inline", file);
    return FileWireSchema.parse(raw);
  },

  /** Batch-create — issue authenticated engine PUT endpoints for files >5 MB. */
  async batchCreateFiles(
    this: EngineClient,
    req: BatchCreateRequest,
  ): Promise<BatchCreateResponse> {
    const raw = await this.request<unknown>("POST", "/v1/files/batch-create", req);
    return BatchCreateResponseSchema.parse(raw);
  },

  /** PUT bytes to an upload URL with progress callback. The legacy method
   *  name remains wire-compatible. Relative URLs target the authenticated
   *  engine endpoint; absolute URLs are supported for older engines. */
  async putToPresignedUrl(
    this: EngineClient,
    url: string,
    headers: Record<string, string>,
    body: BodyInit,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<void> {
    const isAbsolute = /^https?:\/\//i.test(url);
    const fullUrl = isAbsolute ? url : `${this.base}${url}`;
    // Bun's fetch supports `ReadableStream` bodies with `duplex: "half"`.
    // The progress callback fires from the byte-counter wrapper around
    // the stream, not from the response itself.
    // Relative upload endpoints are engine-authenticated and must carry the
    // profile bearer token. Never forward that credential to an absolute
    // third-party URL retained for compatibility with older engines.
    const requestHeaders = isAbsolute ? headers : this.headers(headers);
    const init: RequestInit & { duplex?: "half" } = {
      method: "PUT",
      headers: requestHeaders,
      body,
    };
    if (body instanceof ReadableStream) init.duplex = "half";
    let res: Response;
    try {
      res = await this.fetchImpl(fullUrl, init);
    } catch (cause) {
      throw new TransportError(cause);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new EngineError(res.status, parseResponseBody(text));
    }
    // Surface a final "complete" tick for callers wiring progress UIs.
    if (onProgress) onProgress(0, 0);
  },

  /** Finalize a streamed upload — server recomputes sha256 and
   *  rejects 422 on mismatch. */
  async finalizeFile(this: EngineClient, id: string, sha256: string): Promise<FileWire> {
    const raw = await this.request<unknown>(
      "POST",
      `/v1/files/${encodeURIComponent(id)}/finalize`,
      {
        sha256,
      },
    );
    return FileWireSchema.parse(raw);
  },

  /** Stream a file's bytes back from the engine. `range.start/end` are
   *  inclusive byte offsets; `range.end` omitted means "to the end". */
  async downloadFile(
    this: EngineClient,
    id: string,
    range?: { start: number; end?: number },
  ): Promise<{
    filename: string;
    content_type: string;
    size_bytes: number;
    stream: ReadableStream<Uint8Array>;
  }> {
    // First get metadata so the caller can show filename + size without
    // a second round-trip. The /content endpoint streams the bytes.
    const meta = await this.getFile(id);
    const headers: Record<string, string> = { accept: "*/*" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (this.tenant) headers["x-subkit-tenant"] = this.tenant;
    if (range) {
      const end = range.end !== undefined ? range.end : "";
      headers.range = `bytes=${range.start}-${end}`;
    }
    const url = `${this.base}/v1/files/${encodeURIComponent(id)}/content`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: "GET", headers });
    } catch (cause) {
      throw new TransportError(cause);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new EngineError(res.status, parseResponseBody(text));
    }
    if (!res.body) {
      throw new TransportError(new Error("download response has no body"));
    }
    return {
      filename: meta.filename,
      content_type: meta.content_type ?? "application/octet-stream",
      size_bytes: meta.size_bytes,
      stream: res.body,
    };
  },

  /** Paginated list. Cursor is opaque ISO timestamp issued by the engine. */
  async listFiles(
    this: EngineClient,
    query: { status?: string; linked_to?: string; cursor?: string; limit?: number } = {},
  ): Promise<{ items: FileWire[]; next_cursor?: string | null }> {
    const raw = await this.request<unknown>(
      "GET",
      "/v1/files",
      undefined,
      query as Record<string, string | number | undefined>,
    );
    const parsed = FileListResponseSchema.parse(raw);
    // `exactOptionalPropertyTypes`: project `next_cursor` to a value
    // that matches the declared `string | null` (not `| undefined`).
    return { items: parsed.items, next_cursor: parsed.next_cursor ?? null };
  },

  /** Get the file row. Returns soft-deleted rows during the cleanup
   *  cron's 7-day soft-delete grace so `sk files download` works
   *  briefly after `delete`. The list endpoint hides them. */
  async getFile(this: EngineClient, id: string): Promise<FileWire> {
    const raw = await this.request<unknown>("GET", `/v1/files/${encodeURIComponent(id)}`);
    return FileWireSchema.parse(raw);
  },

  /** Soft-delete. Subsequent `getFile` may still return during the
   *  in-flight grace window; the cleanup cron hard-deletes after 7d. */
  deleteFile(this: EngineClient, id: string): Promise<void> {
    return this.request<void>("DELETE", `/v1/files/${encodeURIComponent(id)}`);
  },

  /** Attach a file to an owning resource. Idempotent on
   *  `(resource_type, resource_id, slug)`. */
  async linkFile(
    this: EngineClient,
    file_id: string,
    link: {
      resource_type:
        | "conversation"
        | "knowledge_source"
        | "skill"
        | "connector"
        | "workflow_run"
        | "discovery_run";
      resource_id: string;
      slug?: string;
      role?: string;
    },
  ): Promise<FileLinkWire> {
    const raw = await this.request<unknown>(
      "POST",
      `/v1/files/${encodeURIComponent(file_id)}/links`,
      link,
    );
    return FileLinkWireSchema.parse(raw);
  },

  /** Aggregate counters. Cheap — bounded by tenant's row count. */
  async getFileStats(this: EngineClient): Promise<FileStatsWire> {
    const raw = await this.request<unknown>("GET", "/v1/files/stats");
    return FileStatsWireSchema.parse(raw);
  },
};
