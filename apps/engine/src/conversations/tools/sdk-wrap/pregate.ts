import type {
  ConversationTool,
  ToolContext,
  ToolEffect,
  ToolPrecheck,
  ToolResult,
} from "../index.ts";
import { checkToolPermission, type ToolPermissionResult } from "../permission-gate.ts";

export function permissionRefusal(
  inner: ConversationTool,
  denied: Extract<ToolPermissionResult, { allow: false }>,
): ToolResult {
  return (
    inner.permission?.denyResult?.(denied.permission, denied.reason) ?? {
      ok: false,
      data: {
        error: "permission_denied",
        permission: denied.permission,
        reason: denied.reason,
      },
    }
  );
}

export async function checkBeforeGate(
  inner: ConversationTool,
  ctx: ToolContext,
  rawArgs: Record<string, unknown>,
): Promise<ToolPrecheck | null> {
  if (!inner.precheck) return null;
  if (inner.permission) {
    const permitted = await checkToolPermission(ctx, inner.permission, rawArgs);
    if (!permitted.allow) return { ok: false, result: permissionRefusal(inner, permitted) };
  }
  return inner.precheck(ctx, rawArgs);
}

export function describeToolEffect(effect: ToolEffect): string {
  return `${effect.connector}: ${effect.method}${effect.target ? ` ${effect.target}` : ""}`;
}
