// Connector authoring, before anything is saved:
//   POST /v1/connectors/validate — is this definition well-formed?
//   POST /v1/connectors/probe    — does it actually reach the upstream?
//   POST /v1/connectors/import   — turn a spec into a draft definition
//
// NONE OF THESE PERSIST ANYTHING. That is the point. `sk connectors` mirrors
// `sk workflows` — validate, then preview, then save — and an author only gets
// that loop if the first two steps can run against a definition that does not
// exist in the tenant yet. Previously the only way to find out whether a
// connector worked was to create it and see, which left half-working connectors
// behind every time an author guessed wrong.
//
// A credential may ride in the probe request so an authenticated upstream can be
// reached before the connector exists. It is used to sign that one request and
// dropped — never written to `credentials`, never echoed back in the response.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import {
  type ConnectorView,
  CreateConnectorSchema,
  type DriverName,
  probeConnector,
  validateConnectorAuthType,
  validateConnectorConfig,
  validateMcpAuthConsistency,
  withMcpConfigDefaults,
} from "../../../connectors/index.ts";
import {
  importConnectorDraftFromSpec,
  importConnectorFromSpecInputSchema,
} from "../../../conversations/index.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { credentialBodyToValue } from "./credential-body.ts";
import { CredentialBody } from "./schemas.ts";

const ConnectorIssue = z
  .object({
    path: z.string().describe("Dotted path to the offending field"),
    message: z.string(),
  })
  .openapi("ConnectorIssue");

const ValidateConnectorResponse = z
  .object({
    ok: z.boolean(),
    issues: z.array(ConnectorIssue),
  })
  .openapi("ValidateConnectorResponse");

const ProbeConnectorBody = z
  .object({
    connector: CreateConnectorSchema.describe(
      "The definition to probe, exactly as you would save it",
    ),
    credential: CredentialBody.optional().describe(
      "Credential to sign the probe with. Used for this request only and never stored. Required when the definition sets an auth_type other than 'none'.",
    ),
  })
  .openapi("ProbeConnectorBody");

const ProbeConnectorResponse = z
  .object({
    ok: z.boolean(),
    latency_ms: z.number(),
    status: z.number().optional(),
    detail: z.string().optional(),
    error_code: z.string().optional(),
    body_snippet: z.string().optional(),
    provider_action_url: z.string().optional(),
  })
  .openapi("ProbeConnectorResponse");

const ImportConnectorResponse = z
  .object({
    draft: z.record(z.string(), z.unknown()).optional(),
    template_match: z.record(z.string(), z.unknown()).nullable().optional(),
    recommended_next: z.array(z.string()).optional(),
  })
  .passthrough()
  .openapi("ImportConnectorResponse");

const validateRoute = createRoute({
  method: "post",
  path: "/v1/connectors/validate",
  tags: ["connectors"],
  summary: "Validate a connector definition without saving it",
  description:
    "Checks the definition against its driver's config schema. Persists nothing. Use before `POST /v1/connectors`; `sk connectors validate --file` calls this.",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateConnectorSchema } } } },
  responses: {
    200: {
      description:
        "Validation verdict — check `ok`; a well-formed request with an invalid definition is still a 200",
      content: { "application/json": { schema: ValidateConnectorResponse } },
    },
  },
});

