import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { TransportError } from "@cli-core/errors.ts";
import type { EngineClient } from "../engine-client.ts";
import type { ApiBody, ApiQuery } from "./http.ts";

type Schemas = components["schemas"];

export type Connector = Schemas["Connector"];
export type ConnectorListQuery = ApiQuery<"/v1/connectors", "get">;
export type ConnectorListResponse = Schemas["ConnectorListResponse"];
export type CreateConnectorBody = ApiBody<"/v1/connectors", "post">;
export type UpdateConnectorBody = ApiBody<"/v1/connectors/{id}", "patch">;
export type ValidateConnectorResponse = Schemas["ValidateConnectorResponse"];
export type ProbeConnectorBody = ApiBody<"/v1/connectors/probe", "post">;
export type ProbeConnectorResponse = Schemas["ProbeConnectorResponse"];
export type ImportConnectorBody = ApiBody<"/v1/connectors/import", "post">;
export type ImportConnectorResponse = Schemas["ImportConnectorResponse"];
export type ConnectorProbeResult = Schemas["ConnectorProbeResult"];
export type ConnectorPromotionBody = ApiBody<"/v1/connectors/{id}/promote", "post">;
export type ConnectorPromotionResponse = Schemas["ConnectorPromotionResponse"];
export type ConnectorSignIn = Schemas["OAuthStartResponse"];
export type ConnectorDocsIngestBody = ApiBody<"/v1/connectors/{id}/docs/ingest", "post">;
export type ConnectorDocsIngestResponse = Schemas["ConnectorDocsIngestResponse"];
export type ConnectorDocsListResponse = Schemas["ConnectorDocsListResponse"];
export type ConnectorDocsSearchResponse = Schemas["ConnectorDocsSearchResponse"];
export type CredentialBody = ApiBody<"/v1/connectors/{id}/credentials", "post">;
export type CreatedCredential = { id: string };
export type CredentialRow = Schemas["CredentialRow"];
export type ConnectorMcpInspectResponse = Schemas["ConnectorMcpInspectResponse"];
export type ConnectorMcpAuthorizeResponse = Schemas["ConnectorMcpAuthorizeResponse"];
export type ConnectorTemplateListResponse = Schemas["ConnectorTemplateListResponse"];
export type ConnectorTemplateCreateBody = ApiBody<"/v1/connector-templates", "post">;
export type ConnectorTemplateRow = Schemas["ConnectorTemplateRow"];
export type TemplateOAuthCredentialBody = ApiBody<
  "/v1/connector-templates/{slug}/oauth-credentials",
  "post"
