import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  createNotificationRuleOperation,
  deleteNotificationRuleOperation,
  listNotificationRulesOperation,
  SeverityEnum,
  updateNotificationRuleOperation,
} from "../../../api/operations/notification-rules.ts";
import { testRule } from "../../../notifications/index.ts";
import { serviceMetadataFromHono } from "../../../observability/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

const TestRuleBody = z
  .object({
    event_type: z.string().min(1).default("notifications.test"),
    workflow_id: z.string().nullable().optional(),
    workflow_slug: z.string().nullable().optional(),
    severity: SeverityEnum.optional(),
    payload: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi("TestNotificationRuleBody");

const TestRuleResponse = z
  .object({
    matched: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    outcomes: z.array(
      z.object({
        rule_id: z.string(),
        channel_id: z.string(),
        status: z.string(),
        reason: z.string().nullable().optional(),
        error: z.string().nullable().optional(),
      }),
    ),
  })
  .openapi("TestNotificationRuleResponse");

const testRoute = createRoute({
  method: "post",
  path: "/v1/notifications/rules/:id/test",
  tags: ["notifications"],
  summary:
    "Synthesise a notification event and dispatch it through the rule pipeline. Returns the rule-matching, rate-limit, and channel-dispatch outcome so operators can verify a rule end-to-end without waiting for a real workflow run.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: TestRuleBody } } },
  },
  responses: {
    200: {
      description: "Dispatch outcome",
      content: { "application/json": { schema: TestRuleResponse } },
    },
    404: {
      description: "Rule not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerRuleRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/notifications/rules/:id/test", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "POST") {
      return requirePermission("notification:write", () => ({ type: "notification_rule", id }))(
        c,
        next,
      );
    }
    return next();
  });

  toHonoRoute(app, listNotificationRulesOperation);
  toHonoRoute(app, createNotificationRuleOperation);
  toHonoRoute(app, updateNotificationRuleOperation);
  toHonoRoute(app, deleteNotificationRuleOperation);

  app.openapi(testRoute, async (c) => {
    const meta = serviceMetadataFromHono(c);
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    const result = await testRule(
      c.get("db"),
      {
        tenant_id: meta.tenant_id,
        actor_type: principal.kind,
        actor_id: meta.actor_id ?? principal.id,
        trace_id: meta.trace_id,
        request_source: meta.request_source,
      },
      id,
      c.req.valid("json"),
    );
    if (!result) throw new NotFoundError("notification_rule");
    return c.json(
      {
        matched: result.matched,
        delivered: result.delivered,
        outcomes: result.outcomes.map((o) => ({
          rule_id: o.rule_id,
          channel_id: o.channel_id,
          status: o.status,
          reason: o.reason ?? null,
          error: o.error ?? null,
        })),
      },
      200,
    );
  });
}
