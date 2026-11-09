import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import pg from "pg";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db, Executor } from "../db/client.ts";
import { hostedQuotaError } from "../db/hosted-quota-errors.ts";
import { conversations, conversationTurns } from "../db/schema/index.ts";
import { retryTransient } from "../db/transient.ts";
import { logger } from "../logging/logger.ts";
import { setMcpTaskFailureIfNotTerminal } from "../mcp/tasks/store.ts";
import { registerConversationAbort, unregisterConversationAbort } from "./abort.ts";
import { ConversationTurnInProgressError } from "./errors.ts";
import { ConversationNotFoundError } from "./service/shared.ts";

const workerId = randomUUID();
const owners = new WeakMap<AbortController, { id: string; attempt: string; db: Db }>();
const signals = new WeakMap<
  AbortSignal,
  { ctrl: AbortController; tenant: string; conversation: string }
>();
const timers = new WeakMap<AbortController, ReturnType<typeof setInterval>>();
const failures = new WeakSet<AbortController>();
const leases = new WeakMap<AbortController, pg.Client>();
interface WorkerSession {
  db: Db;
  client: pg.Client;
  ready: Promise<void>;
  held: Set<string>;
  controllers: Map<string, AbortController>;
}
const workerSessions = new WeakMap<Db, WorkerSession>();
const clientSessions = new WeakMap<pg.Client, WorkerSession>();

async function closeIdleSession(session: WorkerSession): Promise<void> {
  if (session.held.size > 0) return;
  if (workerSessions.get(session.db) === session) workerSessions.delete(session.db);
  await session.client.end().catch(() => {});
}

async function lease(db: Db, id: string): Promise<pg.Client | null> {
  let session = workerSessions.get(db);
  if (!session) {
    const client = new pg.Client({
      ...(db as Db & { $client: pg.Pool }).$client.options,
      application_name: "subkit-conversation-turn",
    });
    session = {
      db,
      client,
      ready: client.connect().then(() => {}),
      held: new Set(),
      controllers: new Map(),
    };
    const ownedSession = session;
    client.on("error", (error: Error) => {
      if (workerSessions.get(db) === ownedSession) workerSessions.delete(db);
      for (const ctrl of ownedSession.controllers.values()) ctrl.abort(error);
    });
    workerSessions.set(db, session);
    clientSessions.set(client, session);
  }
  if (session.held.has(id)) return null;
  session.held.add(id);
  try {
    await session.ready;
    const result = await session.client.query<{ claimed: boolean }>(
      "SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended($1, 0)) AS claimed",
      [`conversation-turn:${id}`],
    );
    if (result.rows[0]?.claimed) return session.client;
    session.held.delete(id);
    await closeIdleSession(session);
    return null;
  } catch (error) {
    session.held.delete(id);
    await closeIdleSession(session);
    throw error;
  }
}

async function releaseLease(client: pg.Client, id: string): Promise<void> {
  const session = clientSessions.get(client);
  try {
    await client.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1, 0))", [
      `conversation-turn:${id}`,
    ]);
  } catch {
  } finally {
    session?.held.delete(id);
    session?.controllers.delete(id);
    if (session) await closeIdleSession(session);
  }
}

async function reconcileInterruptedConversationTurn(
  db: Db,
  tenantId: string,
  conversationId: string,
): Promise<void> {
  const [row] = await db
    .select()
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.tenant_id, tenantId),
        eq(conversationTurns.conversation_id, conversationId),
        eq(conversationTurns.state, "running"),
      ),
    )
    .limit(1);
  if (!row) return;
  const proof = await lease(db, row.id);
  if (!proof) return;
  try {
    await finishConversationTurn(
      db,
      tenantId,
      conversationId,
      row.id,
      "failed",
      row.attempt_id ?? undefined,
    );
    if (row.task_id)
      await setMcpTaskFailureIfNotTerminal(
        tenantId,
        row.task_id,
        "conversation_worker_interrupted",
        db,
        row.attempt_id ?? undefined,
      );
  } finally {
    await releaseLease(proof, row.id);
  }
}

