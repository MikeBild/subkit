// update_subscription — patch an outbound webhook subscription's
// event pattern, target URL, active flag, or signing secret. Generic
// patch shape; send only the fields that should change.
//
// Pattern parity with update_workflow / update_connector /
// update_knowledge_source / update_schedule. Audit funnels through
// the existing `subscription.updated` action.

import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../../index.ts";

const UpdateSubscriptionInput = z
  .object({
    id: z.string().uuid("subscription id must be a UUID"),
    event_pattern: z.string().min(1).optional(),
    target_url: z.string().url().optional(),
    active: z.boolean().optional(),
    secret: z.string().min(8).optional(),
    rotating_secret: z.string().min(8).nullable().optional(),
  })
  .refine(
    (v) =>
      Boolean(
        v.event_pattern ||
          v.target_url ||
          v.active !== undefined ||
          v.secret ||
          v.rotating_secret !== undefined,
      ),
    {
      message:
        "At least one of event_pattern, target_url, active, secret, or rotating_secret is required",
    },
  )
  .openapi("UpdateSubscriptionToolInput");

export const updateSubscriptionTool: ConversationTool = {
  name: "update_subscription",
  description:
    "Patch an outbound webhook subscription — change its event pattern, retarget the URL, pause/resume it, or rotate the signing secret.",
  use_case:
    "Use when the user asks to retarget a subscription, change its event filter, pause/resume delivery, or rotate the signing secret. Send only the fields that should change.",
  important_notes: [
    "At least one patch field is required.",
    "Setting rotating_secret=null clears it (returns to single-secret signing); a non-null value enables dual-secret rotation for a grace period.",
    "Audits as subscription.updated with the list of changed fields. Secret material never appears in audit metadata.",
  ],
  inputSchema: UpdateSubscriptionInput,
  category: "tenant_write",
  permission: { action: "subscription:write", resourceType: "subscription", resourceIdArg: "id" },
  async execute(ctx, rawArgs) {
    const args = UpdateSubscriptionInput.parse(rawArgs);
    try {
      const row = await ctx.engineClient.subscriptions.update(args.id, {
        ...(args.event_pattern !== undefined ? { event_pattern: args.event_pattern } : {}),
        ...(args.target_url !== undefined ? { target_url: args.target_url } : {}),
        ...(args.active !== undefined ? { active: args.active } : {}),
        ...(args.secret !== undefined ? { secret: args.secret } : {}),
        ...(args.rotating_secret !== undefined ? { rotating_secret: args.rotating_secret } : {}),
      });

      if (!row) {
        return { ok: false, data: { error: "subscription_not_found", id: args.id } };
      }

      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "subscription",
        resource_id: row.id,
        action: "conversation.update_subscription",
        result: "success",
        metadata: {
          conversation_id: ctx.conversation_id,
          // Never log the raw secret — only the fact that it changed.
          fields: Object.keys(args).filter((k) => k !== "id"),
        },
      });

      return {
        ok: true,
        data: {
          updated: true,
          subscription: {
            id: row.id,
            event_pattern: row.event_pattern,
            target_url: row.target_url,
            active: row.active,
          },
          audit_log_id,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, data: { error: "update_failed", message: msg } };
    }
  },
};
