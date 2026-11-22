import { describe, expect, test } from "bun:test";
import { FEEDBACK_DRAFT_KEY } from "@/features/feedback/model/feedback";
import { feedbackBridgeOf, within } from "./desktop-bridge";
import { createFeedbackStore } from "./store";

function environment(
  bridge: {
    captureWindow(): Promise<string | null>;
    diagnosticsConsent?(): Promise<boolean | null>;
  } | null = null,
) {
  const values = new Map<string, string>();
  let next = 0;
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  } as unknown as Storage;
  return {
    values,
    env: {
      storage: () => storage,
      bridge: () =>
        bridge
          ? {
              screenshot: { masksSecretFields: false, masksVisibleText: false },
              diagnostics: async () => null,
              onFeedbackRequested: () => () => {},
              diagnosticsConsent: async () => null,
              ...bridge,
            }
          : null,
      id: () => `id-${++next}`,
    },
  };
}

describe("feedback store", () => {
  test("on the desktop a fresh report follows the diagnostics consent, a started one keeps its choice", async () => {
    const off = createFeedbackStore(
      environment({ captureWindow: async () => null, diagnosticsConsent: async () => false }).env,
    );
    await off.open();
    expect(off.get().draft.diagnostics).toBe(false);
    const on = createFeedbackStore(
      environment({ captureWindow: async () => null, diagnosticsConsent: async () => true }).env,
    );
    on.update({ text: "Broken", diagnostics: false });
    on.close();
    await on.open();
    expect(on.get().draft.diagnostics).toBe(false);
    const web = createFeedbackStore(environment().env);
    await web.open();
    expect(web.get().draft.diagnostics).toBe(true);
  });

  test("opens without a screenshot in a plain browser", async () => {
    const store = createFeedbackStore(environment().env);
    await store.open();
    expect(store.get().open).toBe(true);
    expect(store.get().draft.screenshot).toBeNull();
  });

  test("takes the window picture before the dialog opens", async () => {
    const seen: boolean[] = [];
    const { env } = environment({
      captureWindow: async () => {
        seen.push(store.get().open);
        return "AAAA";
      },
    });
    const store = createFeedbackStore(env);
    await store.open();
    expect(seen).toEqual([false]);
    expect(store.get().draft.screenshot).toBe("AAAA");
  });

  test("offers no screenshot when the shell answers nothing or fails", async () => {
    const empty = createFeedbackStore(environment({ captureWindow: async () => null }).env);
    await empty.open();
    expect(empty.get().draft.screenshot).toBeNull();
    const failing = createFeedbackStore(
      environment({ captureWindow: () => Promise.reject(new Error("no")) }).env,
    );
    await failing.open();
    expect(failing.get().open).toBe(true);
    expect(failing.get().draft.screenshot).toBeNull();
  });

  test("the window picture is offered unticked and a new picture is never ticked for you", async () => {
    let calls = 0;
    const { env } = environment({
      captureWindow: async () => `AAA${calls++}`,
    });
    const store = createFeedbackStore(env);
    await store.open();
    expect(store.get().draft).toMatchObject({ screenshot: "AAA0", screenshotIncluded: false });
    store.update({ screenshotIncluded: true });
    await store.open();
    expect(calls).toBe(1);
    expect(store.get().draft.screenshotIncluded).toBe(true);
    store.close();
    await store.open();
    expect(calls).toBe(2);
    expect(store.get().draft).toMatchObject({ screenshot: "AAA1", screenshotIncluded: false });
  });

  test("opens when the desktop shell asks and tells what the shell can hide", async () => {
    const listeners: (() => void)[] = [];
    const { env } = environment({ captureWindow: async () => null });
    const withShell = {
      ...env,
      bridge: () =>
        feedbackBridgeOf({
          protocolVersion: 3,
          capabilities: { screenshot: { masksSecretFields: true, masksVisibleText: false } },
          diagnostics: async () => null,
          captureWindow: async () => null,
          onFeedbackRequested: (listener: () => void) => {
            listeners.push(listener);
            return () => void listeners.splice(listeners.indexOf(listener), 1);
          },
        }),
    };
    const store = createFeedbackStore(withShell);
    expect(store.screenshotCapability()).toEqual({
      masksSecretFields: true,
      masksVisibleText: false,
    });
    let asked = 0;
    const stop = store.onRequested(() => asked++);
    listeners[0]?.();
    expect(asked).toBe(1);
    stop();
    expect(listeners).toHaveLength(0);
    expect(createFeedbackStore(environment().env).screenshotCapability()).toBeNull();
  });

  test("keeps the draft when the dialog closes and across a reload", async () => {
    const { env, values } = environment();
    const store = createFeedbackStore(env);
    await store.open();
    store.update({ kind: "idea", text: "More colors" });
    store.update({ files: [{ id: "1", name: "a.txt", size: 1, content_base64: "QQ==" }] });
    store.close();
    expect(store.get().open).toBe(false);
    expect(store.get().draft.files).toHaveLength(1);
    expect(values.has(FEEDBACK_DRAFT_KEY)).toBe(true);
    const reloaded = createFeedbackStore(env);
    expect(reloaded.get().draft.text).toBe("More colors");
    expect(reloaded.get().draft.kind).toBe("idea");
  });

  test("a failed send keeps the draft and the request id until the draft changes", async () => {
    const store = createFeedbackStore(environment().env);
    store.update({ text: "Save does nothing" });
    const requestId = store.get().requestId;
    store.sending();
    store.close();
    expect(store.get().open).toBe(false);
    store.failed("generic");
    expect(store.get()).toMatchObject({ status: "failed", failure: "generic", requestId });
    expect(store.get().draft.text).toBe("Save does nothing");
    store.update({ text: "Save does nothing at all" });
    expect(store.get().status).toBe("idle");
    expect(store.get().requestId).not.toBe(requestId);
  });

  test("stays open while sending", async () => {
    const store = createFeedbackStore(environment().env);
    await store.open();
    store.sending();
    store.close();
    expect(store.get().open).toBe(true);
  });

  test("discarding clears the draft, the storage and closes", async () => {
    const { env, values } = environment();
    const store = createFeedbackStore(env);
    await store.open();
    store.update({ text: "x" });
    store.discard();
    expect(store.get().open).toBe(false);
    expect(store.get().draft.text).toBe("");
    expect(values.has(FEEDBACK_DRAFT_KEY)).toBe(false);
  });

  test("sending diagnostics on purpose turns them on even when the desktop default is off", async () => {
    const store = createFeedbackStore(
      environment({ captureWindow: async () => null, diagnosticsConsent: async () => false }).env,
    );
    await store.open({ kind: "bug", diagnostics: true });
    expect(store.get().draft.kind).toBe("bug");
    expect(store.get().draft.diagnostics).toBe(true);
  });

  test("a prefill sets kind and text and is added to an existing draft", async () => {
    const store = createFeedbackStore(environment().env);
    await store.open({ kind: "bug", text: "Fehler: X" });
    expect(store.get().draft.text).toBe("Fehler: X");
    store.update({ text: "My note" });
    await store.open({ text: "Fehler: Y" });
    expect(store.get().draft.text).toBe("My note\n\nFehler: Y");
  });

  test("notifies subscribers and records client errors", () => {
    const store = createFeedbackStore(environment().env);
    let calls = 0;
    const stop = store.subscribe(() => calls++);
    store.update({ text: "x" });
    stop();
    store.update({ text: "y" });
    expect(calls).toBe(1);
    store.recordError({ status: 500, code: "internal_error" }, new Date("2026-11-20T10:00:00Z"));
    expect(store.errors()).toEqual([
      { code: "internal_error (500)", at: "2026-11-20T10:00:00.000Z" },
    ]);
  });
});

