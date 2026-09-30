// GET /v1/attention — what needs the calling person now.
//
// Authenticated, with no tenant-wide permission of its own: every item is
// checked with `can()` on its subject inside `buildAttention`, and a source the
// caller may not read is reported as `not_permitted` rather than hidden. A
// route-level gate would refuse exactly the readers the per-item check exists
// for — a person holding a grant on one workflow.
//
// Read-only: no audit row is written.

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { buildAttention } from "../../../operator/attention.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { AttentionV1Schema } from "./attention-schema.ts";

const route = createRoute({
  method: "get",
  path: "/v1/attention",
  tags: ["operator"],
  summary: "What needs the caller's attention now",
  description:
    "One list of everything a person has to act on — own waiting conversations, held schedules and webhooks, failing scheduled workflows with their open fixes, connectors and connections needing sign-in, prepared secret versions, skill proposals, a critical budget or risk signal — filtered per item by the caller's permissions.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "attention.v1",
      content: { "application/json": { schema: AttentionV1Schema } },
    },
  },
});

export function registerAttentionRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    return c.json(await buildAttention(c.get("db"), principal), 200);
  });
}
