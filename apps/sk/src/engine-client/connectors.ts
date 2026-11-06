import { TransportError } from "@cli-core/errors.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

export interface ConnectorPromotionResponse {
  strategy: "copy" | "move";
  source_connector_id: string;
  target_connector_id: string;
  source_environment: "dev";
  target_environment: "prod";
  source_retained: boolean;
  credential_mappings: Array<{
    mode: string;
    source_credential_id: string;
    target_credential_id: string;
  }>;
  idempotent_replay: boolean;
  audit_log_ids: string[];
}

export const connectorsMethods = {
  async subscribeConnectorOAuthCallback(
    this: EngineClient,
    opts: {
      connectorId: string;
      signal?: AbortSignal;
      onSucceeded: (payload: {
        connector_id: string;
        connector_slug: string;
        has_refresh_token: boolean;
      }) => void;
    },
  ): Promise<{ cancel: () => void }> {
    const url = `${this.base}/v1/events/stream?channel=connector.oauth&type=connector.oauth.callback_succeeded`;
    const ac = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener("abort", () => ac.abort(), { once: true });
    }
    const cancel = (): void => {
      if (!ac.signal.aborted) ac.abort();
    };
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: this.headers({ accept: "text/event-stream" }),
        signal: ac.signal,
      });
    } catch (err) {
      throw new TransportError(err);
    }
    if (!res.ok || !res.body) {
      cancel();
      throw new TransportError(new Error(`oauth events stream returned HTTP ${res.status}`));
    }
    void (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        let live = false;
        while (!ac.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const block of frames) {
            if (!block.trim()) continue;
            if (block.startsWith(":")) continue;
            const lines = block.split("\n");
            const eventLine = lines.find((l) => l.startsWith("event: "));
            const dataLine = lines.find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            if (eventLine && eventLine.slice("event: ".length).trim() === "hello") {
              live = true;
              continue;
            }
            if (!live) continue;
            try {
              const payload = JSON.parse(dataLine.slice("data: ".length)) as {
                connector_id?: unknown;
                connector_slug?: unknown;
                has_refresh_token?: unknown;
              };
              if (
                typeof payload.connector_id === "string" &&
                payload.connector_id === opts.connectorId &&
                typeof payload.connector_slug === "string" &&
                typeof payload.has_refresh_token === "boolean"
              ) {
                opts.onSucceeded({
                  connector_id: payload.connector_id,
                  connector_slug: payload.connector_slug,
                  has_refresh_token: payload.has_refresh_token,
                });
                cancel();
                return;
              }
            } catch {}
          }
        }
      } catch {
      } finally {
        try {
          reader.releaseLock();
        } catch {}
      }
    })();
    return { cancel };
  },

  async listConnectors(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{
    items: Record<string, unknown>[];
    total: number;
    categories?: { category: string; count: number }[];
  }> {
    const { data } = await this.api.GET("/v1/connectors", {
      params: { query: query as ApiQuery<"/v1/connectors", "get"> },
    });
    return data as {
      items: Record<string, unknown>[];
      total: number;
      categories?: { category: string; count: number }[];
    };
  },
  async getConnector(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.GET("/v1/connectors/{id}", { params: { path: { id } } });
    return data as Record<string, unknown>;
  },
  async createConnector(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/connectors", {
      body: body as ApiBody<"/v1/connectors", "post">,
    });
    return data as Record<string, unknown>;
  },
  async patchConnector(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.PATCH("/v1/connectors/{id}", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/connectors/{id}", "patch">,
    });
    return data as Record<string, unknown>;
  },
  async deleteConnector(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/connectors/{id}", { params: { path: { id } } });
  },

  async validateConnectorDraft(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; issues: { path: string; message: string }[] }> {
    const { data } = await this.api.POST("/v1/connectors/validate", {
      body: body as ApiBody<"/v1/connectors/validate", "post">,
    });
    return data as { ok: boolean; issues: { path: string; message: string }[] };
  },
  async probeConnectorDraft(
    this: EngineClient,
    body: { connector: Record<string, unknown>; credential?: Record<string, unknown> },
  ): Promise<Record<string, unknown> & { ok?: boolean }> {
    const { data } = await this.api.POST("/v1/connectors/probe", {
      body: body as ApiBody<"/v1/connectors/probe", "post">,
    });
    return data as Record<string, unknown> & { ok?: boolean };
  },
  async importConnectorFromSpec(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> & { draft?: Record<string, unknown> }> {
    const { data } = await this.api.POST("/v1/connectors/import", {
      body: body as ApiBody<"/v1/connectors/import", "post">,
    });
    return data as Record<string, unknown> & { draft?: Record<string, unknown> };
  },
  async testConnector(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/connectors/{id}/test", { params: { path: { id } } });
    return data as Record<string, unknown>;
  },
  promoteConnector(
    this: EngineClient,
    id: string,
    body: { target_environment: "prod"; strategy: "copy" | "move" },
    idempotencyKey: string,
  ): Promise<ConnectorPromotionResponse> {
    return this.request(
      "POST",
      `/v1/connectors/${encodeURIComponent(id)}/promote`,
      body,
      undefined,
      undefined,
      { "idempotency-key": idempotencyKey },
    );
  },
  async startConnectorSignIn(
    this: EngineClient,
    id: string,
  ): Promise<{ authorization_url: string; state: string }> {
    const record = await this.getConnector(id);
    const signIn = record.sign_in as { kind?: unknown } | null | undefined;
    if (signIn?.kind === "mcp") return this.authorizeMcpConnector(id);
    if (signIn?.kind === "oauth") {
      const { data } = await this.api.POST("/v1/connectors/{id}/oauth/start", {
        params: { path: { id } },
      });
      return data as { authorization_url: string; state: string };
    }
    const name = typeof record.slug === "string" ? record.slug : id;
    throw new Error(
      `connector '${name}' has no browser sign-in — store its credential instead (sk credentials --help)`,
    );
  },
  async ingestConnectorDocs(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/connectors/{id}/docs/ingest", {
      params: { path: { id } },
      body: body as ApiBody<"/v1/connectors/{id}/docs/ingest", "post">,
    });
    return data as Record<string, unknown>;
  },
  listConnectorDocs(
    this: EngineClient,
    id: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", `/v1/connectors/${encodeURIComponent(id)}/docs`, undefined, query);
  },
  async searchConnectorDocs(
    this: EngineClient,
    id: string,
    q: string,
    limit?: number,
  ): Promise<{ items: Record<string, unknown>[] }> {
    const { data } = await this.api.GET("/v1/connectors/{id}/docs/search", {
      params: {
        path: { id },
        query: {
          q,
          limit,
        } as ApiQuery<"/v1/connectors/{id}/docs/search", "get">,
      },
    });
    return data as { items: Record<string, unknown>[] };
  },
  async deleteConnectorDoc(this: EngineClient, connectorId: string, docId: string): Promise<void> {
    await this.api.DELETE("/v1/connectors/{id}/docs/{document_id}", {
      params: { path: { id: connectorId, document_id: docId } },
    });
  },
  async createCredential(
    this: EngineClient,
    connectorId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/connectors/{id}/credentials", {
      params: { path: { id: connectorId } },
      body: body as ApiBody<"/v1/connectors/{id}/credentials", "post">,
    });
    return data as Record<string, unknown>;
  },
  async rotateCredential(
    this: EngineClient,
    credentialId: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/credentials/{id}/rotate", {
      params: { path: { id: credentialId } },
      body: body as ApiBody<"/v1/credentials/{id}/rotate", "post">,
    });
    return data as Record<string, unknown>;
  },
  async deleteCredential(this: EngineClient, credentialId: string): Promise<void> {
    await this.api.DELETE("/v1/credentials/{id}", { params: { path: { id: credentialId } } });
  },

  async enableConnector(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/connectors/{id}/enable", {
      params: { path: { id } },
    });
    return data as Record<string, unknown>;
  },
  async disableConnector(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/connectors/{id}/disable", {
      params: { path: { id } },
    });
    return data as Record<string, unknown>;
  },
  async inspectMcpConnector(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/connectors/{id}/mcp/inspect", {
      params: { path: { id } },
    });
    return data as Record<string, unknown>;
  },
  async authorizeMcpConnector(
    this: EngineClient,
    id: string,
  ): Promise<{ authorization_url: string; state: string }> {
    const { data } = await this.api.POST("/v1/connectors/{id}/mcp/authorize", {
      params: { path: { id } },
    });
    return data as { authorization_url: string; state: string };
  },

  listConnectorTemplates(
    this: EngineClient,
    query: Record<string, string | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/connector-templates", undefined, query);
  },
  async createConnectorTemplate(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/connector-templates", {
      body: body as ApiBody<"/v1/connector-templates", "post">,
    });
    return data as Record<string, unknown>;
  },
  async setConnectorTemplateOAuthCredentials(
    this: EngineClient,
    slug: string,
    body: { client_id: string; client_secret: string },
  ): Promise<{ id: string }> {
    const { data } = await this.api.POST("/v1/connector-templates/{slug}/oauth-credentials", {
      params: { path: { slug } },
      body: body as ApiBody<"/v1/connector-templates/{slug}/oauth-credentials", "post">,
    });
    return data as { id: string };
  },
  async deleteConnectorTemplate(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/connector-templates/{id}", { params: { path: { id } } });
  },
  async listConnectorTemplateRecipes(
    this: EngineClient,
    slug: string,
  ): Promise<{
    template_slug: string;
    template_name: string;
    recipes: Record<string, unknown>[];
  }> {
    const { data } = await this.api.GET("/v1/connector-templates/{slug}/recipes", {
      params: { path: { slug } },
    });
    return data as {
      template_slug: string;
      template_name: string;
      recipes: Record<string, unknown>[];
    };
  },
  async getConnectorTemplateRecipe(
    this: EngineClient,
    slug: string,
    recipeSlug: string,
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.GET("/v1/connector-templates/{slug}/recipes/{recipe_slug}", {
      params: { path: { slug, recipe_slug: recipeSlug } },
    });
    return data as Record<string, unknown>;
  },
  getRecipePack(
    this: EngineClient,
    vertical: string,
  ): Promise<{
    vertical: string;
    outcome: string;
    recipes: Array<Record<string, unknown>>;
  }> {
    return this.request("GET", `/v1/recipe-packs/${encodeURIComponent(vertical)}`);
  },
  async createConnectorFromTemplate(
    this: EngineClient,
    slug: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const { data } = await this.api.POST("/v1/connectors/from-template/{slug}", {
      params: { path: { slug } },
      body: body as ApiBody<"/v1/connectors/from-template/{slug}", "post">,
    });
    return data as Record<string, unknown>;
  },
};