>;
export type TemplateOAuthCredentialResponse = Schemas["TemplateOAuthCredentialResponse"];
export type ConnectorTemplateRecipeListResponse = Schemas["ConnectorTemplateRecipeListResponse"];
export type ConnectorTemplateRecipe = Schemas["ConnectorTemplateRecipe"];
export type RecipePackVertical = RecipePackResponse["vertical"];
export type RecipePackResponse = Schemas["RecipePackResponse"];
export type ConnectorFromTemplateBody = ApiBody<"/v1/connectors/from-template/{slug}", "post">;
export type ConnectorFromTemplateResponse = Schemas["ConnectorFromTemplateResponse"];

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
    query: ConnectorListQuery = {},
  ): Promise<ConnectorListResponse> {
    const { data } = await this.api.GET("/v1/connectors", { params: { query } });
    return data as ConnectorListResponse;
  },
  async getConnector(this: EngineClient, id: string): Promise<Connector> {
    const { data } = await this.api.GET("/v1/connectors/{id}", { params: { path: { id } } });
    return data as Connector;
  },
  async createConnector(this: EngineClient, body: CreateConnectorBody): Promise<Connector> {
    const { data } = await this.api.POST("/v1/connectors", { body });
    return data as Connector;
  },
  async patchConnector(
    this: EngineClient,
    id: string,
    body: UpdateConnectorBody,
  ): Promise<Connector> {
    const { data } = await this.api.PATCH("/v1/connectors/{id}", {
      params: { path: { id } },
      body,
    });
    return data as Connector;
  },
  async deleteConnector(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/connectors/{id}", { params: { path: { id } } });
  },

  async validateConnectorDraft(
    this: EngineClient,
    body: CreateConnectorBody,
  ): Promise<ValidateConnectorResponse> {
    const { data } = await this.api.POST("/v1/connectors/validate", { body });
    return data as ValidateConnectorResponse;
  },
  async probeConnectorDraft(
    this: EngineClient,
    body: ProbeConnectorBody,
  ): Promise<ProbeConnectorResponse> {
    const { data } = await this.api.POST("/v1/connectors/probe", { body });
    return data as ProbeConnectorResponse;
  },
  async importConnectorFromSpec(
    this: EngineClient,
    body: ImportConnectorBody,
  ): Promise<ImportConnectorResponse> {
    const { data } = await this.api.POST("/v1/connectors/import", { body });
    return data as ImportConnectorResponse;
  },
  async testConnector(this: EngineClient, id: string): Promise<ConnectorProbeResult> {
    const { data } = await this.api.POST("/v1/connectors/{id}/test", { params: { path: { id } } });
    return data as ConnectorProbeResult;
  },
  promoteConnector(
    this: EngineClient,
    id: string,
    body: ConnectorPromotionBody,
    idempotencyKey: string,
  ): Promise<ConnectorPromotionResponse> {
    return this.request<ConnectorPromotionResponse>(
      "POST",
      `/v1/connectors/${encodeURIComponent(id)}/promote`,
      body,
      undefined,
      undefined,
      { "idempotency-key": idempotencyKey },
    );
  },
  async startConnectorSignIn(this: EngineClient, id: string): Promise<ConnectorSignIn> {
    const record = await this.getConnector(id);
    if (record.sign_in?.kind === "mcp") return this.authorizeMcpConnector(id);
    if (record.sign_in?.kind === "oauth") {
      const { data } = await this.api.POST("/v1/connectors/{id}/oauth/start", {
        params: { path: { id } },
      });
      return data as ConnectorSignIn;
    }
    const name = typeof record.slug === "string" ? record.slug : id;
    throw new Error(
      `connector '${name}' has no browser sign-in — store its credential instead (sk credentials --help)`,
    );
  },
  async ingestConnectorDocs(
    this: EngineClient,
    id: string,
    body: ConnectorDocsIngestBody,
  ): Promise<ConnectorDocsIngestResponse> {
    const { data } = await this.api.POST("/v1/connectors/{id}/docs/ingest", {
      params: { path: { id } },
      body,
    });
    return data as ConnectorDocsIngestResponse;
  },
  async listConnectorDocs(this: EngineClient, id: string): Promise<ConnectorDocsListResponse> {
    const { data } = await this.api.GET("/v1/connectors/{id}/docs", { params: { path: { id } } });
    return data as ConnectorDocsListResponse;
  },
  async searchConnectorDocs(
    this: EngineClient,
    id: string,
    q: string,
    limit?: number,
  ): Promise<ConnectorDocsSearchResponse> {
    const { data } = await this.api.GET("/v1/connectors/{id}/docs/search", {
      params: { path: { id }, query: { q, ...(limit !== undefined ? { limit } : {}) } },
    });
    return data as ConnectorDocsSearchResponse;
  },
  async deleteConnectorDoc(this: EngineClient, connectorId: string, docId: string): Promise<void> {
    await this.api.DELETE("/v1/connectors/{id}/docs/{document_id}", {
      params: { path: { id: connectorId, document_id: docId } },
    });
  },
  async createCredential(
    this: EngineClient,
    connectorId: string,
    body: CredentialBody,
  ): Promise<CreatedCredential> {
    const { data } = await this.api.POST("/v1/connectors/{id}/credentials", {
      params: { path: { id: connectorId } },
      body,
    });
    return data as CreatedCredential;
  },
  async rotateCredential(this: EngineClient, credentialId: string): Promise<CredentialRow> {
    const { data } = await this.api.POST("/v1/credentials/{id}/rotate", {
      params: { path: { id: credentialId } },
      body: {},
    });
    return data as CredentialRow;
  },
  async deleteCredential(this: EngineClient, credentialId: string): Promise<void> {
    await this.api.DELETE("/v1/credentials/{id}", { params: { path: { id: credentialId } } });
  },

  async enableConnector(this: EngineClient, id: string): Promise<Connector> {
    const { data } = await this.api.POST("/v1/connectors/{id}/enable", {
      params: { path: { id } },
    });
    return data as Connector;
  },
  async disableConnector(this: EngineClient, id: string): Promise<Connector> {
    const { data } = await this.api.POST("/v1/connectors/{id}/disable", {
      params: { path: { id } },
    });
    return data as Connector;
  },
  async inspectMcpConnector(this: EngineClient, id: string): Promise<ConnectorMcpInspectResponse> {
    const { data } = await this.api.POST("/v1/connectors/{id}/mcp/inspect", {
      params: { path: { id } },
    });
    return data as ConnectorMcpInspectResponse;
  },
  async authorizeMcpConnector(
    this: EngineClient,
    id: string,
  ): Promise<ConnectorMcpAuthorizeResponse> {
    const { data } = await this.api.POST("/v1/connectors/{id}/mcp/authorize", {
      params: { path: { id } },
    });
    return data as ConnectorMcpAuthorizeResponse;
  },

  async listConnectorTemplates(this: EngineClient): Promise<ConnectorTemplateListResponse> {
    const { data } = await this.api.GET("/v1/connector-templates");
    return data as ConnectorTemplateListResponse;
  },
  async createConnectorTemplate(
    this: EngineClient,
    body: ConnectorTemplateCreateBody,
  ): Promise<ConnectorTemplateRow> {
    const { data } = await this.api.POST("/v1/connector-templates", { body });
    return data as ConnectorTemplateRow;
  },
  async setConnectorTemplateOAuthCredentials(
    this: EngineClient,
    slug: string,
    body: TemplateOAuthCredentialBody,
  ): Promise<TemplateOAuthCredentialResponse> {
    const { data } = await this.api.POST("/v1/connector-templates/{slug}/oauth-credentials", {
      params: { path: { slug } },
      body,
    });
    return data as TemplateOAuthCredentialResponse;
  },
  async deleteConnectorTemplate(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/connector-templates/{id}", { params: { path: { id } } });
  },
  async listConnectorTemplateRecipes(
    this: EngineClient,
    slug: string,
  ): Promise<ConnectorTemplateRecipeListResponse> {
    const { data } = await this.api.GET("/v1/connector-templates/{slug}/recipes", {
      params: { path: { slug } },
    });
    return data as ConnectorTemplateRecipeListResponse;
  },
  async getConnectorTemplateRecipe(
    this: EngineClient,
    slug: string,
    recipeSlug: string,
  ): Promise<ConnectorTemplateRecipe> {
    const { data } = await this.api.GET("/v1/connector-templates/{slug}/recipes/{recipe_slug}", {
      params: { path: { slug, recipe_slug: recipeSlug } },
    });
    return data as ConnectorTemplateRecipe;
  },
  async getRecipePack(
    this: EngineClient,
    vertical: RecipePackVertical,
  ): Promise<RecipePackResponse> {
    const { data } = await this.api.GET("/v1/recipe-packs/{vertical}", {
      params: { path: { vertical } },
    });
    return data as RecipePackResponse;
  },
  async createConnectorFromTemplate(
    this: EngineClient,
    slug: string,
    body: ConnectorFromTemplateBody = {},
  ): Promise<ConnectorFromTemplateResponse> {
    const { data } = await this.api.POST("/v1/connectors/from-template/{slug}", {
      params: { path: { slug } },
      body,
    });
    return data as ConnectorFromTemplateResponse;
  },
};