const probeRoute = createRoute({
  method: "post",
  path: "/v1/connectors/probe",
  tags: ["connectors"],
  summary: "Probe a connector definition without saving it",
  description:
    "Runs the driver's health probe against a definition that does not exist yet. Persists nothing — neither the connector nor the credential. `sk connectors probe --file` calls this. For driver `mcp`, the probe performs a throwaway initialize + tools/list handshake with the supplied static credential and closes the session immediately.",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: ProbeConnectorBody } } } },
  responses: {
    200: {
      description: "Probe outcome — check `ok`; an unreachable upstream is still a 200",
      content: { "application/json": { schema: ProbeConnectorResponse } },
    },
    400: {
      description:
        "The request cannot be served because the credential or connector definition is malformed. Distinct from a 200 `ok:false`, which means the upstream was reached and answered badly.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const importRoute = createRoute({
  method: "post",
  path: "/v1/connectors/import",
  tags: ["connectors"],
  summary: "Turn an API specification into a connector draft",
  description:
    "Parses an OpenAPI/Google Discovery document, a request collection, a HAR, GraphQL SDL or introspection endpoint, or a curl command into a connector definition. Persists nothing — review the returned draft, then save it with `POST /v1/connectors`. `sk connectors import --spec` calls this.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: importConnectorFromSpecInputSchema } },
    },
  },
  responses: {
    200: {
      description: "The parsed draft, or a pointer to an equivalent connector that already exists",
      content: { "application/json": { schema: ImportConnectorResponse } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

/**
 * A `ConnectorView` for a definition that has no row yet.
 *
 * The drivers take a `ConnectorView`, so the unsaved definition has to look
 * like one. The synthetic id is deliberately not a UUID: it appears in probe
 * error text, and `unsaved` reads as what it is rather than as a row someone
 * could go look up. Nothing reads this id from the database — the credential
 * arrives as an override precisely so no lookup happens.
 */
function draftConnectorView(input: z.infer<typeof CreateConnectorSchema>): ConnectorView {
  return {
    id: "unsaved",
    tenant_id: "",
    slug: input.slug ?? "unsaved",
    display_name: input.name,
    driver: input.driver as DriverName,
    environment: input.environment ?? "dev",
    auth_type: input.auth_type ?? "none",
    base_url: input.base_url ?? null,
    dsn: input.dsn ?? null,
    config: withMcpConfigDefaults(
      input.driver as DriverName,
      input.auth_type ?? "none",
      input.config as Record<string, unknown> | undefined,
    ),
    operator_quirks: (input.operator_quirks ?? {}) as ConnectorView["operator_quirks"],
    template_slug: input.template_slug ?? null,
    template_name: null,
    template_source: input.template_source ?? null,
    template_version: null,
    template_snapshot: null,
    self_description: {},
    created_at: new Date(),
    updated_at: new Date(),
    // A draft is by definition not disabled and has no failure history —
    // there is no row it could have been recorded against.
    enabled: true,
    last_error: null,
    circuit_state: "closed",
    circuit_opened_at: null,
    circuit_failure_count: 0,
    circuit_threshold: 5,
    circuit_reset_ms: 300000,
    needs_reauth: false,
    auth_failed_at: null,
    auth_failed_reason: null,
    health_state: "ok",
    health_reason: null,
    health_error_code: null,
    sunset_at: null,
    successor_uri: null,
  };
}

export function registerAuthoringRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(validateRoute, async (c) => {
    requireAuth(c);
    const body = c.req.valid("json");
    const effectiveConfig = withMcpConfigDefaults(
      body.driver as DriverName,
      body.auth_type ?? "none",
      body.config as Record<string, unknown> | undefined,
    );
    // Both driver-dependent fields, so `validate` refuses exactly what
    // `POST /v1/connectors` refuses — an author who validates first must not
    // then be surprised by the save.
    const issues = [
      ...validateConnectorConfig(body.driver as DriverName, effectiveConfig),
      ...validateConnectorAuthType(body.driver as DriverName, body.auth_type),
      ...validateMcpAuthConsistency(body.driver as DriverName, body.auth_type, effectiveConfig),
    ];
    // A malformed definition is a 200 with `ok:false`, not a 4xx: the request
    // itself was well-formed, and the caller asked a question rather than
    // attempting a write. Same shape as `POST /v1/workflows/validate`.
    return c.json({ ok: issues.length === 0, issues }, 200);
  });

  app.openapi(probeRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");

    const connector = draftConnectorView(body.connector);
    // An explicit `null` override (rather than leaving it undefined) is what
    // stops the driver from falling back to a credential lookup for the
    // synthetic id and probing unauthenticated.
    const credential = body.credential ? credentialBodyToValue(body.credential) : null;

    const result = await probeConnector({
      db,
      tenant_id: principal.tenant_id,
      connector: { ...connector, tenant_id: principal.tenant_id },
      credential_override: credential,
    });
    return c.json(result, 200);
  });

  app.openapi(importRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const args = c.req.valid("json");
    const result = await importConnectorDraftFromSpec({
      args,
      tenant_id: principal.tenant_id,
      db,
    });
    return c.json(result, 200);
  });
}
