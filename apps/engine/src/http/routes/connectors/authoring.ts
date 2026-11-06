import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { probeConnectorDefinitionOperation } from "../../../api/operations/connector-probe.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import { defineOperation } from "../../../api/operations/index.ts";
import {
  CreateConnectorSchema,
  type DriverName,
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

type ImportArgs = z.infer<typeof importConnectorFromSpecInputSchema>;

const importConnectorDraftOperation = defineOperation<
  ImportArgs,
  Awaited<ReturnType<typeof importConnectorDraftFromSpec>>
>({
  id: "connector.import_draft",
  summary: "Turn an API specification into a connector draft",
  permission: "connector:write",
  effect: "read",
  handler: (scope, args) =>
    importConnectorDraftFromSpec({ args, tenant_id: scope.tenant_id, db: scope.db }),
  http: {
    method: "post",
    path: "/v1/connectors/import",
    tags: ["connectors"],
    description:
      "Parses an OpenAPI/Google Discovery document, a request collection, a HAR, GraphQL SDL or introspection endpoint, or a curl command into a connector definition. Persists nothing — review the returned draft, then save it with `POST /v1/connectors`. `sk connectors import --spec` calls this.",
    body: importConnectorFromSpecInputSchema,
    response: ImportConnectorResponse,
    success: {
      status: 200,
      description: "The parsed draft, or a pointer to an equivalent connector that already exists",
    },
    errors: { 400: "Bad request" },
    toInput: ({ json }) => json as ImportArgs,
    toBody: (result) => result,
  },
});

export function registerAuthoringRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    validateRoute,
    async (c) => {
      requireAuth(c);
      const body = c.req.valid("json");
      const effectiveConfig = withMcpConfigDefaults(
        body.driver as DriverName,
        body.auth_type ?? "none",
        body.config as Record<string, unknown> | undefined,
      );
      const issues = [
        ...validateConnectorConfig(body.driver as DriverName, effectiveConfig),
        ...validateConnectorAuthType(body.driver as DriverName, body.auth_type),
        ...validateMcpAuthConsistency(body.driver as DriverName, body.auth_type, effectiveConfig),
      ];
      return c.json({ ok: issues.length === 0, issues }, 200);
    },
    (result, c) => {
      if (result.success) return undefined;
      const issues = result.error.issues.map((i) => ({
        path: i.path.length > 0 ? i.path.join(".") : "body",
        message: i.message,
      }));
      return c.json({ ok: false, issues }, 200);
    },
  );
  toHonoRoute(app, probeConnectorDefinitionOperation);
  toHonoRoute(app, importConnectorDraftOperation);
}
