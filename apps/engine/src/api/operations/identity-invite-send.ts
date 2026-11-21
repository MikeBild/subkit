import { z } from "@hono/zod-openapi";
import { and, desc, eq, isNull } from "drizzle-orm";
import { actorOf, auditActor } from "../../audit/actor.ts";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { createDesktopLoginRateLimiter } from "../../auth/index.ts";
import { policy } from "../../auth/policy.ts";
import { getConfig } from "../../config/loader.ts";
import {
  buildOAuthRedirectUri,
  OAUTH_CALLBACK_PATH,
} from "../../credentials/oauth2/redirect-uri.ts";
import { tenants, userInvites, users } from "../../db/schema/index.ts";
import { createSharedRateLimiter, type SharedRateLimiter } from "../../db/shared-rate-limit.ts";
import { enforce } from "../../http/middleware/policy.ts";
import {
  deliverInvite,
  type InviteDeliveryOutcome,
  inviteLinkPath,
  inviteMailTransport,
  inviteUrl,
} from "../../identity/invite-delivery.ts";
import { maskInviteEmail } from "../../identity/membership-invite.ts";
import { createInvite, type InviteView } from "../../identity/provisioning.ts";
import { IdParam } from "../common-schemas.ts";
import { serializeInvite, UserInviteSchema } from "./identity-representation.ts";
import { defineOperation, reject } from "./index.ts";

export const INVITE_SEND_LIMITS = {
  issuer: { max: 5, windowMs: 10 * 60_000 },
  invitee: { max: 2, windowMs: 10 * 60_000 },
} as const;

function limiterFor(name: "issuer" | "invitee"): SharedRateLimiter {
  const limits = INVITE_SEND_LIMITS[name];
  return createSharedRateLimiter({
    scope: "invite_send",
    name,
    limits,
    local: createDesktopLoginRateLimiter(limits),
  });
}

let limiters = { issuer: limiterFor("issuer"), invitee: limiterFor("invitee") };

export function resetInviteSendLimiters(
  next: { issuer: SharedRateLimiter; invitee: SharedRateLimiter } = {
    issuer: limiterFor("issuer"),
    invitee: limiterFor("invitee"),
  },
): void {
  limiters = next;
}

const SendInviteBody = z
  .object({
    ttl_minutes: z
      .number()
      .int()
      .positive()
      .max(90 * 24 * 60)
      .optional()
      .describe("How long the new link stays valid. Seven days when omitted."),
  })
  .strict()
  .openapi("SendInviteBody");

export const InviteDeliverySchema = z
  .discriminatedUnion("delivery", [
    z.object({
      delivery: z.literal("sent"),
      channel: z.literal("email"),
      to: z.string().describe("The address the invitation went to, partly masked."),
      invite: UserInviteSchema,
    }),
    z.object({
      delivery: z.literal("copy_link"),
      reason: z
        .enum(["no_mail_transport", "mail_failed", "no_public_url"])
        .describe(
          "no_mail_transport: this engine has no way to send mail, so nothing was sent. mail_failed: sending was tried and failed. no_public_url: `server.public_base_url` is not configured, and a mailed link never takes its address from request headers.",
        ),
      invite: UserInviteSchema,
      plaintext_token: z.string().describe("Shown once. The link carries it."),
      link_path: z.string().describe("Path of the invitation page with the token as fragment."),
      url: z
        .string()
        .nullable()
        .describe("The full link to copy, when the engine knows its public address."),
    }),
  ])
  .openapi("InviteDelivery");

type SendInput = { readonly id: string; readonly body: z.infer<typeof SendInviteBody> };

type SendResult = {
  readonly outcome: InviteDeliveryOutcome;
  readonly view: InviteView;
  readonly plaintext: string;
  readonly email: string;
  readonly link_path: string;
  readonly url: string | null;
};

function configuredOrigin(): string | null {
  try {
    const configured = getConfig().server.public_base_url;
    return configured && configured.length > 0 ? configured : null;
  } catch {
    return null;
  }
}

function originOf(request: Request | undefined): string | null {
  const callback = buildOAuthRedirectUri(request ? { req: request } : undefined);
  return callback ? callback.slice(0, -OAUTH_CALLBACK_PATH.length) : null;
}

