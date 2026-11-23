import { and, eq } from "drizzle-orm";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import { getConfig } from "../../../config/loader.ts";
import { completeApprovalBackedElicitation } from "../../../conversations/public/authoring.ts";
import {
  inTaskRunApprovalTrace,
  taskRunApprovalRefusal,
} from "../../../conversations/public/lifecycle.ts";
import type { Db } from "../../../db/client.ts";
import { chatIdentities, chatWorkspaces } from "../../../db/schema/index.ts";
import { slackDecisionCopy } from "../../../http/i18n/slack-decisions.ts";
import { errorFields, logger } from "../../../logging/index.ts";
import { enqueueApprovalElicitationResume, getBoss } from "../../../queue/index.ts";
import { principalHolds } from "../../../rbac/evaluator.ts";
import {
  type ApprovalDecisionDenialCode,
  declineApproval,
  grantApproval,
} from "../../../tools/approval.ts";
import { findActiveApproverEmail } from "../../../tools/approval-portal.ts";
import { now } from "../../../utils/clock.ts";
import { markChatEventSeen } from "../../dedup.ts";
import { requiresHostedChatOwnership } from "../../hosted-ownership.ts";
import { resolveChatPrincipal } from "../../principal.ts";
import type { ChatEvent } from "../../types.ts";
import { type DecisionAction, isOpenAction, parseDecisionAction } from "./action.ts";
import {
  absoluteLink,
  type DecisionOutcome,
  decidedBlocks,
  headerFromMessage,
  noticeBlocks,
  outcomeLine,
  type SlackBlock,
  safeCockpitPath,
} from "./blocks.ts";
import { signSlackLinkToken, slackLinkUrl } from "./link-token.ts";
import { grantedByName, personName, tenantLanguage } from "./subject.ts";

export interface SlackDecisionClient {
  update(p: { channel: string; ts: string; text: string; blocks: SlackBlock[] }): Promise<void>;
  ephemeral(p: {
    channel: string;
    user: string;
    text: string;
    blocks: SlackBlock[];
  }): Promise<void>;
}

type ResumeEnqueuer = Parameters<typeof completeApprovalBackedElicitation>[0]["resume"];

export interface SlackDecisionDeps {
  db: Db;
  client: SlackDecisionClient;
  resume?: ResumeEnqueuer;
  publicBaseUrl?: string;
  clock?: () => Date;
}

export const APPROVER_PERMISSIONS = ["conversation:approve", "workflow:write"] as const;

interface ClickContext {
  event: ChatEvent;
  action: DecisionAction;
  tenant_id: string;
  workspace_row_id: string;
  locale: "de" | "en";
  link: string | null;
  message_ts: string | null;
  header: SlackBlock | null;
}

function rawPayload(event: ChatEvent): Record<string, unknown> {
  return event.raw && typeof event.raw === "object" ? (event.raw as Record<string, unknown>) : {};
}

function actionStamp(raw: Record<string, unknown>): string | null {
  const actions = raw.actions;
  const first = Array.isArray(actions) ? (actions[0] as { action_ts?: unknown }) : undefined;
  if (typeof first?.action_ts === "string" && first.action_ts) return first.action_ts;
  return typeof raw.trigger_id === "string" && raw.trigger_id ? raw.trigger_id : null;
}

function messageTs(raw: Record<string, unknown>): string | null {
  const container = raw.container as { message_ts?: unknown } | undefined;
  if (typeof container?.message_ts === "string") return container.message_ts;
  const message = raw.message as { ts?: unknown } | undefined;
  return typeof message?.ts === "string" ? message.ts : null;
}

function baseUrl(deps: SlackDecisionDeps): string {
  if (deps.publicBaseUrl !== undefined) return deps.publicBaseUrl;
  try {
    return getConfig().server.public_base_url ?? "";
  } catch {
    return "";
  }
}

function slackOrigin(event: ChatEvent): Record<string, string> {
  return { source: "slack", slack_user_id: event.user_id, slack_team_id: event.workspace_id };
}

async function notify(deps: SlackDecisionDeps, ctx: ClickContext, text: string, extra = {}) {
  const copy = slackDecisionCopy(ctx.locale);
  await deps.client.ephemeral({
    channel: ctx.event.channel_id,
    user: ctx.event.user_id,
    text,
    blocks: noticeBlocks({
      copy,
      text,
      kind: ctx.action.kind,
      subject_id: ctx.action.subject_id,
      link: ctx.link,
      ...extra,
    }),
  });
}

