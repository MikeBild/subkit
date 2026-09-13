// Pin the cancel-race contract + the cross-tenant
// isolation contract: registration + cancel must
// always meet via the same registry, AND a foreign tenant POSTing
// against another tenant's conversation_id must not be able to
// displace the legitimate registration.
//
// The integration cover (tests/e2e/authoring-regressions.e2e.test.ts
// "cancelling a slow preview…") exercises the full HTTP path; this
// suite pins the bare contract so a future refactor can't quietly
// reopen either race without flagging a unit-test failure.

import { afterEach, describe, expect, test } from "bun:test";

import {
  __hasConversationAbort,
  cancelConversationAbort,
  CONVERSATION_CANCELLED_REASON,
  registerConversationAbort,
  unregisterConversationAbort,
} from "./abort.ts";

describe("conversation abort registry", () => {
  // Each test owns a unique conversation id so the process-local
  // registry does not leak state between cases. A monotonic counter
  // is enough — registry slots are also tenant-scoped, and `afterEach`
  // sweeps everything we registered.
  let nextId = 0;
  const newConvId = (): string => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
  const TENANT_A = "00000000-0000-4000-8000-aaaaaaaaaaaa";
  const TENANT_B = "00000000-0000-4000-8000-bbbbbbbbbbbb";

  // Track every (tenant, convId) pair created in this suite so a
  // failure inside a test still leaves the registry clean.
  const created: Array<{ tenant: string; conv: string }> = [];
  function track(tenant: string, conv: string): { tenant: string; conv: string } {
    created.push({ tenant, conv });
    return { tenant, conv };
  }
  afterEach(() => {
    for (const { tenant, conv } of created.splice(0)) {
      unregisterConversationAbort(tenant, conv);
    }
  });

  test("registerConversationAbort returns a fresh, un-aborted controller", () => {
    const { tenant, conv } = track(TENANT_A, newConvId());
    const ctrl = registerConversationAbort(tenant, conv);
    expect(ctrl.signal.aborted).toBe(false);
  });

  test("cancelConversationAbort returns true and aborts the registered controller", () => {
    const { tenant, conv } = track(TENANT_A, newConvId());
    const ctrl = registerConversationAbort(tenant, conv);
    expect(cancelConversationAbort(tenant, conv)).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
    expect(ctrl.signal.reason).toBe(CONVERSATION_CANCELLED_REASON);
  });

  test("cancel-before-first-dispatch: a cancel issued the same tick as register still aborts the loop's signal", () => {
    // Pre-A4 the loop body called registerConversationAbort *itself* —
    // a cancel arriving in the few-ms window between request-accept
    // and that call hit an empty registry and silently returned false.
    // Post-A4 the route handler registers synchronously, so the loop
    // consumes whatever the handler registered and a same-tick cancel
    // is observable as `signal.aborted` once the loop reaches its
    // first abort-checkable hop.
    const { tenant, conv } = track(TENANT_A, newConvId());
    const ctrl = registerConversationAbort(tenant, conv);
    const ok = cancelConversationAbort(tenant, conv);
    expect(ok).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });

  test("cancelConversationAbort returns false when no controller is registered", () => {
    // Reachable on legitimate paths after the turn has already
    // completed (controller already unregistered) and on
    // multi-replica deploys without sticky routing. The DB-side
    // status flip in cancelConversation is the source of truth; the
    // warn here is observability for the in-memory layer.
    const { tenant, conv } = track(TENANT_A, newConvId());
    expect(cancelConversationAbort(tenant, conv)).toBe(false);
  });

  test("unregister is scoped to the controller that owns it (no cross-cancel)", () => {
    const { tenant, conv } = track(TENANT_A, newConvId());
    const ctrl1 = registerConversationAbort(tenant, conv);
    const ctrl2 = registerConversationAbort(tenant, conv); // overwrites ctrl1 in registry
    // Trying to unregister with the stale handle is a no-op.
    unregisterConversationAbort(tenant, conv, ctrl1);
    expect(cancelConversationAbort(tenant, conv)).toBe(true);
    expect(ctrl2.signal.aborted).toBe(true);
    expect(ctrl1.signal.aborted).toBe(false);
  });

  // ---------- cross-tenant isolation -------------

  test("a foreign tenant cannot displace another tenant's registered controller", () => {
    // The pre-fix bug: the registry was keyed on conversation_id
    // alone. Tenant A POSTing /messages with Tenant B's UUID
    // overwrote B's controller; A's appendUserMessage then threw
    // (tenant-scoped getConversation returns null) and A's `finally`
    // unregistered the slot — leaving B's loop uncancellable.
    //
    // With tenant-scoped keys, A's registration lives in its own
    // slot and B's controller stays put.
    const conv = newConvId(); // SAME UUID for both tenants
    track(TENANT_A, conv);
    track(TENANT_B, conv);

    const ctrlB = registerConversationAbort(TENANT_B, conv);
    // Tenant A probes B's conversation id — registers under A's slot.
    const ctrlA = registerConversationAbort(TENANT_A, conv);
    expect(ctrlA).not.toBe(ctrlB);

    // A's request completes / errors and unregisters its OWN slot.
    unregisterConversationAbort(TENANT_A, conv, ctrlA);

    // Tenant B issues cancel — must still find its own controller.
    expect(cancelConversationAbort(TENANT_B, conv)).toBe(true);
    expect(ctrlB.signal.aborted).toBe(true);
    expect(ctrlA.signal.aborted).toBe(false);
  });

  test("a foreign tenant cancel cannot abort another tenant's controller", () => {
    const conv = newConvId();
    track(TENANT_A, conv);
    track(TENANT_B, conv);

    const ctrlA = registerConversationAbort(TENANT_A, conv);
    // Tenant B issues cancel against the same UUID — the cancel
    // route checks tenant ownership first (lifecycle.ts:18), but
    // even if a regression skipped that check, the tenant-scoped
    // registry never hands B the lookup for A's slot.
    expect(cancelConversationAbort(TENANT_B, conv)).toBe(false);
    expect(ctrlA.signal.aborted).toBe(false);
  });

  test("registry slots for the same conversation id under different tenants do not interfere", () => {
    const conv = newConvId();
    track(TENANT_A, conv);
    track(TENANT_B, conv);

    const ctrlA = registerConversationAbort(TENANT_A, conv);
    const ctrlB = registerConversationAbort(TENANT_B, conv);
    expect(cancelConversationAbort(TENANT_A, conv)).toBe(true);
    expect(ctrlA.signal.aborted).toBe(true);
    // B's slot is untouched by A's cancel.
    expect(ctrlB.signal.aborted).toBe(false);
    expect(cancelConversationAbort(TENANT_B, conv)).toBe(true);
    expect(ctrlB.signal.aborted).toBe(true);
  });

  // ---------- SSE ownership-transfer ------------

  test("SSE ownership-transfer: stale-handle unregister attempts must not zero the new live slot", () => {
    // The pre-fix bug surfaced only on the SSE path: Hono's
    // `streamSSE` returns synchronously without awaiting the callback,
    // so an outer `try { … } finally { unregister(...) }` fired its
    // `finally` *immediately* after streamSSE returned and tore down
    // the live slot while the SSE callback was still running. The
    // fix in `messages.ts` introduces an `ownershipTransferred` flag
    // that hands the unregister to the inner SSE callback's own
    // `finally`. This test pins the registry-side invariant the flag
    // protects — and verifies the same invariant holds even if a
    // stale handle attempts an unregister.
    const { tenant, conv } = track(TENANT_A, newConvId());
    const live = registerConversationAbort(tenant, conv);
    expect(__hasConversationAbort(tenant, conv)).toBe(true);

    // Simulate the bug-window race: a stale handle (say, from a
    // previously-overwritten registration) tries to unregister.
    // unregisterConversationAbort's tenant + ctrl identity check
    // must reject the call so the live slot stays put.
    const stale = new AbortController();
    unregisterConversationAbort(tenant, conv, stale);
    expect(__hasConversationAbort(tenant, conv)).toBe(true);

    // The live controller is still cancellable — the failure mode
    // C-1 prevents would surface as `cancelConversationAbort` returning
    // `false` here.
    expect(cancelConversationAbort(tenant, conv)).toBe(true);
    expect(live.signal.aborted).toBe(true);
  });

  test("ownership transfer: the SSE pattern keeps the slot live through the callback", async () => {
    // Models the messages-route flow:
    //   1. register sync,
    //   2. fire-and-forget callback (this test simulates it),
    //   3. caller would otherwise unregister immediately after
    //      streamSSE returns — the `ownershipTransferred` flag
    //      prevents that.
    // The invariant pinned here: while the simulated callback is
    // still running, __hasConversationAbort returns true and the
    // controller is reachable for cancellation.
    const { tenant, conv } = track(TENANT_A, newConvId());
    const ctrl = registerConversationAbort(tenant, conv);

    let callbackEntered = false;
    let registryWasLiveAtCallbackStart = false;
    const callbackDone = new Promise<void>((resolve) => {
      // Mimic streamSSE's fire-and-forget shape — the simulated
      // route handler returns *before* this resolves.
      queueMicrotask(() => {
        callbackEntered = true;
        registryWasLiveAtCallbackStart = __hasConversationAbort(tenant, conv);
        unregisterConversationAbort(tenant, conv, ctrl);
        resolve();
      });
    });

    // The route handler returns here without awaiting `callbackDone`.
    // With the C-1 fix, ownership has transferred to the callback —
    // so the route's outer cleanup does not unregister.
    // (Simulated by NOT calling unregisterConversationAbort here.)

    // Cancel arrives in the window between handler return and
    // callback completion: must still find the controller.
    expect(cancelConversationAbort(tenant, conv)).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);

    await callbackDone;
    expect(callbackEntered).toBe(true);
    expect(registryWasLiveAtCallbackStart).toBe(true);
    expect(__hasConversationAbort(tenant, conv)).toBe(false);
  });
});
