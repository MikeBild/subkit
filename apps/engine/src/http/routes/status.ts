// One-round-trip aggregate so the sk status line doesn't fan out to /connectors + /skills + /usage.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, isNull, sql } from "drizzle-orm";
import { connectors, llmUsage, skills, tenants } from "../../db/schema/index.ts";
import {
  monthlyUsage,
  monthlyUsageForUser,
  resolveMonthlyBudget,
  resolveUserMonthlyBudget,
  validateProviderSetup,
} from "../../llm/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { type AppEnv, OPENAPI_INFO } from "../openapi.ts";

const StatusSchema = z
  .object({
    /** Authenticated principal (user or system account). */
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
    /** Non-deleted connectors in this tenant. */
    connectors_count: z.number().int().nonnegative(),
    /** Skills visible in this tenant (any scope). */
    skills_count: z.number().int().nonnegative(),
    /** Sum of total_tokens today (tenant-local midnight UTC). */
    tokens_today: z.number().int().nonnegative(),
    /** Sum of total_tokens this month. */
    tokens_month: z.number().int().nonnegative(),
    /** Effective monthly budget (null = unlimited). */
    monthly_budget_tokens: z.number().int().nonnegative().nullable(),
    /** Remaining monthly budget tokens (null = unlimited). */
    remaining_monthly_budget_tokens: z.number().int().nullable(),
    /**
     * The CALLER's own usage figures (null for system_account principals,
     * which have no per-user attribution). Powers the `/cost` self-view
     * without a second round-trip.
     */
    tokens_today_user: z.number().int().nonnegative().nullable(),
    tokens_month_user: z.number().int().nonnegative().nullable(),
    /** Caller's own monthly budget (null = no per-user cap or not a user). */
    user_monthly_budget_tokens: z.number().int().nonnegative().nullable(),
    /** Caller's own remaining monthly budget (null = no per-user cap / not a user). */
    user_remaining_monthly_budget_tokens: z.number().int().nullable(),
    /** Engine version, for quick diagnosis of skew. */
    version: z.string(),
    /**
     * LLM provider configuration health. Surfaced so the CLI status
     * line can show a leading warning chip ("⚠ bedrock: AWS_REGION
     * missing") before the user fires their first turn instead of
     * eating a 5xx mid-conversation.
     */
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
  },
});

export function registerStatusRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");

    const tenantId = principal.tenant_id;

    // Midnight UTC for "today". The CLI's clock may diverge; tenant-local
    // zone is out of scope — operators who care wire their own hook.
    const now = new Date();
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    const [connectorRow, skillsRow, todayRow, tenantRow, monthTokens, budget] = await Promise.all([
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
      monthlyUsage(tenantId, db),
      resolveMonthlyBudget(tenantId, db),
    ]);

    const remaining = budget == null ? null : Math.max(budget - monthTokens, 0);

    // Caller's own figures — only when the principal is an end-user.
    // system_account principals have no per-user attribution → null.
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
        tokens_month: Number(monthTokens),
        monthly_budget_tokens: budget,
        remaining_monthly_budget_tokens: remaining,
        tokens_today_user: userTokensToday,
        tokens_month_user: userTokensMonth,
        user_monthly_budget_tokens: userBudget,
        user_remaining_monthly_budget_tokens: userRemaining,
        // `OPENAPI_INFO.version` is the single source of truth for
        // engine version in HTTP surfaces — matches `/health`.
        // `process.env.npm_package_version` is not set in the compiled
        // Bun binary, so that path returned "dev" in production.
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