async function changed(
  db: Executor,
  tenantId: string,
  conversationId: string,
  id: string,
  state: string,
) {
  await auditAwait(
    {
      tenant_id: tenantId,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.CONVERSATION_TURN_CHANGED,
      resource_type: "conversation",
      resource_id: conversationId,
      result: "success",
      metadata: { turn_id: id, state },
    },
    db,
  );
  logger.info({
    module: "conversation",
    action: "turn.changed",
    tenant_id: tenantId,
    conversation_id: conversationId,
    turn_id: id,
    state,
  });
}

export async function reserveConversationTurn(
  db: Db,
  tenantId: string,
  conversationId: string,
): Promise<string> {
  await reconcileInterruptedConversationTurn(db, tenantId, conversationId);
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, tenantId), eq(conversations.id, conversationId)))
      .limit(1);
    if (!conversation) throw new ConversationNotFoundError(conversationId);
    const [row] = await tx
      .insert(conversationTurns)
      .values({ tenant_id: tenantId, conversation_id: conversationId, state: "queued" })
      .onConflictDoNothing()
      .returning({ id: conversationTurns.id });
    if (!row) throw new ConversationTurnInProgressError();
    await changed(tx, tenantId, conversationId, row.id, "queued");
    return row.id;
  });
}

export async function assertConversationAvailable(
  db: Db,
  tenantId: string,
  conversationId: string,
  turnId?: string,
): Promise<void> {
  const [row] = await db
    .select({ id: conversationTurns.id })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.tenant_id, tenantId),
        eq(conversationTurns.conversation_id, conversationId),
        inArray(conversationTurns.state, ["queued", "running", "parked"]),
      ),
    )
    .limit(1);
  if ((turnId && row?.id !== turnId) || (row && row.id !== turnId))
    throw new ConversationTurnInProgressError();
}

export async function withReservedConversationTurn<T extends { isError: boolean }>(
  db: Db,
  tenantId: string,
  conversationId: string,
  prepare: (turnId: string) => Promise<T>,
): Promise<T> {
  const id = await reserveConversationTurn(db, tenantId, conversationId);
  try {
    const result = await prepare(id);
    if (result.isError) await finishConversationTurn(db, tenantId, conversationId, id, "failed");
    return result;
  } catch (error) {
    await finishConversationTurn(db, tenantId, conversationId, id, "failed");
    throw error;
  }
}

export async function finishConversationTurn(
  db: Executor,
  tenantId: string,
  conversationId: string,
  id: string,
  state: "completed" | "failed" | "cancelled" = "completed",
  attempt?: string | null,
): Promise<void> {
  const rows = await db
    .update(conversationTurns)
    .set({ state, updated_at: new Date() })
    .where(
      and(
        eq(conversationTurns.tenant_id, tenantId),
        eq(conversationTurns.conversation_id, conversationId),
        eq(conversationTurns.id, id),
        inArray(conversationTurns.state, ["queued", "running", "parked"]),
        ...(attempt !== undefined
          ? [
              attempt === null
                ? isNull(conversationTurns.attempt_id)
                : eq(conversationTurns.attempt_id, attempt),
            ]
          : []),
      ),
    )
    .returning({ id: conversationTurns.id });
  if (rows.length) await changed(db, tenantId, conversationId, id, state);
}

export async function bindConversationTurn(
  db: Db,
  tenantId: string,
  conversationId: string,
  id: string,
  taskId: string,
  attempt: string,
  previousAttempt?: string,
): Promise<void> {
  const [row] = await db
    .update(conversationTurns)
    .set({ task_id: taskId, attempt_id: attempt, updated_at: new Date() })
    .where(
      and(
        eq(conversationTurns.tenant_id, tenantId),
        eq(conversationTurns.conversation_id, conversationId),
        eq(conversationTurns.id, id),
        inArray(conversationTurns.state, ["queued", "parked"]),
        ...(previousAttempt ? [eq(conversationTurns.attempt_id, previousAttempt)] : []),
      ),
    )
    .returning({ id: conversationTurns.id });
  if (!row) throw new ConversationTurnInProgressError();
}

