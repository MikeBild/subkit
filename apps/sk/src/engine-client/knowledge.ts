import { EngineError } from "@cli-core/errors.ts";
import type { EngineClient } from "../engine-client.ts";
import { type ApiBody, type ApiQuery, parseResponseBody } from "./http.ts";

export const knowledgeMethods = {
  async listKnowledgeSources(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/knowledge-sources", {
      params: { query: query as ApiQuery<"/v1/knowledge-sources", "get"> },
    });
    return data as { items: Record<string, unknown>[] };
  },
  async searchKnowledge(
    this: EngineClient,
    q: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ hits: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/knowledge-sources/search", {
      params: { query: { q, ...query } as ApiQuery<"/v1/knowledge-sources/search", "get"> },
    });
    return data as { hits: Record<string, unknown>[] };
  },
  async getKnowledgeSource(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.GET("/v1/knowledge-sources/{id}", { params: { path: { id } } });
    return data as Record<string, unknown>;
  },
  async patchKnowledgeSource(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.PATCH("/v1/knowledge-sources/{id}", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/knowledge-sources/{id}", "patch">,
    });
    return data as Record<string, unknown>;
  },
  async analyzeKnowledgeSource(
    this: EngineClient,
    id: string,
    body: { force?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/knowledge-sources/{id}/analyze", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/knowledge-sources/{id}/analyze", "post">,
    });
    return data as Record<string, unknown>;
  },
  async deleteKnowledgeSource(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/knowledge-sources/{id}", { params: { path: { id } } });
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

  async importKnowledgeBundle(
    this: EngineClient,
    body: {
      name: string;
      slug?: string;
      description?: string;
      category?: string;
      tags?: string[];
      scope?: string;
      workflow_id?: string;
      files: { path: string; content: string }[];
    },
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/knowledge-sources/bundle", {
      body: body as ApiBody<"/v1/knowledge-sources/bundle", "post">,
    });
    return data as Record<string, unknown>;
  },
  async knowledgeHistory(
    this: EngineClient,
    id: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const { data } = await this.api.GET("/v1/knowledge-sources/{id}/history", {
      params: {
        path: { id },
        query: query as ApiQuery<"/v1/knowledge-sources/{id}/history", "get">,
      },
    });
    return data as { items: Record<string, unknown>[]; total: number };
  },
  async restoreKnowledgeVersion(
    this: EngineClient,
    id: string,
    version: number,
  ): Promise<{ knowledge_source: Record<string, unknown>; version: number }> {
    const { data } = await this.api.POST("/v1/knowledge-sources/{id}/restore/{version}", {
      params: { path: { id, version } },
    });
    return data as { knowledge_source: Record<string, unknown>; version: number };
  },
  async listKnowledgeChunks(
    this: EngineClient,
    id: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.GET("/v1/knowledge-sources/{id}/chunks", {
      params: {
        path: { id },
        query: query as ApiQuery<"/v1/knowledge-sources/{id}/chunks", "get">,
      },
    });
    return data as Record<string, unknown>;
  },

  async listDiscoveryRuns(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/discovery/runs", {
      params: { query: query as ApiQuery<"/v1/discovery/runs", "get"> },
    });
    return data as { items: Record<string, unknown>[] };
  },
  async getDiscoveryRun(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.GET("/v1/discovery/runs/{id}", { params: { path: { id } } });
    return data as Record<string, unknown>;
  },
  async listDiscoveryArtifacts(
    this: EngineClient,
    runId: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/discovery/runs/{id}/artifacts", {
      params: {
        path: { id: runId },
        query: query as ApiQuery<"/v1/discovery/runs/{id}/artifacts", "get">,
      },
    });
    return data as { items: Record<string, unknown>[] };
  },
  async approveDiscoveryArtifact(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/discovery/artifacts/{id}/approve", {
      params: { path: { id } },
    });
    return data as Record<string, unknown>;
  },
  async rejectDiscoveryArtifact(
    this: EngineClient,
    id: string,
    body: { reason?: string } = {},
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/discovery/artifacts/{id}/reject", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/discovery/artifacts/{id}/reject", "post">,
    });
    return data as Record<string, unknown>;
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

  async extract(
    this: EngineClient,
    body: { sample: string; hint?: string },
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/ai/extract", {
      body: body as ApiBody<"/v1/ai/extract", "post">,
    });
    return data as Record<string, unknown>;
  },

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
