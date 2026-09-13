// Before-Request Hook evaluator.
//
// A before-request hook is user-supplied JavaScript that runs in QuickJS
// with tight limits (100k opcode budget, 32 MB memory) before every
// outbound `request` step. Hooks are keyed by role in the
// `request_hooks` table. The evaluator:
//
//   1. Loads every enabled hook whose role is in the principal's role
//      set, ordered deterministically.
//   2. Runs each hook in sequence. The first hook that returns
//      `{ allow: false, reason: string }` denies the request.
//   3. Any exception, malformed return shape, or sandbox failure
//      fails-closed with the reason `"hook_error"`.
//   4. Emits an audit row on denial so SOC2-style reviews can surface
//      which hook blocked which request.

import { and, eq } from "drizzle-orm";

import { writeAudit } from "../db/audit.ts";
import type { Db } from "../db/client.ts";
import { requestHooks } from "../db/schema/request_hooks.ts";
import { logger } from "../logging/logger.ts";
import { runJs } from "../sandboxes/quickjs/runtime.ts";
import type { ResolvedPrincipal } from "./types.ts";

export interface HookRequestCtx {
  method: string;
  url: string;
  headers: Record<string, string>;
  // Whatever JSON body the request will send, if any.
  body?: unknown;
  // Current workflow execution metadata for logging / policy decisions.
  execution_id: string;
  workflow_id: string;
  step_id: string;
}

export interface HookDecision {
  allowed: boolean;
  reason?: string;
  /** Hook row id that produced the decision, if any. */
  hook_id?: string;
}

const HOOK_LIMITS = {
  memory_bytes: 32 * 1024 * 1024,
  tick_budget: 100_000,
  wall_ms: 2_000,
} as const;

export interface EvaluateHookParams {
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

  // Load every enabled hook for any role the principal holds. We pull
  // them all in one query and filter in-memory to keep the SQL simple
  // and deterministic.
  const rows = await db
    .select()
    .from(requestHooks)
    .where(and(eq(requestHooks.tenant_id, tenant_id), eq(requestHooks.enabled, true)));

  const applicable = rows
    .filter((row) => principal.roles.includes(row.role))
    .sort((a, b) => {
      // Deterministic: by role, then version desc (latest first), then id.
      if (a.role !== b.role) return a.role < b.role ? -1 : 1;
      if (a.version !== b.version) return b.version - a.version;
      return a.id < b.id ? -1 : 1;
    });

  // Collapse to latest version per role.
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
      // Fail-closed audit row. Bind to the caller's db executor so the
      // row lands in the same logical database as the execution.
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
      // Before-request hooks are policy predicates, not execution
      // transforms — no fixed instant to thread, intentionally constant.
      clock: null,
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

/**
 * Cheap syntax lint used by the admin CRUD route to reject malformed
 * source before it gets persisted. Runs the code against a dummy input
 * under very tight limits and swallows runtime errors so only syntax
 * failures surface.
 */
export async function lintHookSource(
  source: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await runJs({
      code: source,
      input: { lint: true },
      limits: { tick_budget: 50_000, wall_ms: 1_000, memory_bytes: 16 * 1024 * 1024 },
      // Syntax lint only — no execution context, intentionally constant.
      clock: null,
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof Error && err.name === "SandboxSyntaxError") {
      return { ok: false, error: err.message };
    }
    // Runtime failures during lint are fine — the hook will be exercised
    // with real input at request-time.
    return { ok: true };
  }
}
