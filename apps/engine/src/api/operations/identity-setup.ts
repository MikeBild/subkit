import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import { policy } from "../../auth/policy.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { roles, users } from "../../db/schema/index.ts";
import {
  ApprovalPolicyError,
  changeApprovalPolicy,
  eligiblePairApprovers,
  readApprovalPolicy,
} from "../../identity/approval-policy.ts";
import { createInvitedUser, DuplicateUserError } from "../../identity/provisioning.ts";
import {
  APPROVER_PERMISSIONS,
  findTeammateByEmail,
  isTimeZone,
  RECOMMENDED_SETUP,
  readSetupPreferences,
  type SetupApprover,
  type SetupPatch,
  type SetupPreferences,
  writeSetupPreferences,
} from "../../identity/setup-preferences.ts";
import { principalHolds } from "../../rbac/evaluator.ts";
import { defineOperation, type OperationScope, type Rejection, reject } from "./index.ts";

const TAGS = ["identity"] as const;

const ClockTime = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)
  .describe("Local time of day in the person's time zone, HH:MM.");

const TimeZone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isTimeZone, "an IANA time zone such as Europe/Berlin")
  .describe("IANA time zone the notification times are read in.");

const NotificationScheduleSchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("immediately") }).strict(),
    z
      .object({
        mode: z.literal("working_hours"),
        from: ClockTime,
        to: ClockTime,
        days: z
          .array(z.number().int().min(1).max(7))
          .min(1)
          .max(7)
          .refine((days) => new Set(days).size === days.length, "each weekday once")
          .optional()
          .describe(
            "Working days as ISO weekdays, 1 = Monday to 7 = Sunday. Monday to Friday when omitted. A window that crosses midnight belongs to the day it starts on.",
          ),
      })
      .strict(),
    z.object({ mode: z.literal("daily_digest"), at: ClockTime }).strict(),
  ])
  .openapi("SetupNotificationSchedule");

const ApproverInputSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("self") }).strict(),
    z
      .object({ kind: z.literal("teammate"), email: z.string().trim().email().min(3).max(254) })
      .strict(),
    z
      .object({ kind: z.literal("pair"), email: z.string().trim().email().min(3).max(254) })
      .strict()
      .describe(
        "Two of us: one builds, one approves. Names the partner and asks for two-person workflow approval in the workspace.",
      ),
  ])
  .openapi("SetupApproverInput");

const PartnerFields = {
  email: z.string(),
  user_id: z.string().uuid().nullable().describe("The teammate's person, once one exists."),
  invitation: z
    .enum(["member", "pending", "needs_admin"])
    .describe(
      "member: the teammate is in the workspace. pending: an invitation is prepared and not yet accepted. needs_admin: an administrator has to invite this address first.",
    ),
  invite_id: z.string().uuid().nullable(),
  can_approve: z
    .boolean()
    .nullable()
    .describe(
      "Whether the teammate's role may grant what is asked of an approver: conversation:approve, task:grant and workflow:write. false means approval notifications stay with the asking person until an administrator changes the role. null while the teammate is not a person in the workspace yet.",
    ),
  missing_permissions: z
    .array(z.string())
    .describe("The approver permissions the teammate's role lacks; empty when can_approve."),
};

const ApproverSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("self") }),
    z.object({ kind: z.literal("teammate"), ...PartnerFields }),
    z.object({
      kind: z.literal("pair"),
      ...PartnerFields,
      pair: z
        .enum(["active", "needs_second_approver", "needs_admin"])
        .describe(
          "active: the workspace requires two people for every workflow approval. needs_second_approver: fewer than two people may approve; it starts once the partner has joined with a role that may approve. needs_admin: only an administrator switches the workspace to two-person approval.",
        ),
    }),
  ])
  .openapi("SetupApprover");

const ServiceSlug = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);

