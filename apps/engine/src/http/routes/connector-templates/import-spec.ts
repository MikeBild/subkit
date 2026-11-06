import { type OpenAPIHono, z } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import { defineOperation, reject } from "../../../api/operations/index.ts";
import type { AppEnv } from "../../openapi.ts";

const ImportRequestSchema = z
  .object({
    source: z.enum([
      "postman",
      "har",
      "openapi",
      "google_discovery",
      "graphql",
      "graphql_introspection",
      "curl",
    ]),
    content: z
      .string()
      .min(1)
      .describe(
        "Inline specification content or a source-specific URL/command. URL-fetched OpenAPI and Google Discovery documents are streamed with a 50 MiB limit; specification metadata seeds the connector draft.",
      ),
    headers: z.record(z.string(), z.string()).optional(),
    name: z.string().min(1).optional(),
    environment: z.enum(["dev", "prod"]).default("dev"),
    base_url_environment: z.string().optional(),
  })
  .openapi("ConnectorSpecImportRequest");

const ImportDraftSchema = z
  .object({
    name: z.string().optional(),
    slug: z.string().optional(),
    driver: z.string(),
    environment: z.string(),
    base_url: z.string().optional(),
    auth_type: z.string(),
    config: z.record(z.string(), z.unknown()),
  })
  .openapi("ConnectorSpecImportDraft");

const ImportResponseSchema = z
  .object({
    draft: ImportDraftSchema,
    template_match: z
      .object({
        slug: z.string(),
        score: z.number(),
        matched_segment: z.string(),
      })
      .nullable(),
    recommended_next: z.array(z.string()),
  })
  .openapi("ConnectorSpecImportResponse");

type ImportRequest = z.infer<typeof ImportRequestSchema>;

const importConnectorSpecOperation = defineOperation<
  ImportRequest,
  z.infer<typeof ImportResponseSchema>
>({
  id: "connector_template.import_spec",
  summary:
    "Import a connector draft from an API collection, HAR, OpenAPI/Google Discovery/GraphQL spec, or curl command",
  permission: "connector:write",
  effect: "read",
  handler: async (_scope, body) => {
    const tool = await import("../../../conversations/tools/import-connector-from-spec.ts");
    try {
      const result = await tool.importConnectorFromSpecTool.execute(
        {} as Parameters<typeof tool.importConnectorFromSpecTool.execute>[0],
        body,
      );
      if (!result.ok) {
        return reject.badRequest(
          String((result.data as { error?: string } | null)?.error ?? "import failed"),
        );
      }
      return result.data as z.infer<typeof ImportResponseSchema>;
    } catch (err) {
      const mod = await import("../../../connectors/spec-fetchers.ts");
      if (err instanceof mod.SpecFetchError) {
        return reject.badRequest(`spec fetch failed: ${err.message}`);
      }
      throw err;
    }
  },
  http: {
    method: "post",
    path: "/v1/connector-templates/import",
    tags: ["connectors"],
    description:
      "URL-fetched OpenAPI and Google Discovery documents are streamed with a 50 MiB limit. Specification server and authentication metadata seed the draft.",
    body: ImportRequestSchema,
    response: ImportResponseSchema,
    errors: { 400: "Bad request", 502: "Upstream spec fetch failed" },
    toInput: ({ json }) => json as ImportRequest,
    toBody: (result) => result,
  },
});

export function registerImportRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, importConnectorSpecOperation);
}