async function showOutcome(deps: SlackDecisionDeps, ctx: ClickContext, outcome: DecisionOutcome) {
  if (!ctx.message_ts) return;
  const copy = slackDecisionCopy(ctx.locale);
  await deps.client.update({
    channel: ctx.event.channel_id,
    ts: ctx.message_ts,
    text: outcomeLine(copy, outcome),
    blocks: decidedBlocks({
      copy,
      header: ctx.header,
      outcome,
      kind: ctx.action.kind,
      subject_id: ctx.action.subject_id,
      link: ctx.link,
    }),
  });
}

function missOutcome(code: ApprovalDecisionDenialCode, by: string | null): DecisionOutcome {
  if (code === "approval_already_granted") return { state: "already_approved", by };
  if (code === "approval_already_declined") return { state: "already_declined" };
  if (code === "approval_already_used") return { state: "already_used" };
  if (code === "approval_expired") return { state: "expired" };
  return { state: "not_found" };
}

async function auditRefusal(
  deps: SlackDecisionDeps,
  ctx: ClickContext,
  actor_id: string | null,
  reason: string,
) {
  await auditAwait(
    {
      tenant_id: ctx.tenant_id,
      actor_type: actor_id ? "user" : "system",
      actor_id,
      action:
        ctx.action.verb === "approve"
          ? AuditAction.APPROVAL_GRANTED
          : AuditAction.APPROVAL_DECLINED,
      resource_type: "conversation_tool_call",
      resource_id: ctx.action.subject_id,
      result: "denied",
      reason,
      metadata: { ...slackOrigin(ctx.event), decided_via: "chat" },
    },
    deps.db,
  );
}

async function linkPrompt(deps: SlackDecisionDeps, ctx: ClickContext, reason: string) {
  await auditRefusal(deps, ctx, null, reason);
  const token = await signSlackLinkToken({
    tenant_id: ctx.tenant_id,
    team_id: ctx.event.workspace_id,
    slack_user_id: ctx.event.user_id,
  });
  await notify(deps, ctx, slackDecisionCopy(ctx.locale).notLinked, {
    link_account_url: slackLinkUrl(baseUrl(deps), token),
  });
}

async function decide(deps: SlackDecisionDeps, ctx: ClickContext): Promise<void> {
  const { db } = deps;
  const copy = slackDecisionCopy(ctx.locale);
  if (await requiresHostedChatOwnership(db, ctx.tenant_id)) {
    await auditRefusal(deps, ctx, null, "hosted_ownership_proof_required");
    await notify(deps, ctx, copy.ownership);
    return;
  }

  // tenant-filter:exempt — platform user-identity lookup pre-tenant (mirrors dispatcher.ts)
  const [identity] = await db
    .select({ user_id: chatIdentities.user_id, tenant_id: chatIdentities.tenant_id })
    .from(chatIdentities)
    .where(
      and(
        eq(chatIdentities.platform, "slack"),
        eq(chatIdentities.workspace_id, ctx.event.workspace_id),
        eq(chatIdentities.platform_user_id, ctx.event.user_id),
      ),
    )
    .limit(1);
  if (!identity) return await linkPrompt(deps, ctx, "identity_not_linked");
  if (identity.tenant_id !== ctx.tenant_id)
    return await linkPrompt(deps, ctx, "identity_tenant_mismatch");

  const user_id = identity.user_id;
  const principal = await resolveChatPrincipal(db, ctx.tenant_id, user_id);
  const approver = await findActiveApproverEmail(db, ctx.tenant_id, user_id);
  let holds = false;
  for (const permission of APPROVER_PERMISSIONS)
    holds = holds || (await principalHolds(db, principal, permission));
  const refusal = approver
    ? await taskRunApprovalRefusal(db, {
        tenant_id: ctx.tenant_id,
        approval_id: ctx.action.subject_id,
        user_id,
      })
    : "not_allowed";
  const denied = !approver ? "inactive_user" : !holds ? "rbac_denied" : refusal;
  if (denied) {
    await auditRefusal(deps, ctx, user_id, denied);
    await notify(deps, ctx, copy.forbidden);
    return;
  }

  const input = {
    db,
    approval_id: ctx.action.subject_id,
    tenant_id: ctx.tenant_id,
    granted_by_user_id: user_id,
    via: "chat" as const,
    origin: slackOrigin(ctx.event),
  };
  const trace = { tenant_id: ctx.tenant_id, approval_id: ctx.action.subject_id };
  const result = await inTaskRunApprovalTrace(db, trace, () =>
    ctx.action.verb === "approve" ? grantApproval(input) : declineApproval(input),
  );
  if (!result.ok) {
    const by =
      result.code === "approval_already_granted"
        ? await grantedByName(db, ctx.tenant_id, ctx.action.subject_id)
        : null;
    await showOutcome(deps, ctx, missOutcome(result.code, by));
    return;
  }

  const decision = ctx.action.verb;
  const resume =
    deps.resume ??
    ((p: Parameters<ResumeEnqueuer>[0]) => enqueueApprovalElicitationResume(p, db, getBoss()));
  const completion = await inTaskRunApprovalTrace(db, trace, () =>
    completeApprovalBackedElicitation(
      {
        tenant_id: ctx.tenant_id,
        approval_id: ctx.action.subject_id,
        decision,
        approver_user_id: user_id,
        resume,
      },
      db,
    ),
  );
  logger.info({
    module: "chat",
    action: decision === "approve" ? "slack.decision.granted" : "slack.decision.declined",
    msg: "a person decided on a tool approval from a Slack message",
    tenant_id: ctx.tenant_id,
    approval_id: ctx.action.subject_id,
    user_id,
    slack_user_id: ctx.event.user_id,
    elicitations_matched: completion.matched,
    elicitations_resumed: completion.resumed,
  });
  await showOutcome(deps, ctx, {
    state: decision === "approve" ? "approved" : "declined",
    slack_user_id: ctx.event.user_id,
    actor_name: (await personName(db, ctx.tenant_id, user_id)) ?? approver ?? user_id,
    at: deps.clock ? deps.clock() : new Date(now()),
  });
}

