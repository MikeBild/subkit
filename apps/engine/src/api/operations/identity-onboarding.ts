import { z } from "@hono/zod-openapi";
import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import {
  admitRegistrationProbe,
  findOwnedWorkspaceId,
  finishPendingRegistration,
  PendingRegistrationError,
  readPendingRegistration,
  verifyPendingRegistration,
} from "../../identity/registration.ts";
import { completeHostedRegistration } from "../../identity/self-service.ts";
import { SelfServiceIdentityError } from "../../identity/tenant-status.ts";
import { workspaceAiAccess } from "../../llm/runtime/workspace-access.ts";
import { logger } from "../../logging/index.ts";
import { RuntimeConfigPendingError } from "../../runtime-config/contracts.ts";
import { waitOutWorkspaceChange } from "../../runtime-config/pending-engine-change.ts";
import { isIanaTimeZone } from "../../workflows/types.ts";
import {
  checkLlmAccess,
  storeCheckedLlmAccess,
  WorkspaceLlmKeySchema,
  WorkspaceLlmModelSchema,
  WorkspaceLlmProviderSchema,
} from "./workspace-ai-access.ts";

export const PendingRegistrationSchema = z
  .object({
    email: z.string(),
    suggested_display_name: z.string().nullable(),
    suggested_workspace_name: z.string().nullable(),
    csrf_token: z
      .string()
      .describe("Send back as X-Subkit-Onboarding-CSRF when completing the registration"),
    expires_at: z.string().datetime(),
  })
  .openapi("PendingRegistration");

export const CompleteRegistrationBody = z
  .object({
    display_name: z.string().trim().min(1).max(120),
    workspace_name: z.string().trim().min(1).max(120),
    timezone: z.string().min(1).max(64).describe("IANA time zone, e.g. Europe/Berlin"),
    llm_provider: WorkspaceLlmProviderSchema,
    llm_api_key: WorkspaceLlmKeySchema.describe(
      "Provider key of the new workspace. It is checked with one live call, stored encrypted and never returned.",
    ),
    llm_model: WorkspaceLlmModelSchema.optional().describe(
      "Model identifier; missing uses the provider's default",
    ),
  })
  .strict()
  .openapi("CompleteRegistrationBody");

export interface OnboardingRefusal {
  readonly ok: false;
  readonly status: 401 | 403 | 422 | 429 | 502 | 503;
  readonly code: string;
  readonly message: string;
}

const PENDING_REQUIRED: OnboardingRefusal = {
  ok: false,
  status: 401,
  code: "registration_pending_required",
  message: "Sign in first to set up your workspace.",
};

const WORKSPACE_UNAVAILABLE = "Your workspace is not available. Sign in again.";

const REGISTRATION_REFUSALS: Record<
  SelfServiceIdentityError["code"],
  { status: 403 | 429 | 503; message: string }
> = {
  registration_closed: {
    status: 403,
    message:
      "This SubKit is currently available by invitation only. You need an invitation link from a workspace administrator.",
  },
  registration_rate_limited: {
    status: 429,
    message: "Too many workspaces are being created right now. Try again shortly.",
  },
  registration_policy_unavailable: {
    status: 503,
    message: "New workspaces are temporarily unavailable. Try again later.",
  },
  identity_migration_required: {
    status: 403,
    message: "This account needs to be moved by an administrator before it can own a workspace.",
  },
  membership_unavailable: { status: 403, message: WORKSPACE_UNAVAILABLE },
  tenant_unavailable: { status: 403, message: WORKSPACE_UNAVAILABLE },
};

export function workspaceUnavailableRefusal(): OnboardingRefusal {
  return { ok: false, status: 403, code: "tenant_unavailable", message: WORKSPACE_UNAVAILABLE };
}

export async function readOnboarding(request: Request, db: Db) {
  try {
    const pending = await readPendingRegistration(request, db);
    return {
      ok: true as const,
      body: {
        email: pending.email,
        suggested_display_name: pending.suggested_display_name,
        suggested_workspace_name: null,
        csrf_token: pending.csrf_token,
        expires_at: pending.expires_at.toISOString(),
      },
    };
  } catch (error) {
    if (error instanceof PendingRegistrationError) return PENDING_REQUIRED;
    throw error;
  }
}