const SetupBody = z
  .object({
    default_chat_mode: z.enum(["ask", "auto", "plan"]).optional(),
    default_environment: z.enum(["dev", "prod"]).optional(),
    approver: ApproverInputSchema.optional(),
    notifications: NotificationScheduleSchema.optional(),
    timezone: TimeZone.nullable()
      .optional()
      .describe("The person's time zone; null falls back to the workspace time zone."),
    critical_breakthrough: z
      .boolean()
      .optional()
      .describe(
        "Opt in: a stopped production workflow and a stored secret that can no longer be read notify at once, also outside working hours and before the daily summary.",
      ),
    first_job: z.string().trim().min(1).max(120).nullable().optional(),
    services: z.array(ServiceSlug).max(50).optional(),
  })
  .strict()
  .openapi("UpdateSetupBody");

const SetupSchema = z
  .object({
    default_chat_mode: z
      .enum(["ask", "auto", "plan"])
      .describe("The mode a new conversation starts in when the client sends none."),
    default_environment: z
      .enum(["dev", "prod"])
      .describe("The environment new workflows, tasks and approval dialogs start with."),
    approver: ApproverSchema,
    notifications: NotificationScheduleSchema.describe(
      "When notifications reach the person. working_hours holds them outside the window and on other weekdays and delivers one summary at the next start; daily_digest delivers one summary at the chosen time. Times are read in the personal time zone and follow its clock changes. The schedule applies to push notifications and to the announcement hint on the Cockpit event stream; the attention list, the shared CLI inbox, chat channels and outbound webhooks are never delayed.",
    ),
    timezone: z
      .string()
      .nullable()
      .describe("The person's own time zone; null means the workspace time zone applies."),
    critical_breakthrough: z
      .boolean()
      .describe("Whether critical items notify at once despite the schedule. Off unless chosen."),
    first_job: z.string().nullable(),
    services: z.array(z.string()),
    unset: z
      .array(z.enum(["default_chat_mode", "default_environment", "approver", "notifications"]))
      .describe("Choices the person has not made yet; their values are the recommended ones."),
    recommended: z.object({
      default_chat_mode: z.enum(["ask", "auto", "plan"]),
      default_environment: z.enum(["dev", "prod"]),
      approver: z.object({ kind: z.literal("self") }),
      notifications: NotificationScheduleSchema,
      critical_breakthrough: z.boolean(),
    }),
    invitation: z
      .object({
        invite_id: z.string().uuid(),
        plaintext_token: z.string(),
        expires_at: z.string(),
      })
      .optional()
      .describe(
        "Present once, right after this request prepared an invitation for the teammate. No mail was sent.",
      ),
    updated_at: z.string().nullable(),
  })
  .openapi("Setup");

type SetupInput = z.infer<typeof SetupBody>;

type PairReadiness = "active" | "needs_second_approver" | "needs_admin";

interface SetupResult {
  readonly setup: SetupPreferences;
  readonly teammate_status: string | null;
  readonly missing_permissions: readonly string[] | null;
  readonly pair?: PairReadiness;
  readonly invitation?: { invite_id: string; plaintext_token: string; expires_at: Date };
}

function person(scope: OperationScope): ResolvedPrincipal | Rejection {
  const principal = scope.principal;
  if (!principal) return reject.unauthorized();
  if (principal.kind !== "user")
    return reject.status(403, "person_required", "Setup choices belong to a person.");
  return principal;
}

function isRejected(value: ResolvedPrincipal | Rejection): value is Rejection {
  return (value as Rejection).rejected === true;
}

export async function missingApproverPermissions(
  scope: Pick<OperationScope, "db" | "tenant_id">,
  user_id: string,
): Promise<string[]> {
  const [person] = await scope.db
    .select({ role_name: roles.name })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(and(eq(users.tenant_id, scope.tenant_id), eq(users.id, user_id)))
    .limit(1);
  if (!person) return [...APPROVER_PERMISSIONS];
  const principal: ResolvedPrincipal = {
    provider: "setup_approver",
    kind: "user",
    id: user_id,
    tenant_id: scope.tenant_id,
    roles: person.role_name ? [person.role_name] : [],
  };
  const missing: string[] = [];
  for (const permission of APPROVER_PERMISSIONS) {
    if (!(await principalHolds(scope.db, principal, permission))) missing.push(permission);
  }
  return missing;
}