export async function acquireConversationTurn(
  tenantId: string,
  conversationId: string,
  db: Db,
  queued?: { turn_id: string; attempt_id: string },
): Promise<AbortController> {
  const id = queued?.turn_id ?? (await reserveConversationTurn(db, tenantId, conversationId));
  const attempt = queued?.attempt_id ?? randomUUID();
  const proof = await lease(db, id);
  if (!proof) throw new ConversationTurnInProgressError();
  let ctrl: AbortController | undefined;
  try {
    await retryTransient(
      () =>
        db.transaction(async (tx) => {
          const [row] = await tx
            .update(conversationTurns)
            .set({
              state: "running",
              attempt_id: attempt,
              worker_id: workerId,
              updated_at: new Date(),
            })
            .where(
              and(
                eq(conversationTurns.tenant_id, tenantId),
                eq(conversationTurns.conversation_id, conversationId),
                eq(conversationTurns.id, id),
                inArray(conversationTurns.state, ["queued", "parked"]),
                ...(queued ? [eq(conversationTurns.attempt_id, attempt)] : []),
              ),
            )
            .returning({ id: conversationTurns.id });
          if (!row) throw new ConversationTurnInProgressError();
          await changed(tx, tenantId, conversationId, id, "running");
        }),
      {
        label: "conversation_turn_acquire",
        shouldRetry: (error) => hostedQuotaError(error)?.code === "40001",
      },
    );
    ctrl = registerConversationAbort(tenantId, conversationId);
    const ownedController = ctrl;
    clientSessions.get(proof)?.controllers.set(id, ownedController);
    leases.set(ctrl, proof);
    owners.set(ctrl, { id, attempt, db });
    signals.set(ctrl.signal, { ctrl, tenant: tenantId, conversation: conversationId });
    const timer = setInterval(() => {
      void assertConversationTurn(ownedController.signal).catch((error: unknown) =>
        ownedController.abort(error),
      );
    }, 1000);
    timer.unref();
    timers.set(ctrl, timer);
    return ctrl;
  } catch (error) {
    if (ctrl) {
      clearInterval(timers.get(ctrl));
      unregisterConversationAbort(tenantId, conversationId, ctrl);
      owners.delete(ctrl);
    }
    try {
      await finishConversationTurn(db, tenantId, conversationId, id, "failed", attempt);
    } finally {
      await releaseLease(proof, id);
    }
    throw error;
  }
}

export function conversationTurnId(ctrl: AbortController): string | undefined {
  return owners.get(ctrl)?.id;
}

export function markConversationTurnFailed(ctrl: AbortController): void {
  failures.add(ctrl);
}

export async function assertConversationTurn(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) return;
  const scope = signals.get(signal);
  const owner = scope ? owners.get(scope.ctrl) : undefined;
  if (!scope || !owner) return;
  const [row] = await owner.db
    .select({ state: conversationTurns.state, cancelled: conversationTurns.cancel_requested })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.tenant_id, scope.tenant),
        eq(conversationTurns.conversation_id, scope.conversation),
        eq(conversationTurns.id, owner.id),
        eq(conversationTurns.attempt_id, owner.attempt),
      ),
    )
    .limit(1);
  if (row?.state !== "running" || row.cancelled) {
    scope.ctrl.abort(row?.cancelled ? "conversation_cancelled" : "conversation_turn_superseded");
    signal.throwIfAborted();
  }
}

export async function cancelConversationTurns(
  db: Db,
  tenantId: string,
  conversationId: string,
): Promise<void> {
  const cancelled = await db
    .update(conversationTurns)
    .set({ state: "cancelled", cancel_requested: true, updated_at: new Date() })
    .where(
      and(
        eq(conversationTurns.tenant_id, tenantId),
        eq(conversationTurns.conversation_id, conversationId),
        inArray(conversationTurns.state, ["queued", "parked"]),
      ),
    )
    .returning({ id: conversationTurns.id, task_id: conversationTurns.task_id });
  for (const row of cancelled) {
    await changed(db, tenantId, conversationId, row.id, "cancelled");
    if (row.task_id)
      await setMcpTaskFailureIfNotTerminal(tenantId, row.task_id, "conversation_cancelled", db);
  }
  const running = await db
    .update(conversationTurns)
    .set({ cancel_requested: true, updated_at: new Date() })
    .where(
      and(
        eq(conversationTurns.tenant_id, tenantId),
        eq(conversationTurns.conversation_id, conversationId),
        eq(conversationTurns.state, "running"),
      ),
    )
    .returning({ id: conversationTurns.id });
  for (const row of running)
    await changed(db, tenantId, conversationId, row.id, "cancellation_requested");
}

