import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { validateProviderSetup } from "../../llm/index.ts";
import { loadStatusSnapshot } from "../../operator/status-snapshot.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { type AppEnv, OPENAPI_INFO } from "../openapi.ts";

const StatusSchema = z
  .object({
    user: z
      .object({
        id: z.string(),
        email: z.string().nullable(),
        kind: z.enum(["user", "system_account"]),
      })
      .openapi("StatusUser"),
    tenant: z
      .object({
        id: z.string(),
        slug: z.string().nullable(),
      })
      .openapi("StatusTenant"),
    connectors_count: z.number().int().nonnegative(),
    skills_count: z.number().int().nonnegative(),
    tokens_today: z.number().int().nonnegative(),
    tokens_month: z.number().int().nonnegative(),
    tokens_today_user: z.number().int().nonnegative().nullable(),
    tokens_month_user: z.number().int().nonnegative().nullable(),
    ai_budget: z
      .object({
        currency: z.string(),
        limit: z.number().nullable().describe("Monthly limit; null means no limit."),
        spent: z.number(),
        state: z.enum(["unlimited", "ok", "warning", "reached", "continued"]),
      })
      .describe("The workspace's monthly AI budget, the only spending limit.")
      .openapi("StatusAiBudget"),
    version: z.string(),
    llm_provider: z
      .object({
        detected: z.string(),
        ok: z.boolean(),
        message: z.string(),
        missing: z.array(z.string()),
      })
      .openapi("StatusLlmProvider"),
  })
  .openapi("StatusSummary");

const route = createRoute({
  method: "get",
  path: "/v1/status",
  tags: ["status"],
  summary: "Composite status snapshot for the CLI header",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: StatusSchema } },
    },
    404: {
      description: "Product principals have no tenant status",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerStatusRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    if (principal.product_id) throw new NotFoundError("status");
    const tenantId = principal.tenant_id;
    const snapshot = await loadStatusSnapshot(
      c.get("db"),
      tenantId,
      principal.kind === "user" ? principal.id : null,
      new Date(),
    );
    const user = snapshot.user;

    return c.json(
      {
        user: {
          id: principal.id,
          email: principal.email ?? null,
          kind: principal.kind as "user" | "system_account",
        },
        tenant: {
          id: tenantId,
          slug: snapshot.tenant_slug,
        },
        connectors_count: snapshot.connectors_count,
        skills_count: snapshot.skills_count,
        tokens_today: snapshot.tokens_today,
        tokens_month: snapshot.tokens_month,
        tokens_today_user: user ? user.tokens_today : null,
        tokens_month_user: user ? user.tokens_month : null,
        ai_budget: {
          currency: snapshot.spend.currency,
          limit: snapshot.spend.limit_usd,
          spent: snapshot.spend.spent_usd,
          state: snapshot.spend.state,
        },
        version: OPENAPI_INFO.version,
        llm_provider: ((report) => ({
          detected: report.detected,
          ok: report.ok,
          message: report.message,
          missing: [...report.missing],
        }))(validateProviderSetup()),
      },
      200,
    );
  });
}
