// Pin the cancel-race contract from #146 / A4: registration + cancel
// must always meet via the same registry so a cancel arriving before
// the first dispatch (the pre-A4 race window) actually aborts the
// turn instead of silently no-op'ing.
//
// The integration cover (tests/e2e/authoring-regressions.e2e.test.ts
// "cancelling a slow preview…") exercises the full HTTP path; this
// suite pins the bare contract so a future refactor can't quietly
// reopen the race without flagging a unit-test failure.

import { afterEach, describe, expect, test } from "bun:test";
import {
  CONVERSATION_CANCELLED_REASON,
  cancelConversationAbort,
  registerConversationAbort,
  unregisterConversationAbort,
} from "./abort.ts";

describe("conversation abort registry", () => {
  // Each test owns a unique conversation id so the process-local
  // registry does not leak state between cases.
  let nextId = 0;
  const newId = (): string => `c-${++nextId}-${Math.random().toString(36).slice(2, 8)}`; // allow-random: per-test isolation, no determinism contract

  afterEach(() => {
    // Defensive: drop any controllers a test forgot to unregister.
    for (let i = 1; i <= nextId; i++) unregisterConversationAbort(`c-${i}`);
  });

  test("registerConversationAbort returns a fresh, un-aborted controller", () => {
    const id = newId();
    const ctrl = registerConversationAbort(id);
    expect(ctrl.signal.aborted).toBe(false);
    unregisterConversationAbort(id, ctrl);
  });

  test("cancelConversationAbort returns true and aborts the registered controller", () => {
    const id = newId();
    const ctrl = registerConversationAbort(id);
    expect(cancelConversationAbort(id)).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
    expect(ctrl.signal.reason).toBe(CONVERSATION_CANCELLED_REASON);
    unregisterConversationAbort(id, ctrl);
  });

  test("cancel-before-first-dispatch: a cancel issued the same tick as register still aborts the loop's signal", () => {
    // Pre-A4 the loop body called registerConversationAbort *itself* —
    // a cancel arriving in the few-ms window between request-accept
    // and that call hit an empty registry and silently returned false.
    // Post-A4 the route handler registers synchronously, so the loop
    // consumes whatever the handler registered and a same-tick cancel
    // is observable as `signal.aborted` once the loop reaches its
    // first abort-checkable hop.
    const id = newId();
    const ctrl = registerConversationAbort(id);
    const ok = cancelConversationAbort(id);
    expect(ok).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
    unregisterConversationAbort(id, ctrl);
  });

  test("cancelConversationAbort returns false when no controller is registered (regression sentinel)", () => {
    // With A4 in place this should be unreachable for HTTP-driven
    // turns. The branch exists so a future regression that re-opens
    // the race surfaces a `cancel.no_controller` warning in logs
    // rather than failing silently.
    const id = newId();
    expect(cancelConversationAbort(id)).toBe(false);
  });

  test("unregister is scoped to the controller that owns it (no cross-cancel)", () => {
    const id = newId();
    const ctrl1 = registerConversationAbort(id);
    const ctrl2 = registerConversationAbort(id); // overwrites ctrl1 in registry
    // Trying to unregister with the stale handle is a no-op.
    unregisterConversationAbort(id, ctrl1);
    expect(cancelConversationAbort(id)).toBe(true);
    expect(ctrl2.signal.aborted).toBe(true);
    expect(ctrl1.signal.aborted).toBe(false);
    unregisterConversationAbort(id, ctrl2);
  });
});
