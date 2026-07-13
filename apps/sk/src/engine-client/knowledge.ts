// Knowledge + discovery surfaces of the engine client: knowledge
// sources (incl. multipart create), discovery runs / artifacts, and the
// AI extraction endpoints that feed them. Method group merged into
// `EngineClient` by `../engine-client.ts`.

import { EngineError } from "@cli-core/errors.ts";
import type { EngineClient } from "../engine-client.ts";
import { parseResponseBody } from "./http.ts";

export const knowledgeMethods = {
  // -------------------- Knowledge Sources --------------------
  listKnowledgeSources(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/knowledge-sources", undefined, query);
  },
  searchKnowledge(
    this: EngineClient,
    q: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ hits: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/knowledge-sources/search", undefined, { q, ...query });
  },
  getKnowledgeSource(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/knowledge-sources/${encodeURIComponent(id)}`);
  },
  patchKnowledgeSource(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/knowledge-sources/${encodeURIComponent(id)}`, body);
  },
  analyzeKnowledgeSource(
    this: EngineClient,
    id: string,
    body: { force?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/knowledge-sources/${encodeURIComponent(id)}/analyze`, body);
  },
  deleteKnowledgeSource(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/knowledge-sources/${encodeURIComponent(id)}`);
  },
  createKnowledgeSource(
    this: EngineClient,
    file: { name: string; content: Buffer | Uint8Array; mime_type: string },
    metadata: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([file.content as unknown as ArrayBuffer], { type: file.mime_type }),
      file.name,
    );
    form.append("metadata", JSON.stringify({ name: file.name, ...metadata }));
    return this.requestForm("POST", "/v1/knowledge-sources", form);
  },

  // -------------------- Discovery --------------------
  listDiscoveryRuns(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/discovery/runs", undefined, query);
  },
  getDiscoveryRun(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/discovery/runs/${encodeURIComponent(id)}`);
  },
  listDiscoveryArtifacts(
    this: EngineClient,
    runId: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request(
      "GET",
      `/v1/discovery/runs/${encodeURIComponent(runId)}/artifacts`,
      undefined,
      query,
    );
  },
  approveDiscoveryArtifact(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/discovery/artifacts/${encodeURIComponent(id)}/approve`);
  },
  rejectDiscoveryArtifact(
    this: EngineClient,
    id: string,
    body: { reason?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/discovery/artifacts/${encodeURIComponent(id)}/reject`, body);
  },
  createDiscoveryRun(
    this: EngineClient,
    files: Array<{ name: string; content: Buffer | Uint8Array; mime_type: string }>,
    label?: string,
  ): Promise<Record<string, unknown>> {
    const form = new FormData();
    for (const f of files) {
      form.append(
        "files",
        new Blob([f.content as unknown as ArrayBuffer], { type: f.mime_type }),
        f.name,
      );
    }
    if (label) form.append("label", label);
    return this.requestForm("POST", "/v1/discovery/runs", form);
  },

  // -------------------- AI --------------------
  extract(
    this: EngineClient,
    body: { sample: string; hint?: string },
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/ai/extract", body);
  },

  /** Upload a raw file body to `POST /v1/extract` — used by `sk extract`
   *  when the input is a binary office document (PDF/DOCX/XLSX/PPTX).
   *  Bypasses the JSON `request()` helper because the body is bytes, not
   *  a JSON-serialisable object. */
  async extractFile(
    this: EngineClient,
    args: {
      buffer: Uint8Array;
      contentType: string;
      filename?: string;
    },
  ): Promise<Record<string, unknown>> {
    const traceId = this.newClientTraceId();
    const headers = this.headers(undefined, { traceId });
    headers["content-type"] = args.contentType;
    if (args.filename) headers["x-filename"] = args.filename;
    // fetch's typed BodyInit doesn't include Uint8Array on this
    // TypeScript target; widen via the underlying ArrayBuffer slice so
    // Bun and undici both accept the body without runtime conversion.
    const ab = args.buffer.buffer.slice(
      args.buffer.byteOffset,
      args.buffer.byteOffset + args.buffer.byteLength,
    ) as ArrayBuffer;
    const init: RequestInit = {
      method: "POST",
      headers,
      body: ab,
    };
    const res = await this.fetchImpl(`${this.base}/v1/extract`, init);
    const text = await res.text();
    const parsed = parseResponseBody(text);
    if (!res.ok) throw new EngineError(res.status, parsed);
    return (parsed ?? {}) as Record<string, unknown>;
  },
};
