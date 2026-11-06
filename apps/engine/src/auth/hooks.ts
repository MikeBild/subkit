import { and, eq } from "drizzle-orm";
import { writeAudit } from "../db/audit.ts";
import type { Db } from "../db/client.ts";
import { requestHooks } from "../db/schema/request_hooks.ts";
import { logger } from "../logging/logger.ts";
import { runJs } from "../sandboxes/quickjs/runtime.ts";
import type { ResolvedPrincipal } from "./types.ts";

interface HookRequestCtx {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  execution_id: string;
  workflow_id: string;
  step_id: string;
}

interface HookDecision {
  allowed: boolean;
  reason?: string;
  hook_id?: string;
}

const HOOK_LIMITS = {
  memory_bytes: 32 * 1024 * 1024,
  tick_budget: 100_000,
  wall_ms: 2_000,
} as const;

interface EvaluateHookParams {
  db: Db;
  tenant_id: string;
  principal: ResolvedPrincipal;
  requestCtx: HookRequestCtx;
  trace_id?: string | null;
}

export async function evaluateHook(p: EvaluateHookParams): Promise<HookDecision> {
  const { db, tenant_id, principal, requestCtx } = p;
  if (!principal.roles || principal.roles.length === 0) {
    return { allowed: true };
  }

  const rows = await db
    .select()
    .from(requestHooks)
    .where(and(eq(requestHooks.tenant_id, tenant_id), eq(requestHooks.enabled, true)));

  const applicable = rows
    .filter((row) => principal.roles.includes(row.role))
    .sort((a, b) => {
      if (a.role !== b.role) return a.role < b.role ? -1 : 1;
      if (a.version !== b.version) return b.version - a.version;
      return a.id < b.id ? -1 : 1;
    });

  const latestPerRole = new Map<string, (typeof applicable)[number]>();
  for (const row of applicable) {
    if (!latestPerRole.has(row.role)) {
      latestPerRole.set(row.role, row);
    }
  }

  for (const row of latestPerRole.values()) {
    const decision = await runHook(row.source, {
      principal: {
        id: principal.id,
        kind: principal.kind,
        roles: principal.roles,
        tenant_id: principal.tenant_id,
      },
      request: {
        method: requestCtx.method,
        url: requestCtx.url,
        headers: requestCtx.headers,
        body: requestCtx.body ?? null,
      },
      execution_id: requestCtx.execution_id,
      workflow_id: requestCtx.workflow_id,
      step_id: requestCtx.step_id,
    });

    if (!decision.allowed) {
      try {
        await writeAudit(
          {
            id: crypto.randomUUID(),
            ts: new Date(),
            tenant_id,
            actor_type: principal.kind,
            actor_id: principal.id,
            action: "policy.denied",
            resource_type: "request_hook",
            resource_id: row.id,
            result: "denied",
            trace_id: p.trace_id ?? "",
            ip: null,
            user_agent: null,
            before: null,
            after: null,
            reason: decision.reason ?? "hook_denied",
            metadata: {
              hook_role: row.role,
              execution_id: requestCtx.execution_id,
              workflow_id: requestCtx.workflow_id,
              step_id: requestCtx.step_id,
              method: requestCtx.method,
              url: requestCtx.url,
            },
          },
          db,
        );
      } catch (err) {
        logger.error({
          module: "auth",
          action: "hook.audit_failed",
          msg: "failed to write hook denial audit row",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return { allowed: false, reason: decision.reason ?? "hook_denied", hook_id: row.id };
    }
  }

  return { allowed: true };
}

async function runHook(
  source: string,
  hookInput: Record<string, unknown>,
): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const { output } = await runJs<unknown>({
      code: source,
      input: hookInput,
      limits: HOOK_LIMITS,
      clock: null,
      priority: "hook",
    });
    if (!output || typeof output !== "object") {
      return { allowed: false, reason: "hook_error" };
    }
    const o = output as { allow?: unknown; reason?: unknown };
    if (o.allow === true) {
      return { allowed: true };
    }
    if (o.allow === false) {
      const reason = typeof o.reason === "string" ? o.reason : "hook_denied";
      return { allowed: false, reason };
    }
    return { allowed: false, reason: "hook_error" };
  } catch (err) {
    logger.warn({
      module: "auth",
      action: "hook.exception",
      msg: "hook threw during evaluation — denying",
      error: err instanceof Error ? err.message : String(err),
    });
    return { allowed: false, reason: "hook_error" };
  }
}

export async function lintHookSource(
  source: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await runJs({
      code: source,
      input: { lint: true },
      limits: { tick_budget: 50_000, wall_ms: 1_000, memory_bytes: 16 * 1024 * 1024 },
      clock: null,
      priority: "hook",
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof Error && err.name === "SandboxSyntaxError") {
      return { ok: false, error: err.message };
    }
    return { ok: true };
  }
}
export * from "./hooks-admin.ts";