export const sendInviteOperation = defineOperation<SendInput, SendResult>({
  id: "identity.user.invite.send",
  summary: "Send an invited person a new invitation link, or hand back the link to copy",
  permission: "identity:write",
  effect: "write",
  audit: AuditAction.USER_INVITE_DELIVERY,
  async handler(scope, { id, body }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    enforce(
      principal,
      policy.adminOnly(principal),
      { resource_type: "user_invite", resource_id: id },
      scope.db,
    );
    const [person] = await scope.db
      .select({ id: users.id, email: users.email, status: users.status })
      .from(users)
      .where(and(eq(users.tenant_id, scope.tenant_id), eq(users.id, id), isNull(users.deleted_at)))
      .limit(1);
    if (!person) return reject.notFound("user");
    if (person.status !== "invited")
      return reject.conflict(
        "This person has already joined; there is nothing to send.",
        undefined,
        "not_invited",
      );
    for (const [name, key] of [
      ["issuer", `${scope.tenant_id}:${principal.id}`],
      ["invitee", `${scope.tenant_id}:${person.id}`],
    ] as const) {
      const limit = await limiters[name].take(scope.db, key);
      if (!limit.allowed)
        return reject.status(429, "rate_limit_exceeded", "too many invitations sent", {
          retry_after_seconds: limit.retry_after_seconds,
          limit: name,
        });
    }
    const [previous] = await scope.db
      .select()
      .from(userInvites)
      .where(
        and(
          eq(userInvites.tenant_id, scope.tenant_id),
          eq(userInvites.user_id, person.id),
          isNull(userInvites.redeemed_at),
          isNull(userInvites.revoked_at),
        ),
      )
      .orderBy(desc(userInvites.created_at))
      .limit(1);
    const issued = await createInvite(
      {
        issuer: { kind: "principal", principal },
        tenant_id: scope.tenant_id,
        user_id: person.id,
        ...(previous ? { scopes: previous.scopes } : {}),
        ...(previous?.allowed_workflows ? { allowed_workflows: previous.allowed_workflows } : {}),
        ...(previous?.allowed_connectors
          ? { allowed_connectors: previous.allowed_connectors }
          : {}),
        ...(body.ttl_minutes !== undefined ? { ttl_minutes: body.ttl_minutes } : {}),
        actor_kind: principal.kind,
        actor_id: principal.id,
      },
      scope.db,
    );
    const [workspace] = await scope.db
      .select({ name: tenants.display_name })
      .from(tenants)
      .where(eq(tenants.id, scope.tenant_id))
      .limit(1);
    const [inviter] = await scope.db
      .select({ name: users.display_name, email: users.email })
      .from(users)
      .where(and(eq(users.tenant_id, scope.tenant_id), eq(users.id, principal.id)))
      .limit(1);
    const url = inviteUrl(originOf(scope.request), issued.plaintext);
    const outcome = await deliverInvite(inviteMailTransport(), {
      to: person.email,
      workspace: workspace?.name ?? "",
      inviter: inviter?.name?.trim() || inviter?.email || "",
      url: inviteUrl(configuredOrigin(), issued.plaintext),
      expires_at: issued.view.expires_at,
    });
    await auditAwait(
      {
        tenant_id: scope.tenant_id,
        ...auditActor(actorOf(principal)),
        action: AuditAction.USER_INVITE_DELIVERY,
        resource_type: "user_invite",
        resource_id: issued.view.id,
        result:
          outcome.delivery === "copy_link" && outcome.reason === "mail_failed"
            ? "error"
            : "success",
        reason: outcome.delivery === "sent" ? null : outcome.reason,
        metadata: {
          invite_id: issued.view.id,
          user_id: person.id,
          delivery: outcome.delivery,
          replaced_invite_id: previous?.id ?? null,
        },
      },
      scope.db,
    );
    return {
      outcome,
      view: issued.view,
      plaintext: issued.plaintext,
      email: person.email,
      link_path: inviteLinkPath(issued.plaintext),
      url,
    };
  },
  http: {
    method: "post",
    path: "/v1/identity/users/{id}/invites/send",
    tags: ["identity"],
    description:
      "Issues a new invitation link for a person who has not joined yet and tries to deliver it. The previous link stops working. When the engine has no way to send mail the answer is `delivery: copy_link` with the link to hand over; nothing is reported as sent that was not sent.",
    params: IdParam,
    body: SendInviteBody,
    response: InviteDeliverySchema,
    success: { status: 201, description: "A new invitation exists; see `delivery`" },
    errors: {
      401: "Unauthorized",
      403: "Forbidden — administrators only",
      404: "User not found",
      409: "not_invited — the person has already joined",
      429: "rate_limit_exceeded — at most 5 sends per administrator and 2 per invited person in 10 minutes",
    },
    toInput: ({ param, json }) => ({
      id: (param as { id: string }).id,
      body: (json ?? {}) as z.infer<typeof SendInviteBody>,
    }),
    toBody: (result) =>
      result.outcome.delivery === "sent"
        ? {
            delivery: "sent" as const,
            channel: result.outcome.channel,
            to: maskInviteEmail(result.email),
            invite: serializeInvite(result.view),
          }
        : {
            delivery: "copy_link" as const,
            reason: result.outcome.reason,
            invite: serializeInvite(result.view),
            plaintext_token: result.plaintext,
            link_path: result.link_path,
            url: result.url,
          },
  },
});
