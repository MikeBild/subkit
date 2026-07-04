// Connector surfaces of the engine client: connector CRUD + test +
// OAuth, connector docs, credentials, connector templates / recipes,
// external MCP servers, and the OAuth-callback event subscription.
// Method group merged into `EngineClient` by `../engine-client.ts`.

import { TransportError } from "@cli-core/errors.ts";
import type { EngineClient } from "../engine-client.ts";

export const connectorsMethods = {
  /**
   * Subscribe to the tenant-scoped event stream filtered to
   * `connector.oauth.callback_succeeded` events. When the user
   * completes an OAuth authorization in their browser, the engine
   * persists the credential and emits an event on the `connector.oauth`
   * channel; this helper consumes that stream and invokes
   * `onSucceeded` the first time a payload matching `connectorId`
   * arrives.
   *
   * Used by the REPL to auto-resume the conversation after
   * `authenticate_oauth` instead of waiting for the operator to type
   * "done" — plan/read-sk-synthetic-wirth.md Fix #1.
   *
   * Auto-closes the SSE connection after one match. The caller can
   * also abort via the returned `cancel()` or by aborting the supplied
   * `signal`. Filters are applied server-side via query params, so
   * cross-tenant events never reach the client.
   */
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
    // Compose with the caller-supplied signal so either side can abort.
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
    // Consume in background — caller awaits `cancel()` indirectly via
    // `onSucceeded` or signal. The reader loop self-terminates on
    // first match or on abort.
    void (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        // Replay guard: `/v1/events/stream` replays the last 50 rows
        // on open (without Last-Event-ID). If the connector has been
        // OAuth'd before, a prior `connector.oauth.callback_succeeded`
        // for the same connector_id is in that replay — and would
        // auto-confirm the CURRENT elicitation before the operator
        // even finishes the new browser dance. The server announces
        // the live cutover with a `hello` event after the replay; we
        // ignore every payload-frame until that marker arrives.
        let live = false;
        while (!ac.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const block of frames) {
            if (!block.trim()) continue;
            if (block.startsWith(":")) continue; // heartbeat
            const lines = block.split("\n");
            const eventLine = lines.find((l) => l.startsWith("event: "));
            const dataLine = lines.find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            // The `hello` frame flips us from replay-discard mode into
            // live-event mode. Skip the frame itself but mark `live`.
            if (eventLine && eventLine.slice("event: ".length).trim() === "hello") {
              live = true;
              continue;
            }
            // Pre-hello frames are replay. Drop them — even if they
            // match the connector_id filter, they represent a PAST
            // OAuth completion, not the one the operator is doing now.
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
            } catch {
              // Malformed frame — skip rather than abort. The next
              // valid frame may still match.
            }
          }
        }
      } catch {
        // Reader threw mid-stream (network drop, server restart, abort).
        // Caller's `signal` or independent timeout decides whether to
        // retry; we never retry transparently because that would mask
        // the failure from the operator.
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Reader was already released by the consumer loop; safe to swallow.
        }
      }
    })();
    return { cancel };
  },

  // -------------------- Connectors --------------------
  listConnectors(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
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
  testConnector(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/connectors/${encodeURIComponent(id)}/test`);
  },
  startConnectorOAuth(this: EngineClient, id: string): Promise<{ oauth_url: string }> {
    return this.request("POST", `/v1/connectors/${encodeURIComponent(id)}/oauth/start`);
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

  // -------------------- External MCP servers --------------------
  // Inverse of sk's own MCP server: tenants register external MCP servers
  // whose tools the conversation loop can call. The auth secret (token /
  // refresh_token) is a write-only create/patch field stored encrypted in
  // the credentials table; `auth_config` is redacted server-side to
  // `{ kind, has_credential }` on every read path and never echoes a secret.
  listMcpServers(
    this: EngineClient,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.request("GET", "/v1/mcp-servers", undefined, query);
  },
  getMcpServer(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/mcp-servers/${encodeURIComponent(id)}`);
  },
  createMcpServer(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/mcp-servers", body);
  },
  patchMcpServer(
    this: EngineClient,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/v1/mcp-servers/${encodeURIComponent(id)}`, body);
  },
  enableMcpServer(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/mcp-servers/${encodeURIComponent(id)}/enable`);
  },
  disableMcpServer(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/mcp-servers/${encodeURIComponent(id)}/disable`);
  },
  inspectMcpServer(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/mcp-servers/${encodeURIComponent(id)}/inspect`);
  },
  // Start the interactive OAuth consent flow for an oauth2-auth MCP server.
  // The engine returns the authorize URL the user opens in a browser; the
  // callback completes server-side and flips `status` to "active".
  authorizeMcpServer(
    this: EngineClient,
    id: string,
  ): Promise<{ authorization_url: string; state: string }> {
    return this.request("POST", `/v1/mcp-servers/${encodeURIComponent(id)}/authorize`);
  },
  deleteMcpServer(this: EngineClient, id: string): Promise<void> {
    return this.request("DELETE", `/v1/mcp-servers/${encodeURIComponent(id)}`);
  },

  // -------------------- Connector Templates --------------------
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
