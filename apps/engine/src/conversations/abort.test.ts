import { afterEach, describe, expect, test } from "bun:test";
import {
  __hasConversationAbort,
  CONVERSATION_CANCELLED_REASON,
  cancelConversationAbort,
  registerConversationAbort,
  unregisterConversationAbort,
} from "./abort.ts";

describe("conversation abort registry", () => {
  let nextId = 0;
  const newConvId = (): string => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
  const TENANT_A = "00000000-0000-4000-8000-aaaaaaaaaaaa";
  const TENANT_B = "00000000-0000-4000-8000-bbbbbbbbbbbb";

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
    const { tenant, conv } = track(TENANT_A, newConvId());
    const ctrl = registerConversationAbort(tenant, conv);
    const ok = cancelConversationAbort(tenant, conv);
    expect(ok).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });

  test("cancelConversationAbort returns false when no controller is registered", () => {
    const { tenant, conv } = track(TENANT_A, newConvId());
    expect(cancelConversationAbort(tenant, conv)).toBe(false);
  });

  test("unregister is scoped to the controller that owns it (no cross-cancel)", () => {
    const { tenant, conv } = track(TENANT_A, newConvId());
    const ctrl1 = registerConversationAbort(tenant, conv);
    const ctrl2 = registerConversationAbort(tenant, conv);
    unregisterConversationAbort(tenant, conv, ctrl1);
    expect(cancelConversationAbort(tenant, conv)).toBe(true);
    expect(ctrl2.signal.aborted).toBe(true);
    expect(ctrl1.signal.aborted).toBe(false);
  });

  test("a foreign tenant cannot displace another tenant's registered controller", () => {
    const conv = newConvId();
    track(TENANT_A, conv);
    track(TENANT_B, conv);

    const ctrlB = registerConversationAbort(TENANT_B, conv);
    const ctrlA = registerConversationAbort(TENANT_A, conv);
    expect(ctrlA).not.toBe(ctrlB);

    unregisterConversationAbort(TENANT_A, conv, ctrlA);

    expect(cancelConversationAbort(TENANT_B, conv)).toBe(true);
    expect(ctrlB.signal.aborted).toBe(true);
    expect(ctrlA.signal.aborted).toBe(false);
  });

  test("a foreign tenant cancel cannot abort another tenant's controller", () => {
    const conv = newConvId();
    track(TENANT_A, conv);
    track(TENANT_B, conv);

    const ctrlA = registerConversationAbort(TENANT_A, conv);
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
    expect(ctrlB.signal.aborted).toBe(false);
    expect(cancelConversationAbort(TENANT_B, conv)).toBe(true);
    expect(ctrlB.signal.aborted).toBe(true);
  });

  test("SSE ownership-transfer: stale-handle unregister attempts must not zero the new live slot", () => {
    const { tenant, conv } = track(TENANT_A, newConvId());
    const live = registerConversationAbort(tenant, conv);
    expect(__hasConversationAbort(tenant, conv)).toBe(true);

    const stale = new AbortController();
    unregisterConversationAbort(tenant, conv, stale);
    expect(__hasConversationAbort(tenant, conv)).toBe(true);

    expect(cancelConversationAbort(tenant, conv)).toBe(true);
    expect(live.signal.aborted).toBe(true);
  });

  test("ownership transfer: the SSE pattern keeps the slot live through the callback", async () => {
    const { tenant, conv } = track(TENANT_A, newConvId());
    const ctrl = registerConversationAbort(tenant, conv);

    let callbackEntered = false;
    let registryWasLiveAtCallbackStart = false;
    const callbackDone = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        callbackEntered = true;
        registryWasLiveAtCallbackStart = __hasConversationAbort(tenant, conv);
        unregisterConversationAbort(tenant, conv, ctrl);
        resolve();
      });
    });

    expect(cancelConversationAbort(tenant, conv)).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);

    await callbackDone;
    expect(callbackEntered).toBe(true);
    expect(registryWasLiveAtCallbackStart).toBe(true);
    expect(__hasConversationAbort(tenant, conv)).toBe(false);
  });
});
