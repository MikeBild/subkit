import { TransportError } from "@cli-core/errors.ts";
import type { EngineClient } from "../engine-client.ts";

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

  listConnectors(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{
    items: Record<string, unknown>[];
    total: number;
    categories?: { category: string; count: number }[];
  }> {
    return this.request("GET", "/v1/connectors", undefined, query);
  },
  getConnector(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/connectors/${encodeURIComponent(id)}`);
  },
  createConnector(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/connectors", body);
  },
  patchConnector(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/connectors/${encodeURIComponent(id)}`, body);
  },
  deleteConnector(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/connectors/${encodeURIComponent(id)}`);
  },

  validateConnectorDraft(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; issues: { path: string; message: string }[] }> {
    return this.request("POST", "/v1/connectors/validate", body);
  },
  probeConnectorDraft(
    this: EngineClient,
    body: { connector: Record<string, unknown>; credential?: Record<string, unknown> },
  ): Promise<Record<string, unknown> & { ok?: boolean }> {
    return this.request("POST", "/v1/connectors/probe", body);
  },
  importConnectorFromSpec(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> & { draft?: Record<string, unknown> }> {
    return this.request("POST", "/v1/connectors/import", body);
  },
  testConnector(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/connectors/${encodeURIComponent(id)}/test`);
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
      return this.request("POST", `/v1/connectors/${encodeURIComponent(id)}/oauth/start`);
    }
    const name = typeof record.slug === "string" ? record.slug : id;
    throw new Error(
      `connector '${name}' has no browser sign-in — store its credential instead (sk credentials --help)`,
    );
  },
  ingestConnectorDocs(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/connectors/${encodeURIComponent(id)}/docs/ingest`, body);
  },
  listConnectorDocs(
    this: EngineClient,
    id: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", `/v1/connectors/${encodeURIComponent(id)}/docs`, undefined, query);
  },
  searchConnectorDocs(
    this: EngineClient,
    id: string,
    q: string,
    limit?: number,
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", `/v1/connectors/${encodeURIComponent(id)}/docs/search`, undefined, {
      q,
      limit,
    });
  },
  deleteConnectorDoc(this: EngineClient, connectorId: string, docId: string): Promise<void> {
    return this.request(
      "DELETE",
      `/v1/connectors/${encodeURIComponent(connectorId)}/docs/${encodeURIComponent(docId)}`,
    );
  },
  createCredential(
    this: EngineClient,
    connectorId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/v1/connectors/${encodeURIComponent(connectorId)}/credentials`,
      body,
    );
  },
  rotateCredential(
    this: EngineClient,
    credentialId: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/credentials/${encodeURIComponent(credentialId)}/rotate`, body);
  },
  deleteCredential(this: EngineClient, credentialId: string): Promise<void> {
    return this.request("DELETE", `/v1/credentials/${encodeURIComponent(credentialId)}`);
  },

  enableConnector(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/connectors/${encodeURIComponent(id)}/enable`);
  },
  disableConnector(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/connectors/${encodeURIComponent(id)}/disable`);
  },
  inspectMcpConnector(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/connectors/${encodeURIComponent(id)}/mcp/inspect`);
  },
  authorizeMcpConnector(
    this: EngineClient,
    id: string,
  ): Promise<{ authorization_url: string; state: string }> {
    return this.request("POST", `/v1/connectors/${encodeURIComponent(id)}/mcp/authorize`);
  },

  listConnectorTemplates(
    this: EngineClient,
    query: Record<string, string | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/connector-templates", undefined, query);
  },
  createConnectorTemplate(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/connector-templates", body);
  },
  setConnectorTemplateOAuthCredentials(
    this: EngineClient,
    slug: string,
    body: { client_id: string; client_secret: string },
  ): Promise<{ id: string }> {
    return this.request(
      "POST",
      `/v1/connector-templates/${encodeURIComponent(slug)}/oauth-credentials`,
      body,
    );
  },
  deleteConnectorTemplate(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/connector-templates/${encodeURIComponent(id)}`);
  },
  listConnectorTemplateRecipes(
    this: EngineClient,
    slug: string,
  ): Promise<{
    template_slug: string;
    template_name: string;
    recipes: Record<string, unknown>[];
  }> {
    return this.request("GET", `/v1/connector-templates/${encodeURIComponent(slug)}/recipes`);
  },
  getConnectorTemplateRecipe(
    this: EngineClient,
    slug: string,
    recipeSlug: string,
  ): Promise<Record<string, unknown>> {
    return this.request(
      "GET",
      `/v1/connector-templates/${encodeURIComponent(slug)}/recipes/${encodeURIComponent(recipeSlug)}`,
    );
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
  createConnectorFromTemplate(
    this: EngineClient,
    slug: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/connectors/from-template/${encodeURIComponent(slug)}`, body);
  },
};
