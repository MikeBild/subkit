// Import a connector draft from an API collection, an HTTP archive
// (HAR), an OpenAPI/GraphQL spec, or a curl command:
//   POST /v1/connector-templates/import

import { createRoute, type OpenAPIHono, type z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { BadRequestError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { ImportRequestSchema, ImportResponseSchema } from "./schemas.ts";

const importRoute = createRoute({
  method: "post",
  path: "/v1/connector-templates/import",
  tags: ["connectors"],
  summary:
    "Import a connector draft from an API collection, HAR, OpenAPI/GraphQL spec, or curl command",
  description:
    "URL-fetched OpenAPI documents are streamed with a 50 MiB limit. OpenAPI server and security metadata seed the draft base URL and authentication type.",
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
        // The tool only uses args — context is unused for the import operation.
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
