import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { BadRequestError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
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

const importRoute = createRoute({
  method: "post",
  path: "/v1/connector-templates/import",
  tags: ["connectors"],
  summary:
    "Import a connector draft from an API collection, HAR, OpenAPI/Google Discovery/GraphQL spec, or curl command",
  description:
    "URL-fetched OpenAPI and Google Discovery documents are streamed with a 50 MiB limit. Specification server and authentication metadata seed the draft.",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: ImportRequestSchema } } } },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: ImportResponseSchema } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    502: {
      description: "Upstream spec fetch failed",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerImportRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(importRoute, async (c) => {
    requireAuth(c);
    const body = c.req.valid("json");
    const tool = await import("../../../conversations/tools/import-connector-from-spec.ts");
    try {
      const result = await tool.importConnectorFromSpecTool.execute(
        {} as Parameters<typeof tool.importConnectorFromSpecTool.execute>[0],
        body,
      );
      if (!result.ok) {
        throw new BadRequestError(
          String((result.data as { error?: string } | null)?.error ?? "import failed"),
        );
      }
      const data = result.data as {
        draft: unknown;
        template_match: { slug: string; score: number; matched_segment: string } | null;
        recommended_next: string[];
      };
      return c.json(data as z.infer<typeof ImportResponseSchema>, 200);
    } catch (err) {
      const mod = await import("../../../connectors/spec-fetchers.ts");
      if (err instanceof mod.SpecFetchError) {
        throw new BadRequestError(`spec fetch failed: ${err.message}`);
      }
      throw err;
    }
  });
}
