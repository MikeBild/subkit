// Connector surfaces of the engine client: connector CRUD + test +
// OAuth, connector docs, credentials, connector templates / recipes,
// external MCP servers, and the OAuth-callback event subscription.
// Method group merged into `EngineClient` by `../engine-client.ts`.

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

  // -------------------- Authoring (nothing is persisted) --------------------
  // The declarative counterparts to `sk workflows validate` / `preview`. Each
  // one answers a question about a definition that does not exist yet, so an
  // author can find a mistake before a connector is created rather than after.

  /** Check a definition against its driver's config schema. A definition that
   *  is invalid still comes back 200 — read `ok`. */
  validateConnectorDraft(
    this: EngineClient,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; issues: { path: string; message: string }[] }> {
    return this.request("POST", "/v1/connectors/validate", body);
  },
  /** Run the driver probe against an unsaved definition. The credential, when
   *  supplied, signs that one request and is never stored. */
  probeConnectorDraft(
    this: EngineClient,
    body: { connector: Record<string, unknown>; credential?: Record<string, unknown> },
  ): Promise<Record<string, unknown> & { ok?: boolean }> {
    return this.request("POST", "/v1/connectors/probe", body);
  },
  /** Parse an API specification into a connector draft. Returns the draft for
   *  review; saving it is a separate, deliberate step. */
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
  /**
   * Start the connector's own browser sign-in. The engine states it on the
   * connector record (`sign_in`): `oauth` starts at `/oauth/start` (a web
   * service), `mcp` at `/mcp/authorize` (an MCP server) — so this client
   * never picks one by driver. An empty `authorization_url` means the sign-in finished
   * without a browser (a client-credentials exchange); a connector with no
   * `sign_in` signs in with a stored credential instead.
   */
  async startConnectorSignIn(
    this: EngineClient,
    id: string,
  ): Promise<{ authorization_url: string; state: string }> {
    const record = await this.getConnector(id);
    const signIn = record.sign_in as { kind?: unknown } | null | undefined;
    // Dispatched on the record's `kind` onto the two literal routes, so the
    // CLI↔OpenAPI contract test still sees every path this client can call.
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

  // Operator on/off switch. Driver-agnostic: the engine evicts whatever
  // live state the driver holds (an mcp pooled session, a postgres pool)
  // so a disabled connector stops serving immediately.
  enableConnector(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/connectors/${encodeURIComponent(id)}/enable`);
  },
  disableConnector(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/connectors/${encodeURIComponent(id)}/disable`);
  },
  // mcp driver only: force one handshake and report what the remote
  // actually serves. 422 when the connector is not an mcp connector.
  inspectMcpConnector(this: EngineClient, id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v1/connectors/${encodeURIComponent(id)}/mcp/inspect`);
  },
  // Start the interactive OAuth consent flow for an mcp connector whose
  // config.mcp.auth.kind is "oauth2". The engine returns the authorize URL
  // the user opens in a browser; the callback completes server-side.
  authorizeMcpConnector(
    this: EngineClient,
    id: string,
  ): Promise<{ authorization_url: string; state: string }> {
    return this.request("POST", `/v1/connectors/${encodeURIComponent(id)}/mcp/authorize`);
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