describe("desktop bridge", () => {
  test("is absent in a browser and for an older shell", () => {
    expect(feedbackBridgeOf(undefined)).toBeNull();
    expect(feedbackBridgeOf({ protocolVersion: 1, platform: "darwin" })).toBeNull();
    expect(feedbackBridgeOf({ protocolVersion: 2, diagnostics() {} })).toBeNull();
  });

  test("hands out diagnostics and only a well-formed picture", async () => {
    const bridge = feedbackBridgeOf({
      protocolVersion: 2,
      diagnostics: async () => ({ app: { version: "0.1.0" } }),
      captureWindow: async () => "AAAA",
    });
    expect(await bridge?.diagnostics()).toEqual({ app: { version: "0.1.0" } });
    expect(await bridge?.captureWindow()).toBe("AAAA");
    const broken = feedbackBridgeOf({
      protocolVersion: 3,
      diagnostics: async () => null,
      captureWindow: async () => "data:image/png;base64,AAAA",
    });
    expect(await broken?.captureWindow()).toBeNull();
    expect(broken?.screenshot).toEqual({ masksSecretFields: false, masksVisibleText: false });
    expect(broken?.onFeedbackRequested(() => {})()).toBeUndefined();
  });

  test("gives up on a slow or failing answer", async () => {
    expect(await within(new Promise<string>(() => {}), 5, "fallback")).toBe("fallback");
    expect(await within(Promise.reject(new Error("no")), 50, "fallback")).toBe("fallback");
    expect(await within(Promise.resolve("value"), 50, "fallback")).toBe("value");
  });
});
