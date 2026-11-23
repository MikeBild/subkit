import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  decideRule,
  listRules,
  type RuleDecision,
  usesToday,
} from "../../conversations/public/policy.ts";
import {
  TOOL_APPROVAL_CONTENT_CLASSES,
  TOOL_APPROVAL_RULE_STATES,
  type ToolApprovalRuleRow,
} from "../../db/schema/index.ts";
import { requireSignedInPerson } from "../../http/middleware/auth.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, type OperationScope, type Rejection, reject } from "./index.ts";

const TAGS = ["approval-rules"] as const;

const RuleStateSchema = z.enum(TOOL_APPROVAL_RULE_STATES);

export const ToolApprovalRuleSchema = z
  .object({
    id: z.string().uuid(),
    state: RuleStateSchema.describe(
      "offered: waiting for the person's decision. active: matching actions run without a confirmation. dismissed and revoked rules never apply.",
    ),
    tool: z.string(),
    verb: z.string(),
    target: z.string().nullable().describe("The exact target the rule is limited to."),
    account: z.string().nullable().describe("The connector or account the rule is limited to."),
    connector: z.string().nullable().describe("The connector the rule is limited to."),
    operation: z
      .string()
      .nullable()
      .describe("The one operation the rule is limited to, e.g. `POST /v1/messages/send`."),
    content_class: z
      .enum(TOOL_APPROVAL_CONTENT_CLASSES)
      .describe(
        "no_content: only actions that carry no text. same_content: only the exact text that was approved. person_given: only text the person wrote themselves or saw as a draft in the conversation.",
      ),
    expires_at: z
      .string()
      .nullable()
      .describe("When the rule stops applying unless it is renewed; set when the rule is stored."),
    expired: z.boolean().describe("True when an active rule is past its expiry and asks again."),
    daily_limit: z.number().int().describe("How often per day (UTC) the rule lets an action run."),
    uses_today: z.number().int().describe("How often the rule let an action run today (UTC)."),
    recipients: z
      .array(z.string())
      .describe("The only recipients the rule covers. Empty: actions without a recipient."),
    source_quote: z
      .string()
      .nullable()
      .describe("The person's own words the rule was created from, when it was stated in chat."),
    approvals_count: z.number().int().describe("How often the person approved this exact action."),
    use_count: z.number().int().describe("How often the rule let an action run."),
    offered_at: z.string().nullable(),
    decided_at: z.string().nullable(),
    revoked_at: z.string().nullable(),
    last_used_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("ToolApprovalRule");

const RuleListResponse = z
  .object({ items: z.array(ToolApprovalRuleSchema) })
  .openapi("ToolApprovalRuleListResponse");

const RuleListQuery = z.object({
  state: RuleStateSchema.optional().describe(
    "Only rules in this state. Omitted: offered and active rules.",
  ),
});

type RuleView = z.infer<typeof ToolApprovalRuleSchema>;

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function serialize(row: ToolApprovalRuleRow): RuleView {
  const now = new Date();
  return {
    connector: row.scope.account,
    operation: row.scope.target,
    content_class: row.content_class,
    expires_at: iso(row.expires_at),
    expired:
      row.state === "active" &&
      (row.expires_at === null || row.expires_at.getTime() <= now.getTime()),
    daily_limit: row.daily_limit,
    uses_today: usesToday(row, now),
    id: row.id,
    state: row.state,
    tool: row.tool,
    verb: row.scope.verb,
    target: row.scope.target,
    account: row.scope.account,
    recipients: row.scope.recipients,
    source_quote: row.source_quote,
    approvals_count: row.approvals_count,
    use_count: row.use_count,
    offered_at: iso(row.offered_at),
    decided_at: iso(row.decided_at),
    revoked_at: iso(row.revoked_at),
    last_used_at: iso(row.last_used_at),
    created_at: row.created_at.toISOString(),
  };
}

function person(scope: OperationScope): ResolvedPrincipal | Rejection {
  const principal = scope.principal;
  if (!principal) return reject.unauthorized();
  if (principal.kind !== "user")
    return reject.status(
      403,
      "person_required",
      "Approval rules belong to a person; a system account has none.",
    );
  return principal;
}

function isRejected(value: ResolvedPrincipal | Rejection): value is Rejection {
  return (value as Rejection).rejected === true;
}

interface ListInput {
  readonly state?: z.infer<typeof RuleStateSchema>;
}

export const listApprovalRulesOperation = defineOperation<ListInput, ToolApprovalRuleRow[]>({
  id: "approval_rules.list",
  summary: "List the signed-in person's approval rules and open rule offers",
  permission: null,
  effect: "read",
  async handler(scope, { state }) {
    const principal = person(scope);
    if (isRejected(principal)) return principal;
    return listRules(
      scope.db,
      { tenant_id: scope.tenant_id, user_id: principal.id },
      state ? [state] : undefined,
    );
  },
  http: {
    method: "get",
    path: "/v1/approval-rules",
    tags: TAGS,
    query: RuleListQuery,
    response: RuleListResponse,
    errors: { 401: "Unauthorized", 403: "person_required — only a person has approval rules" },
    toInput: ({ query }) => query as ListInput,
    toBody: (rows) => ({ items: rows.map(serialize) }),
  },
});

interface IdInput {
  readonly id: string;
}

function decisionOperation(p: {
  decision: RuleDecision;
  id: string;
  summary: string;
  audit: (typeof AuditAction)[keyof typeof AuditAction];
  method: "post" | "delete";
  signedIn?: boolean;
  path: string;
  wrongState: string;
}) {
  return defineOperation<IdInput, ToolApprovalRuleRow>({
    id: p.id,
    summary: p.summary,
    permission: null,
    effect: "write",
    audit: p.audit,
    async handler(scope, { id }) {
      const principal = person(scope);
      if (isRejected(principal)) return principal;
      if (p.decision === "accept" || p.signedIn === true) {
        requireSignedInPerson(
          principal,
          "a signed-in browser session is required to store an approval rule",
        );
      }
      const result = await decideRule(
        scope.db,
        { tenant_id: scope.tenant_id, user_id: principal.id },
        id,
        p.decision,
      );
      if (result.ok) return result.rule;
      if (result.code === "not_found") return reject.notFound("approval rule");
      return reject.conflict(p.wrongState, { state: result.state }, "approval_rule_wrong_state");
    },
    http: {
      method: p.method,
      path: p.path,
      tags: TAGS,
      params: IdParam,
      response: ToolApprovalRuleSchema,
      errors: {
        401: "Unauthorized",
        403: "A signed-in person is required",
        404: "Not found",
        409: "approval_rule_wrong_state — the rule is not in the state this decision needs",
      },
      toInput: ({ param }) => ({ id: (param as IdInput).id }),
      toBody: serialize,
    },
  });
}

export const acceptApprovalRuleOperation = decisionOperation({
  decision: "accept",
  id: "approval_rules.accept",
  summary:
    "Store an offered rule: from now on exactly this action on exactly this target runs without a confirmation",
  audit: AuditAction.TOOL_APPROVAL_RULE_CREATED,
  method: "post",
  path: "/v1/approval-rules/{id}/accept",
  wrongState: "Only an offered rule can be stored.",
});

export const dismissApprovalRuleOperation = decisionOperation({
  decision: "dismiss",
  id: "approval_rules.dismiss",
  summary: "Decline an offered rule; it is not offered again",
  audit: AuditAction.TOOL_APPROVAL_RULE_DISMISSED,
  method: "post",
  path: "/v1/approval-rules/{id}/dismiss",
  wrongState: "Only an offered rule can be declined.",
});

export const revokeApprovalRuleOperation = decisionOperation({
  decision: "revoke",
  id: "approval_rules.revoke",
  summary: "Revoke an active rule; the action asks again from the next time on",
  audit: AuditAction.TOOL_APPROVAL_RULE_REVOKED,
  method: "delete",
  path: "/v1/approval-rules/{id}",
  wrongState: "Only an active rule can be revoked.",
});

export const renewApprovalRuleOperation = decisionOperation({
  decision: "renew",
  id: "approval_rules.renew",
  summary:
    "Renew an active rule: it applies for another 90 days from now, also when it had already expired",
  audit: AuditAction.TOOL_APPROVAL_RULE_RENEWED,
  method: "post",
  path: "/v1/approval-rules/{id}/renew",
  wrongState: "Only an active rule can be renewed.",
  signedIn: true,
});
