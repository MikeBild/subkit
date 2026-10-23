import { EngineError, TransportError } from "@cli-core/errors.ts";
import { z } from "zod";
import type { EngineClient } from "../engine-client.ts";
import { parseResponseBody } from "./http.ts";

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

export interface FileVersionWire {
  version: number;
  current: boolean;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  sha256: string | null;
  restored_from: number | null;
  uploaded_at: string;
  uploaded_by: { kind: "user" | "system_account"; id: string } | null;
  replaced_at: string | null;
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

export {
  FILE_LINK_RESOURCE_TYPES,
  type FileLinkResourceType,
  MAX_INLINE_BYTES,
} from "@shared/files-constants.ts";

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

const FileVersionListSchema = z.object({
  items: z.array(
    z.object({
      version: z.number(),
      current: z.boolean(),
      filename: z.string(),
      content_type: z.string().nullable(),
      size_bytes: z.number(),
      sha256: z.string().nullable(),
      restored_from: z.number().nullable(),
      uploaded_at: z.string(),
      uploaded_by: z
        .object({ kind: z.enum(["user", "system_account"]), id: z.string() })
        .nullable(),
      replaced_at: z.string().nullable(),
    }),
  ),
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

  async batchCreateFiles(
    this: EngineClient,
    req: BatchCreateRequest,
  ): Promise<BatchCreateResponse> {
    const raw = await this.request<unknown>("POST", "/v1/files/batch-create", req);
    return BatchCreateResponseSchema.parse(raw);
  },

  async putUploadBytes(
    this: EngineClient,
    url: string,
    headers: Record<string, string>,
    body: BodyInit,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<void> {
    const fullUrl = `${this.base}${url}`;
    const init: RequestInit & { duplex?: "half" } = {
      method: "PUT",
      headers: this.headers(headers),
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
    if (onProgress) onProgress(0, 0);
  },

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
    return { items: parsed.items, next_cursor: parsed.next_cursor ?? null };
  },

  async getFile(this: EngineClient, id: string): Promise<FileWire> {
    const raw = await this.request<unknown>("GET", `/v1/files/${encodeURIComponent(id)}`);
    return FileWireSchema.parse(raw);
  },

  async replaceFile(
    this: EngineClient,
    id: string,
    file: { filename: string; content_type?: string; content_base64: string },
  ): Promise<FileWire> {
    const raw = await this.request<unknown>(
      "POST",
      `/v1/files/${encodeURIComponent(id)}/replace`,
      file,
    );
    return FileWireSchema.parse(raw);
  },

  async listFileVersions(this: EngineClient, id: string): Promise<FileVersionWire[]> {
    const raw = await this.request<unknown>("GET", `/v1/files/${encodeURIComponent(id)}/versions`);
    return FileVersionListSchema.parse(raw).items;
  },

  async restoreFileVersion(this: EngineClient, id: string, version: number): Promise<FileWire> {
    const raw = await this.request<unknown>(
      "POST",
      `/v1/files/${encodeURIComponent(id)}/versions/${version}/restore`,
    );
    return FileWireSchema.parse(raw);
  },

  deleteFile(this: EngineClient, id: string): Promise<void> {
    return this.request<void>("DELETE", `/v1/files/${encodeURIComponent(id)}`);
  },

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

  async getFileStats(this: EngineClient): Promise<FileStatsWire> {
    const raw = await this.request<unknown>("GET", "/v1/files/stats");
    return FileStatsWireSchema.parse(raw);
  },
};
