import { describe, expect, test } from "bun:test";
import { type Toast, toastReducer } from "../shell/ToastQueue.tsx";

const baseToast = (overrides: Partial<Toast> = {}): Toast => ({
  id: overrides.id ?? "t1",
  level: overrides.level ?? "info",
  title: overrides.title ?? "hello",
  ttlMs: overrides.ttlMs ?? 1000,
  pushedAt: overrides.pushedAt ?? 1000,
  ...overrides,
});

describe("toastReducer", () => {
  test("push appends a toast", () => {
    const next = toastReducer({ items: [] }, { type: "push", toast: baseToast() });
    expect(next.items.length).toBe(1);
    expect(next.items[0]?.title).toBe("hello");
  });

  test("push with existing id replaces in place (dedupe)", () => {
    const after1 = toastReducer({ items: [] }, { type: "push", toast: baseToast({ title: "v1" }) });
    const after2 = toastReducer(after1, { type: "push", toast: baseToast({ title: "v2" }) });
    expect(after2.items.length).toBe(1);
    expect(after2.items[0]?.title).toBe("v2");
  });

  test("dismiss removes by id", () => {
    const after1 = toastReducer(
      { items: [] },
      { type: "push", toast: baseToast({ id: "a", title: "alpha" }) },
    );
    const after2 = toastReducer(after1, {
      type: "push",
      toast: baseToast({ id: "b", title: "beta" }),
    });
    const after3 = toastReducer(after2, { type: "dismiss", id: "a" });
    expect(after3.items.length).toBe(1);
    expect(after3.items[0]?.title).toBe("beta");
  });

  test("clear empties the queue", () => {
    const after1 = toastReducer({ items: [] }, { type: "push", toast: baseToast() });
    const after2 = toastReducer(after1, { type: "clear" });
    expect(after2.items).toEqual([]);
  });

  test("tick prunes toasts whose ttl has elapsed", () => {
    const state = toastReducer(
      { items: [] },
      { type: "push", toast: baseToast({ ttlMs: 1000, pushedAt: 1000 }) },
    );
    const live = toastReducer(state, { type: "tick", now: 1500 });
    expect(live.items.length).toBe(1);
    const expired = toastReducer(state, { type: "tick", now: 2500 });
    expect(expired.items.length).toBe(0);
  });

  test("tick keeps sticky toasts (ttlMs = 0)", () => {
    const state = toastReducer(
      { items: [] },
      { type: "push", toast: baseToast({ ttlMs: 0, pushedAt: 1000 }) },
    );
    const after = toastReducer(state, { type: "tick", now: 1_000_000 });
    expect(after.items.length).toBe(1);
  });

  test("tick returns the same state ref when nothing expired (cheap re-render)", () => {
    const state = toastReducer(
      { items: [] },
      { type: "push", toast: baseToast({ ttlMs: 5000, pushedAt: 1000 }) },
    );
    const tick = toastReducer(state, { type: "tick", now: 1500 });
    expect(tick).toBe(state);
  });
});
