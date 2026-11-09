import { z } from "@hono/zod-openapi";

const SourceEnum = z.enum([
  "postman",
  "har",
  "openapi",
  "google_discovery",
  "graphql",
  "graphql_introspection",
  "curl",
]);

export const importConnectorFromSpecInputSchema = z
  .object({
    source: SourceEnum,
    content: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    name: z.string().min(1).optional(),
    environment: z.enum(["dev", "prod"]).default("dev"),
    base_url_environment: z.string().optional(),
    force_new: z
      .boolean()
      .optional()
      .describe(
        "Set true only when the operator explicitly wants a SEPARATE connector on a base_url that already has one. Skips URL reuse and mints an independent draft.",
      ),
  })
  .openapi("ImportConnectorFromSpecToolInput");
