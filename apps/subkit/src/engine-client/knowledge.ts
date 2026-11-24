import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { EngineError } from "@cli-core/errors.ts";
import type { EngineClient } from "../engine-client.ts";
import { type ApiBody, type ApiQuery, parseResponseBody } from "./http.ts";

type Schemas = components["schemas"];

export type KnowledgeSourceMetadata = Partial<Schemas["CreateKnowledgeSourceBody"]>;

// HTTP header values must be ASCII; percent-encode names the engine decodes back.
export const encodeFilenameHeader = (filename: string): string =>
  /^[\x20-\x24\x26-\x7e]*$/.test(filename) ? filename : encodeURIComponent(filename);

export const knowledgeMethods = {
  async listKnowledgeSources(
    this: EngineClient,
    query: ApiQuery<"/v1/knowledge-sources", "get"> = {},
  ): Promise<Schemas["KnowledgeSourceListResponse"]> {
    const { data } = await this.api.GET("/v1/knowledge-sources", { params: { query } });
    return data as Schemas["KnowledgeSourceListResponse"];
  },
  async searchKnowledge(
    this: EngineClient,
    q: string,
    query: Omit<ApiQuery<"/v1/knowledge-sources/search", "get">, "q"> = {},
  ): Promise<Schemas["KnowledgeSearchResult"]> {
    const { data } = await this.api.GET("/v1/knowledge-sources/search", {
      params: { query: { q, ...query } },
    });
    return data as Schemas["KnowledgeSearchResult"];
  },
  async getKnowledgeSource(this: EngineClient, id: string): Promise<Schemas["KnowledgeSource"]> {
    const { data } = await this.api.GET("/v1/knowledge-sources/{id}", { params: { path: { id } } });
    return data as Schemas["KnowledgeSource"];
  },
  async patchKnowledgeSource(
    this: EngineClient,
    id: string,
    body: ApiBody<"/v1/knowledge-sources/{id}", "patch">,
  ): Promise<Schemas["KnowledgeSource"]> {
    const { data } = await this.api.PATCH("/v1/knowledge-sources/{id}", {
      params: { path: { id } },
      body,
    });
    return data as Schemas["KnowledgeSource"];
  },
  async analyzeKnowledgeSource(
    this: EngineClient,
    id: string,
    body: ApiBody<"/v1/knowledge-sources/{id}/analyze", "post"> = {},
  ): Promise<Schemas["AnalyzeKnowledgeSourceResponse"]> {
    const { data } = await this.api.POST("/v1/knowledge-sources/{id}/analyze", {
      params: { path: { id } },
      body,
    });
    return data as Schemas["AnalyzeKnowledgeSourceResponse"];
  },
  async deleteKnowledgeSource(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/knowledge-sources/{id}", { params: { path: { id } } });
  },
  createKnowledgeSource(
    this: EngineClient,
    file: { name: string; content: Buffer | Uint8Array; mime_type: string },
    metadata: KnowledgeSourceMetadata = {},
  ): Promise<Schemas["KnowledgeSource"]> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([file.content as unknown as ArrayBuffer], { type: file.mime_type }),
      file.name,
    );
    const body: Schemas["CreateKnowledgeSourceBody"] = { name: file.name, ...metadata };
    form.append("metadata", JSON.stringify(body));
    return this.requestForm("POST", "/v1/knowledge-sources", form);
  },

  async importKnowledgeBundle(
    this: EngineClient,
    body: ApiBody<"/v1/knowledge-sources/bundle", "post">,
  ): Promise<Schemas["KnowledgeBundleUpsertResponse"]> {
    const { data } = await this.api.POST("/v1/knowledge-sources/bundle", { body });
    return data as Schemas["KnowledgeBundleUpsertResponse"];
  },
  async knowledgeHistory(
    this: EngineClient,
    id: string,
    query: ApiQuery<"/v1/knowledge-sources/{id}/history", "get"> = {},
  ): Promise<Schemas["KnowledgeSourceVersionListResponse"]> {
    const { data } = await this.api.GET("/v1/knowledge-sources/{id}/history", {
      params: { path: { id }, query },
    });
    return data as Schemas["KnowledgeSourceVersionListResponse"];
  },
  async restoreKnowledgeVersion(
    this: EngineClient,
    id: string,
    version: number,
  ): Promise<Schemas["RestoreKnowledgeSourceVersionResponse"]> {
    const { data } = await this.api.POST("/v1/knowledge-sources/{id}/restore/{version}", {
      params: { path: { id, version } },
    });
    return data as Schemas["RestoreKnowledgeSourceVersionResponse"];
  },
  async listKnowledgeChunks(
    this: EngineClient,
    id: string,
    query: ApiQuery<"/v1/knowledge-sources/{id}/chunks", "get"> = {},
  ): Promise<Schemas["KnowledgeChunkListResponse"]> {
    const { data } = await this.api.GET("/v1/knowledge-sources/{id}/chunks", {
      params: { path: { id }, query },
    });
    return data as Schemas["KnowledgeChunkListResponse"];
  },

  async listDiscoveryRuns(
    this: EngineClient,
    query: ApiQuery<"/v1/discovery/runs", "get"> = {},
  ): Promise<Schemas["DiscoveryRunListResponse"]> {
    const { data } = await this.api.GET("/v1/discovery/runs", { params: { query } });
    return data as Schemas["DiscoveryRunListResponse"];
  },
  async getDiscoveryRun(this: EngineClient, id: string): Promise<Schemas["DiscoveryRun"]> {
    const { data } = await this.api.GET("/v1/discovery/runs/{id}", { params: { path: { id } } });
    return data as Schemas["DiscoveryRun"];
  },
  async listDiscoveryArtifacts(
    this: EngineClient,
    runId: string,
    query: ApiQuery<"/v1/discovery/runs/{id}/artifacts", "get"> = {},
  ): Promise<Schemas["DiscoveryArtifactListResponse"]> {
    const { data } = await this.api.GET("/v1/discovery/runs/{id}/artifacts", {
      params: { path: { id: runId }, query },
    });
    return data as Schemas["DiscoveryArtifactListResponse"];
  },
  async approveDiscoveryArtifact(
    this: EngineClient,
    id: string,
  ): Promise<Schemas["ApproveDiscoveryArtifactResponse"]> {
    const { data } = await this.api.POST("/v1/discovery/artifacts/{id}/approve", {
      params: { path: { id } },
    });
    return data as Schemas["ApproveDiscoveryArtifactResponse"];
  },
  async rejectDiscoveryArtifact(
    this: EngineClient,
    id: string,
    body: ApiBody<"/v1/discovery/artifacts/{id}/reject", "post"> = {},
  ): Promise<{ rejected: boolean }> {
    const { data } = await this.api.POST("/v1/discovery/artifacts/{id}/reject", {
      params: { path: { id } },
      body,
    });
    return data as { rejected: boolean };
  },
  createDiscoveryRun(
    this: EngineClient,
    files: Array<{ name: string; content: Buffer | Uint8Array; mime_type: string }>,
    label?: string,
  ): Promise<Schemas["DiscoveryRun"]> {
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
    body: ApiBody<"/v1/ai/extract", "post">,
  ): Promise<Schemas["AiExtractResponse"]> {
    const { data } = await this.api.POST("/v1/ai/extract", { body });
    return data as Schemas["AiExtractResponse"];
  },

  async extractFile(
    this: EngineClient,
    args: {
      buffer: Uint8Array;
      contentType: string;
      filename?: string;
    },
  ): Promise<Schemas["ExtractFileResponse"]> {
    const traceId = this.newClientTraceId();
    const headers = this.headers(undefined, { traceId });
    headers["content-type"] = args.contentType;
    if (args.filename) headers["x-filename"] = encodeFilenameHeader(args.filename);
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
    return (parsed ?? {}) as Schemas["ExtractFileResponse"];
  },
};
