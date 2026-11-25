import type { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import type { ConversationDetail } from "../../conversations/types.ts";
import type { Db } from "../../db/client.ts";
import {
  ToolPoliciesResponse,
  ToolPoliciesSchema,
} from "../../http/routes/conversations/schemas.ts";
import { IdParam } from "../common-schemas.ts";
import { requireBrowserSession } from "./browser-session.ts";
import { defineOperation, isRejection, reject } from "./index.ts";

type ToolPolicyMode = "no_confirm" | "confirm_before_execution" | "confirm_after_execution";
type PoliciesBody = z.infer<typeof ToolPoliciesSchema>;

interface ToolPoliciesView {
  policies: Record<string, ToolPolicyMode>;
  eligible_no_confirm_tools: string[];
}

interface IdInput {
  readonly id: string;
}

interface PutInput extends IdInput {
  readonly body: PoliciesBody;
}

export interface ConversationToolPolicyServices {
  getConversation(tenant_id: string, id: string, exec: Db): Promise<ConversationDetail | null>;
  getToolPolicies(
    db: Db,
    tenant_id: string,
    conversation_id: string,
  ): Promise<Record<string, ToolPolicyMode>>;
  eligibleNoConfirmTools(): string[];
  canSetConversationToolPolicy(toolName: string, mode: ToolPolicyMode | null): boolean;
  setToolPolicies(
    db: Db,
    tenant_id: string,
    conversation_id: string,
    policies: Record<string, ToolPolicyMode | null>,
    audit: {
      actor_type: "user" | "system_account" | "system" | "unknown";
      actor_id: string | null;
      request_source: "api";
    },
  ): Promise<void>;
}

function idOf(param: unknown): string {
  return (param as IdInput).id;
}

function same<T>(result: T): T {
  return result;
}

export function conversationToolPolicyOperations(svc: ConversationToolPolicyServices) {
  async function view(db: Db, tenant_id: string, id: string): Promise<ToolPoliciesView> {
    const policies = await svc.getToolPolicies(db, tenant_id, id);
    return { policies, eligible_no_confirm_tools: svc.eligibleNoConfirmTools() };
  }

  const get = defineOperation<IdInput, ToolPoliciesView>({
    id: "conversation.tool_policies.get",
    summary: "Read per-tool execution-mode overrides for this conversation",
    permission: "conversation:read",
    alternatePermissions: ["workflow:read"],
    effect: "read",
    async handler(scope, { id }) {
      if (!scope.principal) return reject.unauthorized();
      const detail = await svc.getConversation(scope.tenant_id, id, scope.db);
      if (!detail) return reject.notFound("conversation");
      return view(scope.db, scope.tenant_id, id);
    },
    http: {
      method: "get",
      path: "/v1/conversations/{id}/tool-policies",
      tags: ["conversations"],
      params: IdParam,
      response: ToolPoliciesResponse,
      errors: { 404: "Not found" },
      toInput: ({ param }) => ({ id: idOf(param) }),
      toBody: same,
    },
  });

  const put = defineOperation<PutInput, ToolPoliciesView>({
    id: "conversation.tool_policies.set",
    summary:
      "Set per-tool execution-mode overrides. Pass `null` for a tool to clear its override and fall back to the default policy.",
    permission: "conversation:approve",
    alternatePermissions: ["workflow:write"],
    effect: "write",
    audit: AuditAction.TOOL_POLICY_CHANGED,
    async handler(scope, { id, body }) {
      const principal = scope.principal;
      if (!principal) return reject.unauthorized();
      const detail = await svc.getConversation(scope.tenant_id, id, scope.db);
      if (!detail) return reject.notFound("conversation");
      for (const [toolName, mode] of Object.entries(body.policies)) {
        if (!svc.canSetConversationToolPolicy(toolName, mode)) {
          return reject.unprocessable(
            "this confirmation mode is not allowed for the tool in a conversation",
            undefined,
            "tool_policy_mode_not_allowed",
          );
        }
      }
      if (Object.values(body.policies).some((mode) => mode === "no_confirm")) {
        const signedIn = requireBrowserSession(
          principal,
          "a signed-in browser session is required to skip confirmation in a conversation",
        );
        if (isRejection(signedIn)) return signedIn;
      }
      await svc.setToolPolicies(scope.db, scope.tenant_id, id, body.policies, {
        actor_type: principal.kind,
        actor_id: principal.id,
        request_source: "api",
      });
      return view(scope.db, scope.tenant_id, id);
    },
    http: {
      method: "put",
      path: "/v1/conversations/{id}/tool-policies",
      tags: ["conversations"],
      params: IdParam,
      body: ToolPoliciesSchema,
      response: ToolPoliciesResponse,
      errors: {
        422: "The requested confirmation mode is not permitted for this tool",
        404: "Not found",
      },
      toInput: ({ param, json }) => ({ id: idOf(param), body: json as PoliciesBody }),
      toBody: same,
    },
  });

  return { get, put };
}