async function teammateFacts(
  scope: OperationScope,
  setup: SetupPreferences,
): Promise<Pick<SetupResult, "teammate_status" | "missing_permissions">> {
  if (setup.approver.kind === "self") return { teammate_status: null, missing_permissions: null };
  const teammate = await findTeammateByEmail(scope.db, scope.tenant_id, setup.approver.email);
  return {
    teammate_status: teammate?.status ?? null,
    missing_permissions: teammate ? await missingApproverPermissions(scope, teammate.id) : null,
  };
}

async function pairReadiness(
  scope: OperationScope,
  principal: ResolvedPrincipal,
  setup: SetupPreferences,
  activate: boolean,
): Promise<Pick<SetupResult, "pair">> {
  if (setup.approver.kind !== "pair") return {};
  const policy = await readApprovalPolicy(scope.db, scope.tenant_id);
  if (policy.workflow_approvals === "pair") return { pair: "active" };
  const admin = await principalHolds(scope.db, principal, "rbac:write");
  if (!admin) return { pair: "needs_admin" };
  if (activate) {
    try {
      await changeApprovalPolicy(scope.db, {
        tenant_id: scope.tenant_id,
        next: "pair",
        actor: { type: "user", id: principal.id },
        source: "setup",
      });
      return { pair: "active" };
    } catch (error) {
      if (error instanceof ApprovalPolicyError) return { pair: "needs_second_approver" };
      throw error;
    }
  }
  const eligible = await eligiblePairApprovers(scope.db, scope.tenant_id);
  return { pair: eligible.length < 2 ? "needs_second_approver" : "needs_admin" };
}

function body({ setup, teammate_status, missing_permissions, invitation, pair }: SetupResult) {
  const approver =
    setup.approver.kind === "self"
      ? { kind: "self" as const }
      : {
          kind: setup.approver.kind,
          ...(setup.approver.kind === "pair" ? { pair: pair ?? ("needs_admin" as const) } : {}),
          email: setup.approver.email,
          user_id: setup.approver.user_id,
          invite_id: setup.approver.invite_id,
          invitation:
            teammate_status === null
              ? ("needs_admin" as const)
              : teammate_status === "invited"
                ? ("pending" as const)
                : ("member" as const),
          can_approve: missing_permissions === null ? null : missing_permissions.length === 0,
          missing_permissions: missing_permissions ?? [],
        };
  return {
    default_chat_mode: setup.default_chat_mode,
    default_environment: setup.default_environment,
    approver,
    notifications: setup.notifications,
    timezone: setup.timezone,
    critical_breakthrough: setup.critical_breakthrough,
    first_job: setup.first_job,
    services: setup.services,
    unset: setup.unset,
    recommended: RECOMMENDED_SETUP,
    ...(invitation
      ? {
          invitation: {
            invite_id: invitation.invite_id,
            plaintext_token: invitation.plaintext_token,
            expires_at: invitation.expires_at.toISOString(),
          },
        }
      : {}),
    updated_at: setup.updated_at ? setup.updated_at.toISOString() : null,
  };
}

export const getSetupOperation = defineOperation<null, SetupResult>({
  id: "identity.me.setup.get",
  summary: "Read the signed-in person's setup choices, with recommended values where unset",
  permission: null,
  effect: "read",
  async handler(scope) {
    const principal = person(scope);
    if (isRejected(principal)) return principal;
    const setup = await readSetupPreferences(scope.db, {
      tenant_id: scope.tenant_id,
      user_id: principal.id,
    });
    return {
      setup,
      ...(await teammateFacts(scope, setup)),
      ...(await pairReadiness(scope, principal, setup, false)),
    };
  },
  http: {
    method: "get",
    path: "/v1/identity/me/setup",
    tags: TAGS,
    response: SetupSchema,
    errors: { 401: "Unauthorized", 403: "person_required — only a person has setup choices" },
    toInput: () => null,
    toBody: body,
  },
});

type PreparedApprover =
  | { approver: SetupApprover; invitation?: SetupResult["invitation"] }
  | Rejection;

