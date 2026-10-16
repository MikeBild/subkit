import { z } from "@hono/zod-openapi";

export const AppCheckKeySchema = z
  .enum([
    "product_configured",
    "sign_in_provider",
    "assistant_workflow",
    "execution_authority",
    "credentials",
    "budget_guard",
  ])
  .openapi("AppCheckKey");

export const AppCheckSchema = z
  .object({
    key: AppCheckKeySchema,
    ok: z.boolean(),
    message: z.string(),
    next_action: z.string().nullable(),
  })
  .openapi("AppCheck");

export const AppSignInSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    protocol: z.enum(["oidc", "oidc_bearer"]),
    issuer_url: z.string(),
    tenant_slug: z.string(),
    audience: z.string().nullable(),
    algorithms: z.array(z.string()).nullable(),
    required_claims: z.array(z.object({ path: z.string(), equals: z.unknown() })),
    reject_anonymous: z.boolean().nullable(),
  })
  .openapi("AppSignIn");

export const AppWorkflowSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    lifecycle: z.enum(["draft", "active", "archived"]),
    is_assistant: z.boolean(),
    definition_valid: z.boolean(),
  })
  .openapi("AppWorkflow");

export const AppSettingsSchema = z
  .object({
    execution_environment: z.enum(["dev", "prod"]),
    budget_bucket: z.string(),
    assistant_workflow: z.object({
      id: z.string().uuid(),
      name: z.string().nullable(),
      slug: z.string().nullable(),
    }),
    daily_limit: z
      .object({
        bucket: z.string(),
        limit_per_caller: z.number().int(),
        unit: z.string(),
        tz: z.string(),
      })
      .nullable()
      .describe("caller_daily_limit of the assistant workflow; limit_per_caller counts per caller"),
  })
  .openapi("AppSettings");

export const AppBudgetTodaySchema = z
  .object({
    bucket: z.string(),
    day: z.string(),
    tz: z.string(),
    resets_at: z.string(),
    consumed: z.number().int().nonnegative(),
    reserved: z.number().int().nonnegative(),
    refusals_today: z.number().int().nonnegative(),
  })
  .openapi("AppBudgetToday");

export const AppSummarySchema = z
  .object({
    id: z.string(),
    configured: z.boolean(),
    ready: z.boolean(),
    settings: AppSettingsSchema.nullable(),
    sign_in_count: z.number().int().nonnegative(),
    workflow_count: z.number().int().nonnegative(),
    users: z.object({
      count: z.number().int().nonnegative(),
      last_seen_at: z.string().nullable(),
    }),
    failing_checks: z.array(AppCheckKeySchema),
  })
  .openapi("AppSummary");

export const AppViewSchema = AppSummarySchema.omit({ failing_checks: true })
  .extend({
    sign_in: z.array(AppSignInSchema),
    workflows: z.array(AppWorkflowSchema),
    budget_today: AppBudgetTodaySchema.nullable(),
    checks: z.array(AppCheckSchema),
  })
  .openapi("AppView");

export const AppListResponseSchema = z
  .object({ items: z.array(AppSummarySchema) })
  .openapi("AppListResponse");

export const AppIdParam = z.object({
  id: z
    .string()
    .max(128)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .openapi({ param: { name: "id", in: "path" } }),
});

export type AppCheckKey = z.infer<typeof AppCheckKeySchema>;
export type AppCheck = z.infer<typeof AppCheckSchema>;
export type AppSignIn = z.infer<typeof AppSignInSchema>;
export type AppWorkflow = z.infer<typeof AppWorkflowSchema>;
export type AppSettings = z.infer<typeof AppSettingsSchema>;
export type AppBudgetToday = z.infer<typeof AppBudgetTodaySchema>;
export type AppSummary = z.infer<typeof AppSummarySchema>;
export type AppView = z.infer<typeof AppViewSchema>;
