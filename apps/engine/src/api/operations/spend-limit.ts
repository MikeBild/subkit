import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import { resumeBudgetParkedRuns } from "../../execution/budget-park.ts";
import { readSpend, type SpendReading } from "../../llm/accounting/spend.ts";
import { continueSpendMonth, writeSpendLimit } from "../../llm/accounting/spend-settings.ts";
import {
  RUN_NOTICE_USD,
  SPEND_LIMIT_CHOICES,
  SPEND_WARNING_SHARE,
} from "../../llm/core/spend-budget.ts";
import { invalidateAttention } from "../../operator/attention.ts";
import { SPEND_ADMIN_PERMISSION } from "../../operator/spend-attention.ts";
import { principalHolds } from "../../rbac/evaluator.ts";
import { now } from "../../utils/clock.ts";
import { defineOperation, type OperationScope, type Rejection, reject } from "./index.ts";

const TAGS = ["identity"] as const;
export const SPEND_LIMIT_ROUTE = "/v1/workspace/spend-limit";

export const SpendLimitSchema = z
  .object({
    currency: z
      .string()
      .describe("tokens.currency of the workspace. The budget only applies when it is USD."),
    month: z.string().describe("The current month in the workspace time zone, YYYY-MM."),
    timezone: z.string().describe("The workspace time zone the month is read in."),
    from: z.string().describe("Start of the month, inclusive."),
    to: z.string().describe("Start of the next month, exclusive."),
    limit_usd: z
      .number()
      .nullable()
      .describe("The monthly limit in US dollars; null means no limit."),
    spent_usd: z
      .number()
      .describe("Cost of priced model calls this month. Unpriced calls do not count."),
    unpriced_calls: z.number().int().nonnegative(),
    share: z.number().nullable().describe("spent_usd / limit_usd; null without a limit."),
    state: z
      .enum(["unlimited", "ok", "warning", "reached", "continued"])
      .describe(
        "warning from 80 %. reached: chat, tasks and model steps in workflows pause. continued: an admin chose to go on without a limit this month.",
      ),
    countable: z
      .boolean()
      .describe(
        "false when tokens.currency is not USD; then no dollar amount is known and nothing is limited.",
      ),
    warning_share: z.number(),
    run_notice_usd: z
      .number()
      .describe("A single chat turn or task run above this cost shows one notice."),
    choices: z.array(z.number()).describe("The limits setup offers; 0 means no limit."),
    limit_chosen: z
      .boolean()
      .describe(
        "false for a workspace that existed before the AI budget and has not chosen a limit yet; it starts without a limit.",
      ),
    can_change: z
      .boolean()
      .describe("Whether the caller may raise the limit or continue this month."),
  })
  .openapi("SpendLimit");

interface SpendView {
  reading: SpendReading;
  can_change: boolean;
}

export async function spendView(scope: OperationScope): Promise<SpendView> {
  const reading = await readSpend(scope.tenant_id, scope.db, new Date(now()));
  const can_change =
    scope.principal !== null &&
    (await principalHolds(scope.db, scope.principal, SPEND_ADMIN_PERMISSION));
  return { reading, can_change };
}

export function spendBody({ reading, can_change }: SpendView) {
  return {
    currency: reading.currency,
    month: reading.month,
    timezone: reading.timezone,
    from: reading.window.from.toISOString(),
    to: reading.window.to.toISOString(),
    limit_usd: reading.limit_usd,
    spent_usd: reading.spent_usd,
    unpriced_calls: reading.unpriced_calls,
    share: reading.share,
    state: reading.state,
    countable: reading.countable,
    warning_share: SPEND_WARNING_SHARE,
    run_notice_usd: RUN_NOTICE_USD,
    choices: [...SPEND_LIMIT_CHOICES],
    limit_chosen: reading.chosen,
    can_change,
  };
}

const ERRORS = { 401: "Unauthorized" } as const;

const WRITE_ERRORS = {
  ...ERRORS,
  403: "Forbidden — identity:write (workspace admin) is required",
} as const;

export const getSpendLimitOperation = defineOperation<null, SpendView>({
  id: "workspace.spend_limit.get",
  summary: "Read this month's AI spending against the workspace limit",
  permission: "stats:read",
  effect: "read",
  handler: (scope) => spendView(scope),
  http: {
    method: "get",
    path: SPEND_LIMIT_ROUTE,
    tags: TAGS,
    response: SpendLimitSchema,
    errors: { ...ERRORS, 403: "Forbidden — stats:read is required, like the usage figures" },
    toInput: () => null,
    toBody: spendBody,
  },
});

const PutSpendLimitBody = z
  .object({
    limit_usd: z
      .number()
      .nonnegative()
      .max(1_000_000)
      .describe("New monthly limit in US dollars. 0 means no limit."),
  })
  .strict()
  .openapi("PutSpendLimitBody");

type PutInput = z.infer<typeof PutSpendLimitBody>;

export const putSpendLimitOperation = defineOperation<PutInput, SpendView>({
  id: "workspace.spend_limit.put",
  summary: "Set the monthly AI spending limit in US dollars",
  permission: SPEND_ADMIN_PERMISSION,
  effect: "write",
  audit: AuditAction.WORKSPACE_SPEND_LIMIT_CHANGED,
  async handler(scope, input): Promise<SpendView | Rejection> {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    await writeSpendLimit(scope.db, principal, input.limit_usd, scope.request_source ?? "api");
    invalidateAttention(scope.tenant_id);
    await resumeBudgetParkedRuns(scope.db, scope.tenant_id, scope.boss);
    return spendView(scope);
  },
  http: {
    method: "put",
    path: SPEND_LIMIT_ROUTE,
    tags: TAGS,
    description:
      "Sets the workspace's monthly AI budget. It is a workspace decision, also in hosted workspaces. A higher limit than this month's spending lets paused chat, tasks and workflow runs continue at once.",
    body: PutSpendLimitBody,
    response: SpendLimitSchema,
    errors: WRITE_ERRORS,
    toInput: ({ json }) => json as PutInput,
    toBody: spendBody,
  },
});

export const continueSpendOperation = defineOperation<null, SpendView>({
  id: "workspace.spend_limit.continue",
  summary: "Let model work continue without a limit for the rest of this month",
  permission: SPEND_ADMIN_PERMISSION,
  effect: "write",
  audit: AuditAction.WORKSPACE_SPEND_CONTINUED,
  async handler(scope): Promise<SpendView | Rejection> {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const current = await readSpend(scope.tenant_id, scope.db, new Date(now()));
    if (current.limit_usd === null)
      return reject.conflict("There is no monthly limit to continue past.", undefined, "no_limit");
    await continueSpendMonth(scope.db, principal, current.month, scope.request_source ?? "api");
    invalidateAttention(scope.tenant_id);
    await resumeBudgetParkedRuns(scope.db, scope.tenant_id, scope.boss);
    return spendView(scope);
  },
  http: {
    method: "post",
    path: `${SPEND_LIMIT_ROUTE}/continue`,
    tags: TAGS,
    description:
      "Model work runs past the limit until the month ends in the workspace time zone; the next month starts with the limit again.",
    response: SpendLimitSchema,
    errors: {
      ...WRITE_ERRORS,
      409: "no_limit — there is no limit to continue past",
    },
    toInput: () => null,
    toBody: spendBody,
  },
});