const SETUP_UNAVAILABLE: OnboardingRefusal = {
  ok: false,
  status: 503,
  code: "registration_policy_unavailable",
  message: "New workspaces are temporarily unavailable. Try again later.",
};

export type SeedWorkspace = (tenant_id: string, db: Db) => Promise<void>;

export async function completeOnboarding(
  request: Request,
  body: z.infer<typeof CompleteRegistrationBody>,
  db: Db,
  seedWorkspace: SeedWorkspace,
) {
  if (!isIanaTimeZone(body.timezone)) {
    return {
      ok: false,
      status: 422,
      code: "invalid_timezone",
      message: "The time zone is not a known IANA time zone, for example Europe/Berlin.",
    } satisfies OnboardingRefusal;
  }
  try {
    const proof = await verifyPendingRegistration(request, db);
    const ownedId = await findOwnedWorkspaceId(proof.identity_id, db);
    const keyed =
      ownedId !== null && workspaceAiAccess({ id: ownedId, origin: "self_service" }).own_key;
    if (proof.consumed && !ownedId) return PENDING_REQUIRED;
    const settled = keyed || proof.consumed;
    const registrationEnabled = getConfig().auth.hosted.registration_enabled;
    if (!ownedId && !registrationEnabled) throw new SelfServiceIdentityError("registration_closed");
    if (!settled) {
      await waitOutWorkspaceChange(db);
      if (!(await admitRegistrationProbe(proof, db))) {
        return {
          ok: false,
          status: 429,
          code: "llm_probe_rate_limited",
          message: "Too many attempts. Sign in again and try once more.",
        } satisfies OnboardingRefusal;
      }
      const checked = await checkLlmAccess({
        provider: body.llm_provider,
        api_key: body.llm_api_key,
        ...(body.llm_model ? { model: body.llm_model } : {}),
      });
      if (!checked.ok) return checked satisfies OnboardingRefusal;
    }
    const { llm_provider: _provider, llm_api_key: _key, llm_model: _model, ...registration } = body;
    const completed = await completeHostedRegistration(
      proof.identity_id,
      registration,
      { registration_enabled: registrationEnabled },
      db,
    );
    if (completed.created) await seedWorkspace(completed.tenant.id, db);
    if (!settled) {
      try {
        await storeCheckedLlmAccess(db, {
          tenant_id: completed.tenant.id,
          actor_type: "user",
          actor_id: completed.membership.user_id,
          change: {
            provider: body.llm_provider,
            model: body.llm_model ?? "",
            api_key: body.llm_api_key,
          },
          source: "hosted_registration",
        });
      } catch (error) {
        logger.error({
          module: "identity.onboarding",
          action: "onboarding.llm_access_not_stored",
          msg: "workspace exists but its model access was not stored; the same submit stores it again",
          tenant_id: completed.tenant.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          ok: false,
          status: 503,
          code: "llm_access_not_stored",
          message:
            "Your workspace exists, but the API key could not be saved yet. Submit the form again in a moment.",
        } satisfies OnboardingRefusal;
      }
    }
    const redirectTo = await finishPendingRegistration(proof, db);
    return {
      ok: true as const,
      tenant_id: completed.tenant.id,
      user_id: completed.membership.user_id,
      identity_id: completed.identity.id,
      redirect_to: redirectTo,
    };
  } catch (error) {
    if (error instanceof PendingRegistrationError) {
      if (error.code === "registration_pending_required") return PENDING_REQUIRED;
      return {
        ok: false,
        status: 403,
        code: error.code,
        message: "Reload the page and submit the form again.",
      } satisfies OnboardingRefusal;
    }
    if (error instanceof SelfServiceIdentityError) {
      const refused = REGISTRATION_REFUSALS[error.code];
      return { ok: false, code: error.code, ...refused } satisfies OnboardingRefusal;
    }
    if (error instanceof RuntimeConfigPendingError) return SETUP_UNAVAILABLE;
    throw error;
  }
}
