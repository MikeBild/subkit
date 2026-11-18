import { z } from "@hono/zod-openapi";
import { actorType } from "../../audit/actor.ts";
import { AuditAction, type AuditActorType } from "../../audit/types.ts";
import { browserSessionForPrincipal } from "../../auth/browser-session.ts";
import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { findTenantSummary } from "../../identity/principal-profile.ts";
import { isWorkspaceOwnerSession } from "../../identity/workspace-settings.ts";
import { modelFamilyMismatch } from "../../llm/model-catalog-view.ts";
import {
  type LlmAccessFailure,
  type LlmAccessProbe,
  probeLlmAccess,
} from "../../llm/runtime/access-probe.ts";
import { modelKeyOwner } from "../../llm/runtime/model-init.ts";
import {
  mockProviderAllowed,
  WORKSPACE_KEY_PROVIDERS,
  workspaceAiAccess,
  workspaceKeyModel,
} from "../../llm/runtime/workspace-access.ts";
import { invalidateAttention } from "../../operator/attention.ts";
import { principalHolds } from "../../rbac/evaluator.ts";
import {
  RuntimeConfigConflictError,
  RuntimeConfigPendingError,
} from "../../runtime-config/contracts.ts";
import { type LlmAccessChange, storeWorkspaceLlmAccess } from "../../runtime-config/llm-access.ts";
import { defineOperation, type Rejection, reject } from "./index.ts";

export const WorkspaceLlmProviderSchema = z
  .enum([...WORKSPACE_KEY_PROVIDERS, "mock"])
  .describe(
    "Provider whose whole access is one API key. `mock` is accepted only by a test or development engine.",
  );

export const WorkspaceLlmKeySchema = z.string().min(1).max(4096);
export const WorkspaceLlmModelSchema = z.string().trim().min(1).max(200);

export const AiAccessSchema = z
  .object({
    configured: z
      .boolean()
      .describe(
        "This workspace can make model calls right now. A self-service workspace needs its own provider key for that; a self-hosted one uses the engine settings.",
      ),
    provider: z.string().nullable().describe("Provider the workspace calls; null when none is set"),
    model: z
      .string()
      .nullable()
      .describe("Model the workspace chose itself; null means the provider's default"),
    own_key: z.boolean().describe("The workspace holds its own provider key"),
  })
  .openapi("AiAccess");

export type LlmAccessRefusalCode =
  | "llm_key_rejected"
  | "llm_model_unavailable"
  | "llm_provider_unreachable"
  | "llm_provider_unavailable";

export interface LlmAccessRefusal {
  readonly ok: false;
  readonly status: 422 | 502;
  readonly code: LlmAccessRefusalCode;
  readonly message: string;
}

const PROVIDER_UNAVAILABLE: LlmAccessRefusal = {
  ok: false,
  status: 422,
  code: "llm_provider_unavailable",
  message:
    "This provider cannot be used with your own key here. Choose Anthropic, OpenAI or Google.",
};

const PROBE_REFUSALS: Record<LlmAccessFailure, LlmAccessRefusal> = {
  key_rejected: {
    ok: false,
    status: 422,
    code: "llm_key_rejected",
    message:
      "The provider did not accept this API key. Check that it is complete and still valid, then try again.",
  },
  model_unavailable: {
    ok: false,
    status: 422,
    code: "llm_model_unavailable",
    message:
      "The provider does not offer this model to your key. Choose another model or keep the default.",
  },
  unreachable: {
    ok: false,
    status: 502,
    code: "llm_provider_unreachable",
    message: "The provider is not answering right now. Try again in a moment.",
  },
  misconfigured: PROVIDER_UNAVAILABLE,
};

export const LLM_ACCESS_REFUSAL_CODES =
  "llm_key_rejected — the provider refused the key; llm_model_unavailable — the provider refused the chosen model; llm_provider_unavailable — this provider cannot be used with an own key on this engine";

interface LlmAccessCandidate {
  provider: z.infer<typeof WorkspaceLlmProviderSchema>;
  api_key: string;
  model?: string;
}

export async function checkLlmAccess(
  candidate: LlmAccessCandidate,
  probe: LlmAccessProbe = probeLlmAccess,
): Promise<{ ok: true } | LlmAccessRefusal> {
  if (candidate.provider === "mock") {
    return mockProviderAllowed() ? { ok: true } : PROVIDER_UNAVAILABLE;
  }
  if (modelKeyOwner(candidate.provider, undefined, candidate.api_key) !== "workspace") {
    return PROVIDER_UNAVAILABLE;
  }
  if (candidate.model && modelFamilyMismatch(candidate.provider, candidate.model)) {
    return PROBE_REFUSALS.model_unavailable;
  }
  const access = await probe({
    provider: candidate.provider,
    api_key: candidate.api_key,
    model: workspaceKeyModel(candidate.provider, candidate.model),
  });
  return access.ok ? { ok: true } : PROBE_REFUSALS[access.code];
}