async function prepareApprover(
  scope: OperationScope,
  principal: ResolvedPrincipal,
  input: NonNullable<SetupInput["approver"]>,
): Promise<PreparedApprover> {
  if (input.kind === "self") return { approver: { kind: "self" } };
  const kind = input.kind;
  const email = input.email.trim();
  const existing = await findTeammateByEmail(scope.db, scope.tenant_id, email);
  if (existing?.id === principal.id) {
    if (kind === "pair")
      return reject.unprocessable(
        "The second person in a pair has to be someone else.",
        undefined,
        "pair_same_person",
      );
    return { approver: { kind: "self" } };
  }
  if (existing) {
    return {
      approver: { kind, email: existing.email, user_id: existing.id, invite_id: null },
    };
  }
  const mayInvite =
    policy.adminOnly(principal).allowed &&
    (await principalHolds(scope.db, principal, "identity:write"));
  if (!mayInvite) {
    return { approver: { kind, email, user_id: null, invite_id: null } };
  }
  try {
    const created = await createInvitedUser(
      {
        tenant_id: scope.tenant_id,
        email,
        role: "member",
        actor_kind: principal.kind,
        actor_id: principal.id,
        issuer: { kind: "principal", principal },
      },
      scope.db,
    );
    return {
      approver: {
        kind,
        email: created.user.email,
        user_id: created.user.id,
        invite_id: created.invite.view.id,
      },
      invitation: {
        invite_id: created.invite.view.id,
        plaintext_token: created.invite.plaintext,
        expires_at: created.invite.view.expires_at,
      },
    };
  } catch (error) {
    if (error instanceof DuplicateUserError) {
      return reject.conflict(
        "This address already belongs to a person in the workspace.",
        undefined,
        "approver_already_known",
      );
    }
    throw error;
  }
}

export const putSetupOperation = defineOperation<SetupInput, SetupResult>({
  id: "identity.me.setup.put",
  summary:
    "Store the signed-in person's setup choices; fields left out keep their value. Naming a teammate who is not in the workspace prepares an invitation and sends no mail. Choosing pair as an administrator switches the workspace to two-person workflow approval once two people may approve.",
  permission: null,
  effect: "write",
  audit: AuditAction.USER_SETUP_UPDATED,
  async handler(scope, input) {
    const principal = person(scope);
    if (isRejected(principal)) return principal;
    const prepared = input.approver
      ? await prepareApprover(scope, principal, input.approver)
      : null;
    if (prepared && "rejected" in prepared) return prepared;
    const patch: SetupPatch = {
      ...(input.default_chat_mode !== undefined
        ? { default_chat_mode: input.default_chat_mode }
        : {}),
      ...(input.default_environment !== undefined
        ? { default_environment: input.default_environment }
        : {}),
      ...(prepared ? { approver: prepared.approver } : {}),
      ...(input.notifications !== undefined ? { notifications: input.notifications } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.critical_breakthrough !== undefined
        ? { critical_breakthrough: input.critical_breakthrough }
        : {}),
      ...(input.first_job !== undefined ? { first_job: input.first_job } : {}),
      ...(input.services !== undefined ? { services: input.services } : {}),
    };
    const setup = await writeSetupPreferences(
      scope.db,
      { tenant_id: scope.tenant_id, user_id: principal.id },
      patch,
    );
    if (!setup) return reject.notFound("user");
    return {
      setup,
      ...(await teammateFacts(scope, setup)),
      ...(await pairReadiness(scope, principal, setup, input.approver?.kind === "pair")),
      ...(prepared?.invitation ? { invitation: prepared.invitation } : {}),
    };
  },
  http: {
    method: "put",
    path: "/v1/identity/me/setup",
    tags: TAGS,
    body: SetupBody,
    response: SetupSchema,
    errors: {
      401: "Unauthorized",
      403: "person_required — only a person has setup choices",
      404: "Not found",
      409: "approver_already_known — the address belongs to a person who cannot be invited again",
      422: "pair_same_person — the second person in a pair has to be someone else",
    },
    toInput: ({ json }) => json as SetupInput,
    toBody: body,
  },
});