export async function handleSlackDecisionInteraction(
  event: ChatEvent,
  deps: SlackDecisionDeps,
): Promise<{ handled: boolean }> {
  const action_id = event.interaction?.action_id ?? "";
  if (event.kind !== "interaction") return { handled: false };
  if (isOpenAction(action_id)) return { handled: true };
  const action = parseDecisionAction(action_id);
  if (!action) return { handled: false };

  const raw = rawPayload(event);
  let ctx: ClickContext | null = null;
  try {
    // tenant-filter:exempt — platform/workspace_id lookup pre-tenant (mirrors dispatcher.ts)
    const [workspace] = await deps.db
      .select({ id: chatWorkspaces.id, tenant_id: chatWorkspaces.tenant_id })
      .from(chatWorkspaces)
      .where(
        and(
          eq(chatWorkspaces.platform, "slack"),
          eq(chatWorkspaces.workspace_id, event.workspace_id),
        ),
      )
      .limit(1);
    if (!workspace) {
      logger.warn({
        module: "chat",
        action: "slack.decision.unknown_workspace",
        msg: "decision click from a Slack workspace with no chat_workspaces row",
        platform_workspace_id: event.workspace_id,
      });
      return { handled: true };
    }
    const stamp = actionStamp(raw);
    if (!stamp) return { handled: true };
    const fresh = await markChatEventSeen(deps.db, {
      tenant_id: workspace.tenant_id,
      workspace_id: workspace.id,
      platform_event_id: `sk_decide:${stamp}:${event.user_id}`,
    });
    if (!fresh) return { handled: true };

    ctx = {
      event,
      action,
      tenant_id: workspace.tenant_id,
      workspace_row_id: workspace.id,
      locale: await tenantLanguage(deps.db, workspace.tenant_id),
      link: absoluteLink(baseUrl(deps), safeCockpitPath(event.interaction?.value)),
      message_ts: messageTs(raw),
      header: headerFromMessage(raw.message),
    };
    await decide(deps, ctx);
  } catch (error) {
    logger.error({
      module: "chat",
      action: "slack.decision.failed",
      msg: "a Slack decision click failed; nothing was decided by this handler",
      approval_id: action.subject_id,
      ...errorFields(error),
    });
    if (ctx) {
      try {
        await notify(deps, ctx, slackDecisionCopy(ctx.locale).failed);
      } catch {}
    }
  }
  return { handled: true };
}