export async function storeCheckedLlmAccess(
  db: Db,
  input: {
    tenant_id: string;
    actor_type: AuditActorType;
    actor_id: string;
    change: LlmAccessChange;
    source: string;
  },
): Promise<void> {
  await storeWorkspaceLlmAccess(db, {
    tenant_id: input.tenant_id,
    change: input.change,
    actor: { tenant_id: input.tenant_id, actor_type: input.actor_type, actor_id: input.actor_id },
    source: input.source,
  });
  invalidateAttention(input.tenant_id);
}

const AiAccessBody = z
  .object({
    llm_provider: WorkspaceLlmProviderSchema,
    llm_api_key: WorkspaceLlmKeySchema.optional().describe(
      "New provider key. Leave it out to keep the stored key; a different provider always needs its own key.",
    ),
    llm_model: WorkspaceLlmModelSchema.nullable()
      .optional()
      .describe("Model identifier; null or missing uses the provider's default"),
  })
  .strict()
  .openapi("WorkspaceAiAccessBody");

type AiAccessInput = z.infer<typeof AiAccessBody>;
type AiAccessResult = ReturnType<typeof workspaceAiAccess>;

function storedKey(tenantId: string, provider: string): string | null {
  const llm = getConfig(tenantId).llm;
  const key = (llm.providers as Record<string, { api_key?: string } | undefined>)[provider]
    ?.api_key;
  return key && key.length > 0 ? key : null;
}

export const setWorkspaceAiAccessOperation = defineOperation<AiAccessInput, AiAccessResult>({
  id: "identity.workspace.ai_access.set",
  summary: "Set the AI provider, model and key this workspace calls models with",
  permission: null,
  effect: "write",
  audit: AuditAction.SETTINGS_CHANGED,
  async handler(scope, body): Promise<AiAccessResult | Rejection> {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    if (!(await principalHolds(scope.db, principal, "identity:write"))) {
      const session = scope.request
        ? await browserSessionForPrincipal(scope.request, principal)
        : null;
      if (!session || !(await isWorkspaceOwnerSession(session, scope.db)))
        return reject.status(
          403,
          "workspace_admin_required",
          "Only the workspace owner or an administrator can change the AI access.",
        );
    }
    const tenant = await findTenantSummary(scope.db, scope.tenant_id);
    if (!tenant) return reject.notFound("workspace");
    if (tenant.origin !== "self_service")
      return reject.conflict(
        "This workspace takes its AI access from the engine settings. Change it there with settings:write.",
        undefined,
        "self_hosted_workspace",
      );
    const current = workspaceAiAccess(tenant);
    const keepsKey = body.llm_api_key === undefined;
    if (keepsKey && !(current.own_key && current.provider === body.llm_provider)) {
      return reject.unprocessable(
        "Enter the API key for this provider.",
        undefined,
        "llm_key_required",
      );
    }
    const key = body.llm_api_key ?? storedKey(scope.tenant_id, body.llm_provider);
    if (!key)
      return reject.unprocessable(
        "Enter the API key for this provider.",
        undefined,
        "llm_key_required",
      );
    const checked = await checkLlmAccess({
      provider: body.llm_provider,
      api_key: key,
      ...(body.llm_model ? { model: body.llm_model } : {}),
    });
    if (!checked.ok) return reject.status(checked.status, checked.code, checked.message);
    try {
      await storeCheckedLlmAccess(scope.db, {
        tenant_id: scope.tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        change: {
          provider: body.llm_provider,
          model: body.llm_model ?? "",
          ...(keepsKey ? {} : { api_key: key }),
        },
        source: "workspace_ai_access",
      });
    } catch (error) {
      if (error instanceof RuntimeConfigPendingError)
        return reject.conflict(error.message, undefined, error.code);
      if (error instanceof RuntimeConfigConflictError)
        return reject.conflict(
          "Other settings were being saved at the same moment, so your AI access was not saved. Try again in a moment.",
          undefined,
          error.code,
        );
      throw error;
    }
    return workspaceAiAccess(tenant);
  },
  http: {
    method: "patch",
    path: "/v1/identity/workspace/ai-access",
    tags: ["identity"],
    body: AiAccessBody,
    response: AiAccessSchema,
    errors: {
      401: "Unauthorized",
      403: "workspace_admin_required — neither the workspace owner nor a holder of identity:write",
      404: "Not found",
      409: "self_hosted_workspace — only a self-service workspace sets its AI access here, a self-hosted one uses the engine settings; operator_change_pending — the engine operator has saved engine-wide settings that are not active yet; revision_conflict — other settings were saved at the same moment, try again",
      422: `llm_key_required — a different provider needs its own key; ${LLM_ACCESS_REFUSAL_CODES}. Nothing is saved and the stored key stays active.`,
      502: "llm_provider_unreachable — the provider did not answer; nothing is saved",
    },
    toInput: ({ json }) => json as AiAccessInput,
    toBody: (result) => result,
  },
});
