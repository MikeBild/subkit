import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { connectors, llmUsage, skills, tenants } from "../../db/schema/index.ts";
import {
  monthlyUsageForUser,
  readTenantMonthlyBudget,
  resolveUserMonthlyBudget,
  validateProviderSetup,
} from "../../llm/index.ts";
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
    monthly_budget_tokens: z.number().int().nonnegative().nullable(),
    remaining_monthly_budget_tokens: z.number().int().nullable(),
    monthly_budget_state: z.enum(["ample", "tightening", "critical"]).nullable(),
    tokens_today_user: z.number().int().nonnegative().nullable(),
    tokens_month_user: z.number().int().nonnegative().nullable(),
    user_monthly_budget_tokens: z.number().int().nonnegative().nullable(),
    user_remaining_monthly_budget_tokens: z.number().int().nullable(),
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
    const db = c.get("db");

    const tenantId = principal.tenant_id;

    const now = new Date();
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    const [connectorRow, skillsRow, todayRow, tenantRow, month] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(connectors)
        .where(and(eq(connectors.tenant_id, tenantId), isNull(connectors.deleted_at))),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(skills)
        .where(eq(skills.tenant_id, tenantId)),
      db
        .select({ total: sql<number>`coalesce(sum(${llmUsage.total_tokens}), 0)::int` })
        .from(llmUsage)
        .where(and(eq(llmUsage.tenant_id, tenantId), sql`${llmUsage.created_at} >= ${startOfDay}`)),
      db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
      readTenantMonthlyBudget(tenantId, db),
    ]);

    let userTokensToday: number | null = null;
    let userTokensMonth: number | null = null;
    let userBudget: number | null = null;
    let userRemaining: number | null = null;
    if (principal.kind === "user") {
      const [todayUserRow, monthUser, resolvedUserBudget] = await Promise.all([
        db
          .select({ total: sql<number>`coalesce(sum(${llmUsage.total_tokens}), 0)::int` })
          .from(llmUsage)
          .where(
            and(
              eq(llmUsage.tenant_id, tenantId),
              eq(llmUsage.user_id, principal.id),
              sql`${llmUsage.created_at} >= ${startOfDay}`,
            ),
          ),
        monthlyUsageForUser(tenantId, principal.id, db),
        resolveUserMonthlyBudget(tenantId, principal.id, db),
      ]);
      userTokensToday = Number(todayUserRow[0]?.total ?? 0);
      userTokensMonth = Number(monthUser);
      userBudget = resolvedUserBudget;
      userRemaining =
        resolvedUserBudget == null ? null : Math.max(resolvedUserBudget - userTokensMonth, 0);
    }

    return c.json(
      {
        user: {
          id: principal.id,
          email: principal.email ?? null,
          kind: principal.kind as "user" | "system_account",
        },
        tenant: {
          id: tenantId,
          slug: tenantRow[0]?.slug ?? null,
        },
        connectors_count: Number(connectorRow[0]?.n ?? 0),
        skills_count: Number(skillsRow[0]?.n ?? 0),
        tokens_today: Number(todayRow[0]?.total ?? 0),
        tokens_month: month.used_tokens,
        monthly_budget_tokens: month.budget_tokens,
        remaining_monthly_budget_tokens: month.remaining_tokens,
        monthly_budget_state: month.state,
        tokens_today_user: userTokensToday,
        tokens_month_user: userTokensMonth,
        user_monthly_budget_tokens: userBudget,
        user_remaining_monthly_budget_tokens: userRemaining,
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