export async function stopConversationTaskTurn(
  db: Db,
  tenantId: string,
  conversationId: string,
  turnId: string,
  taskId: string,
  attempt: string,
  state: "completed" | "failed" | "cancelled" = "failed",
): Promise<void> {
  await db.transaction(async (tx) => {
    const scope = and(
      eq(conversationTurns.tenant_id, tenantId),
      eq(conversationTurns.conversation_id, conversationId),
      eq(conversationTurns.id, turnId),
      eq(conversationTurns.task_id, taskId),
      eq(conversationTurns.attempt_id, attempt),
    );
    const stopped = await tx
      .update(conversationTurns)
      .set({ state, updated_at: new Date() })
      .where(and(scope, inArray(conversationTurns.state, ["queued", "parked"])))
      .returning({ id: conversationTurns.id });
    for (const row of stopped) await changed(tx, tenantId, conversationId, row.id, state);
    if (state === "completed") return;
    const running = await tx
      .update(conversationTurns)
      .set({ cancel_requested: true, updated_at: new Date() })
      .where(and(scope, eq(conversationTurns.state, "running")))
      .returning({ id: conversationTurns.id });
    for (const row of running)
      await changed(tx, tenantId, conversationId, row.id, "cancellation_requested");
  });
  await reconcileInterruptedConversationTurn(db, tenantId, conversationId);
}

export async function parkConversationTurn(
  tenantId: string,
  conversationId: string,
  ctrl: AbortController,
): Promise<void> {
  const owner = owners.get(ctrl);
  if (!owner) throw new Error("conversation turn has no owner");
  const [row] = await owner.db
    .update(conversationTurns)
    .set({ state: "parked", worker_id: null, updated_at: new Date() })
    .where(
      and(
        eq(conversationTurns.tenant_id, tenantId),
        eq(conversationTurns.conversation_id, conversationId),
        eq(conversationTurns.id, owner.id),
        eq(conversationTurns.attempt_id, owner.attempt),
        eq(conversationTurns.state, "running"),
      ),
    )
    .returning({ id: conversationTurns.id });
  if (!row) throw new Error("conversation turn ownership lost");
  owners.delete(ctrl);
  clearInterval(timers.get(ctrl));
  timers.delete(ctrl);
  const proof = leases.get(ctrl);
  leases.delete(ctrl);
  if (proof) await releaseLease(proof, owner.id);
  unregisterConversationAbort(tenantId, conversationId, ctrl);
  await changed(owner.db, tenantId, conversationId, owner.id, "parked");
}

export async function releaseConversationTurn(
  tenantId: string,
  conversationId: string,
  ctrl: AbortController,
  state: "completed" | "failed" | "cancelled" = "completed",
): Promise<void> {
  const owner = owners.get(ctrl);
  try {
    if (owner)
      await finishConversationTurn(
        owner.db,
        tenantId,
        conversationId,
        owner.id,
        ctrl.signal.aborted ? "cancelled" : failures.has(ctrl) ? "failed" : state,
        owner.attempt,
      );
  } finally {
    owners.delete(ctrl);
    clearInterval(timers.get(ctrl));
    timers.delete(ctrl);
    const proof = leases.get(ctrl);
    leases.delete(ctrl);
    if (owner && proof) await releaseLease(proof, owner.id);
    unregisterConversationAbort(tenantId, conversationId, ctrl);
  }
}

export { ConversationTurnInProgressError } from "./errors.ts";
