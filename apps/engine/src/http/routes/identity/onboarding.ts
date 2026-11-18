import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import {
  CompleteRegistrationBody,
  completeOnboarding,
  PendingRegistrationSchema,
  readOnboarding,
  workspaceUnavailableRefusal,
} from "../../../api/operations/identity-onboarding.ts";
import { LLM_ACCESS_REFUSAL_CODES } from "../../../api/operations/workspace-ai-access.ts";
import { issueBrowserSession } from "../../../auth/index.ts";
import { clearPendingRegistrationCookie } from "../../../identity/index.ts";
import type { AppEnv } from "../../openapi.ts";

const refusal = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const readRoute = createRoute({
  method: "get",
  path: "/v1/identity/onboarding",
  tags: ["identity"],
  summary: "Read the pending registration of a verified identity that has no workspace yet",
  description:
    "Requires the HttpOnly registration cookie set by the sign-in callback. It carries no workspace authority.",
  responses: {
    200: {
      description: "Verified identity awaiting its first workspace",
      content: { "application/json": { schema: PendingRegistrationSchema } },
    },
    401: refusal("registration_pending_required — no pending registration in this browser"),
  },
});

const completeRoute = createRoute({
  method: "post",
  path: "/v1/identity/onboarding",
  tags: ["identity"],
  summary: "Create the first workspace of a verified identity and sign it in",
  description:
    "Requires the registration cookie and X-Subkit-Onboarding-CSRF from GET /v1/identity/onboarding. The provider key is checked with one live call before anything is created; a refused key or an unreachable provider creates nothing. A repeated submit by the same identity lands in the workspace it already owns, creates nothing and leaves its stored key untouched.",
  request: {
    headers: z.object({
      "x-subkit-onboarding-csrf": z
        .string()
        .optional()
        .openapi({
          param: {
            required: true,
            description:
              "csrf_token from GET /v1/identity/onboarding; a missing or stale token is refused with 403.",
          },
        }),
    }),
    body: {
      content: { "application/json": { schema: CompleteRegistrationBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Workspace ready; the browser session cookie is set",
      content: { "application/json": { schema: z.object({ redirect_to: z.string() }) } },
    },
    401: refusal("registration_pending_required — no pending registration in this browser"),
    403: refusal(
      "registration_csrf_rejected, registration_closed, tenant_unavailable, membership_unavailable or identity_migration_required",
    ),
    422: refusal(
      `invalid_timezone — not an IANA time zone; ${LLM_ACCESS_REFUSAL_CODES}. Nothing is created.`,
    ),
    429: refusal(
      "registration_rate_limited, or llm_probe_rate_limited — too many key checks for this sign-in; sign in again",
    ),
    502: refusal("llm_provider_unreachable — the provider did not answer; nothing is created"),
    503: refusal(
      "registration_policy_unavailable, or llm_access_not_stored — the workspace exists but its key was not saved; the same submit stores it",
    ),
  },
});

export function registerOnboardingRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(readRoute, async (c) => {
    c.header("cache-control", "no-store");
    const pending = await readOnboarding(c.req.raw, c.get("db"));
    if (!pending.ok) return c.json({ code: pending.code, message: pending.message }, 401);
    return c.json(pending.body, 200);
  });

  app.openapi(completeRoute, async (c) => {
    c.header("cache-control", "no-store");
    const db = c.get("db");
    const completed = await completeOnboarding(c.req.raw, c.req.valid("json"), db);
    if (!completed.ok)
      return c.json({ code: completed.code, message: completed.message }, completed.status);
    const session = await issueBrowserSession({
      db,
      tenantId: completed.tenant_id,
      userId: completed.user_id,
      authIdentityId: completed.identity_id,
      redirectTo: completed.redirect_to,
      via: "hosted_registration",
    });
    if (session.status !== 302) {
      const refused = workspaceUnavailableRefusal();
      return c.json({ code: refused.code, message: refused.message }, refused.status);
    }
    for (const cookie of session.headers.getSetCookie())
      c.header("set-cookie", cookie, { append: true });
    c.header("set-cookie", clearPendingRegistrationCookie(), { append: true });
    return c.json({ redirect_to: completed.redirect_to }, 200);
  });
}
