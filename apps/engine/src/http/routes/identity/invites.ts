import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import { InviteRedeemedSchema } from "../../../api/operations/identity-representation.ts";
import {
  createInviteOperation,
  listInvitesOperation,
  revokeInviteOperation,
} from "../../../api/operations/identity-users.ts";
import { browserSessionForPrincipal, createOidcProvider } from "../../../auth/index.ts";
import { getConfig } from "../../../config/loader.ts";
import * as identity from "../../../identity/index.ts";
import { now } from "../../../utils/clock.ts";
import { ForbiddenError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { hostedIdentityProviders } from "./memberships.ts";

const REDEEM_MAX_ATTEMPTS = 5;
const PREVIEW_MAX_ATTEMPTS = 30;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_IPS = 10_000;

type AttemptLog = Map<string, { count: number; window_started_at: number }>;

const redeemAttempts: AttemptLog = new Map();
const previewAttempts: AttemptLog = new Map();

export function _resetInviteRedeemRateLimitForTests(): void {
  redeemAttempts.clear();
  previewAttempts.clear();
}

function evictAttempts(attempts: AttemptLog, at: number): void {
  for (const [ip, entry] of attempts) {
    if (at - entry.window_started_at > ATTEMPT_WINDOW_MS) attempts.delete(ip);
  }
  while (attempts.size >= MAX_TRACKED_IPS) {
    const oldest = attempts.keys().next().value;
    if (oldest === undefined) break;
    attempts.delete(oldest);
  }
}

function admitAttempt(attempts: AttemptLog, max: number, ip: string): boolean {
  const at = now();
  const entry = attempts.get(ip);
  if (!entry || at - entry.window_started_at > ATTEMPT_WINDOW_MS) {
    if (!attempts.has(ip)) evictAttempts(attempts, at);
    attempts.set(ip, { count: 1, window_started_at: at });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count += 1;
  return true;
}

const RedeemInviteBody = z
  .object({
    token: z.string().min(14).max(128),
  })
  .openapi("RedeemInviteBody");

const InviteLoginBody = z
  .object({ token: z.string().min(14).max(128), provider_id: z.string().min(1) })
  .strict()
  .openapi("InviteLoginBody");

const InvitePreviewSchema = z
  .object({
    workspace_name: z.string(),
    invited_by_name: z.string().nullable(),
    email_hint: z.string().describe("Masked invited address, e.g. m•••@example.com"),
    expires_at: z.string().datetime(),
    providers: z.array(z.object({ id: z.string(), label: z.string() })),
  })
  .openapi("InvitePreview");

const invitePreviewRoute = createRoute({
  method: "post",
  path: "/v1/identity/invites/preview",
  tags: ["identity"],
  summary: "Show what an invitation link leads to before anyone signs in",
  description:
    "Unauthenticated. The invite token in the body is the proof; nothing is redeemed. The invited address is returned masked.",
  request: { body: { content: { "application/json": { schema: RedeemInviteBody } } } },
  responses: {
    200: {
      description: "Invitation details for the token holder",
      content: { "application/json": { schema: InvitePreviewSchema } },
    },
    400: {
      description:
        "invite_invalid, invite_expired, invite_revoked, invite_already_redeemed, invite_unavailable or invite_credential_only",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded for this client IP",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const INVITE_PREVIEW_MESSAGES: Record<string, string> = {
  invite_invalid: "This invitation link is not valid. Ask for a new one.",
  invite_expired: "This invitation link has expired. Ask for a new one.",
  invite_revoked: "This invitation link was withdrawn. Ask for a new one.",
  invite_already_redeemed: "This invitation link was already used. Sign in instead.",
  invite_unavailable: "This invitation is no longer available. Ask for a new one.",
  invite_credential_only: "This invitation is meant for the sk command line, not for the browser.",
};

const InviteLoginStarted = z.object({ authorization_url: z.url() }).openapi("InviteLoginStarted");

const inviteLoginRoute = createRoute({
  method: "post",
  path: "/v1/identity/invites/login",
  tags: ["identity"],
  summary: "Start a verified hosted identity login for a membership invitation",
  description:
    "The invite secret stays in the request body. OIDC state stores only its validated invitation id; no session is issued until the verified identity matches the invited address. The caller navigates to authorization_url itself, so the page's form-action policy never has to name the identity provider.",
  request: { body: { content: { "application/json": { schema: InviteLoginBody } } } },
  responses: {
    200: {
      description: "Where to send the browser to sign in",
      content: { "application/json": { schema: InviteLoginStarted } },
    },
    403: {
      description: "Invitation or hosted provider unavailable, or a cross-site caller",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const claimInviteRoute = createRoute({
  method: "post",
  path: "/v1/identity/invites/claim",
  tags: ["identity"],
  summary: "Accept an unrestricted membership invitation with a verified browser identity",
  request: { body: { content: { "application/json": { schema: RedeemInviteBody } } } },
  security: [{ browserSession: [] }],
  responses: {
    200: {
      description: "Membership accepted; no credentials or session issued",
      content: {
        "application/json": {
          schema: z.object({
            tenant_id: z.string().uuid(),
            user_id: z.string().uuid(),
            claimed: z.boolean(),
          }),
        },
      },
    },
    403: {
      description: "Verified identity, invite audience or membership scope rejected",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const redeemInviteRoute = createRoute({
  method: "post",
  path: "/v1/identity/invites/redeem",
  tags: ["identity"],
  summary: "Redeem an invite to mint the invited user's personal API key",
  description:
    "Unauthenticated. The invite token in the body is the proof. On success returns the invited user's personal API key plaintext exactly once — the issuing admin never sees it.",
  request: { body: { content: { "application/json": { schema: RedeemInviteBody } } } },
  responses: {
    200: {
      description: "Redeemed; personal API key returned",
      content: { "application/json": { schema: InviteRedeemedSchema } },
    },
    400: {
      description: "Invalid, expired, revoked, or already-redeemed invite",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description: "Rate limit exceeded for this client IP",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerInviteRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, createInviteOperation);
  toHonoRoute(app, listInvitesOperation);
  toHonoRoute(app, revokeInviteOperation);

  app.openapi(invitePreviewRoute, async (c) => {
    c.header("cache-control", "no-store");
    if (!admitAttempt(previewAttempts, PREVIEW_MAX_ATTEMPTS, c.get("client_ip") ?? "unknown")) {
      return c.json(
        { code: "rate_limit_exceeded", message: "Too many attempts. Try again in a few minutes." },
        429,
      );
    }
    const preview = await identity.previewMembershipInvite(c.req.valid("json").token, c.get("db"));
    if (!preview.ok) {
      return c.json(
        { code: preview.code, message: INVITE_PREVIEW_MESSAGES[preview.code] ?? preview.code },
        400,
      );
    }
    return c.json(
      {
        workspace_name: preview.workspace_name,
        invited_by_name: preview.invited_by_name,
        email_hint: preview.email_hint,
        expires_at: preview.expires_at.toISOString(),
        providers: hostedIdentityProviders().map(({ id, label }) => ({ id, label })),
      },
      200,
    );
  });

  app.openapi(inviteLoginRoute, async (c) => {
    if (c.req.header("sec-fetch-site") === "cross-site")
      throw new ForbiddenError("invite_login_origin_rejected");
    const origin = c.req.header("origin");
    if (
      origin &&
      origin !== new URL(c.req.url).origin &&
      origin !== new URL(getConfig().server.public_base_url).origin
    )
      throw new ForbiddenError("invite_login_origin_rejected");
    const input = c.req.valid("json");
    const provider = hostedIdentityProviders().find((entry) => entry.id === input.provider_id);
    if (!provider) throw new ForbiddenError("hosted_provider_required");
    let response: Response | undefined;
    try {
      const target = await identity.membershipInviteLoginTarget(input.token, c.get("db"));
      const adapter = createOidcProvider({
        db: c.get("db"),
        providerId: provider.id,
        membershipInviteId: target.invite_id,
      });
      const start = new URL("/v1/identity/login/start", c.req.url);
      start.searchParams.set("redirect_to", `${identity.INVITE_PAGE_PATH}?joined=1`);
      response = await adapter.startLogin?.(new Request(start));
    } catch (error) {
      if (
        error instanceof identity.MembershipInviteError ||
        error instanceof identity.SelfServiceIdentityError
      )
        throw new ForbiddenError(error.code);
      throw error;
    }
    const authorizationUrl = response?.status === 302 ? response.headers.get("location") : null;
    if (!response || !authorizationUrl) throw new ForbiddenError("hosted_provider_unavailable");
    for (const cookie of response.headers.getSetCookie())
      c.header("set-cookie", cookie, { append: true });
    c.header("cache-control", "no-store");
    return c.json({ authorization_url: authorizationUrl }, 200);
  });

  app.openapi(claimInviteRoute, async (c) => {
    const principal = requireAuth(c);
    const payload = await browserSessionForPrincipal(c.req.raw, principal);
    if (!payload || principal.product_id)
      throw new ForbiddenError("verified_browser_identity_required");
    try {
      const result = await identity.claimMembershipInvite(
        { ...payload, token: c.req.valid("json").token },
        c.get("db"),
      );
      return c.json(
        {
          tenant_id: result.membership.tenant_id,
          user_id: result.membership.user_id,
          claimed: result.claimed,
        },
        200,
      );
    } catch (error) {
      if (
        error instanceof identity.MembershipInviteError ||
        error instanceof identity.SelfServiceIdentityError
      )
        throw new ForbiddenError(error.code);
      throw error;
    }
  });

  app.openapi(redeemInviteRoute, async (c) => {
    const db = c.get("db");
    const ip = c.get("client_ip") ?? "unknown";
    if (!admitAttempt(redeemAttempts, REDEEM_MAX_ATTEMPTS, ip)) {
      return c.json(
        { code: "rate_limit_exceeded", message: "too many redeem attempts from this IP" },
        429,
      );
    }
    const body = c.req.valid("json");
    const outcome = await identity.redeemInvite({ token: body.token }, db);
    if (!outcome.ok) {
      return c.json(
        { code: outcome.code, message: `invite redemption failed: ${outcome.code}` },
        400,
      );
    }
    return c.json(
      {
        user_id: outcome.user_id,
        tenant_id: outcome.tenant_id,
        api_key: outcome.api_key.plaintext,
        api_key_prefix: outcome.api_key.view.prefix,
      },
      200,
    );
  });
}
