import { apiUrl } from "./clipper.ts";
import type { KnowledgeContent, KnowledgeSource } from "./types.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly details: { knowledge_source_id?: string } | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class KnowledgeApi {
  constructor(
    readonly engineUrl: string,
    readonly apiKey: string,
  ) {}

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(apiUrl(this.engineUrl, path), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        reason?: string;
        code?: string;
        details?: { knowledge_source_id?: string };
      };
      throw new ApiError(
        response.status,
        payload.code || payload.reason,
        payload.details,
        payload.error || payload.message || `Request failed (${response.status})`,
      );
    }
    return (await response.json()) as T;
  }

  async listBundles(): Promise<KnowledgeSource[]> {
    const bundles: KnowledgeSource[] = [];
    let offset = 0;
    while (true) {
      const page = await this.request<{ items: KnowledgeSource[]; total: number }>(
        `/v1/knowledge-sources?limit=500&offset=${offset}`,
      );
      bundles.push(...page.items.filter((source) => source.source_type === "bundle"));
      offset += page.items.length;
      if (offset >= page.total || page.items.length === 0) return bundles;
    }
  }

  content(id: string): Promise<KnowledgeContent> {
    return this.request(`/v1/knowledge-sources/${encodeURIComponent(id)}/content`);
  }

  append(
    id: string,
    expectedVersion: string,
    path: string,
    content: string,
  ): Promise<{ path: string; version: string }> {
    return this.request(`/v1/knowledge-sources/${encodeURIComponent(id)}/documents`, {
      method: "POST",
      body: JSON.stringify({ expected_version: expectedVersion, path, content }),
    });
  }

  replace(
    id: string,
    expectedVersion: string,
    path: string,
    content: string,
  ): Promise<KnowledgeContent> {
    return this.request(`/v1/knowledge-sources/${encodeURIComponent(id)}/content`, {
      method: "PUT",
      body: JSON.stringify({ expected_version: expectedVersion, path, content }),
    });
  }

  createBundle(
    name: string,
    slug: string,
    path: string,
    content: string,
  ): Promise<{ knowledge_source: KnowledgeSource }> {
    return this.request("/v1/knowledge-sources/bundle", {
      method: "POST",
      body: JSON.stringify({
        name,
        slug,
        scope: "global",
        create_only: true,
        files: [{ path, content }],
      }),
    });
  }
}
