// Connector health probe:
//   POST /v1/connectors/{id}/test

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import * as connectorSvc from "../../../connectors/index.ts";
import { probeConnector } from "../../../connectors/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { ProbeResultSchema } from "./schemas.ts";

const testRoute = createRoute({
  method: "post",
  path: "/v1/connectors/{id}/test",
  tags: ["connectors"],
  summary: "Probe a connector's health",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ProbeResultSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerTestRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(testRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const connector = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!connector) throw new NotFoundError("connector");
    const result = await probeConnector({ db, tenant_id: principal.tenant_id, connector });
    return c.json(result, 200);
  });
}
