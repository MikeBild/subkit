import { describe, expect, test } from "bun:test";
import { deviceToolSpec } from "./catalog.ts";
import { type DeviceStepRecord, filledBy, resolveRef, sameElement, stepRecord } from "./history.ts";

function spec(name: string) {
  const found = deviceToolSpec(name);
  if (!found) throw new Error(name);
  return found;
}

const record = (over: Partial<DeviceStepRecord> = {}): DeviceStepRecord => ({
  tool: "browser_snapshot",
  device_id: "d",
  origin: "https://mail.example.com",
  snapshot_id: "s1",
  window_id: null,
  state_hash: null,
  app: null,
  refs: { e2: { role: "textbox", name: "An" } },
  filled: [],
  ...over,
});

const window = record({
  tool: "computer_snapshot",
  origin: null,
  snapshot_id: "1a",
  window_id: "w1",
  state_hash: "h1",
  app: "Mail",
  refs: { "@s1a:e3": { role: "button", name: "Send" } },
});

describe("refs resolve against the snapshot taken right before", () => {
  test("browser refs", () => {
    expect(resolveRef(spec("browser_fill"), { ref: "@e2", snapshot_id: "s1" }, [record()])).toEqual(
      {
        element: { role: "textbox", name: "An" },
        page_origin: "https://mail.example.com",
        app: null,
        window_id: null,
        state_hash: null,
        ref: "e2",
      },
    );
    expect(
      resolveRef(spec("browser_fill"), { ref: "e9", snapshot_id: "s1" }, [record()]),
    ).toMatchObject({
      error_code: "unknown_ref",
    });
    expect(resolveRef(spec("browser_fill"), { snapshot_id: "s1" }, [record()])).toMatchObject({
      error_code: "unknown_ref",
    });
    expect(
      resolveRef(spec("browser_fill"), { ref: "e2", snapshot_id: "s1" }, [record({ refs: null })]),
    ).toMatchObject({
      error_code: "unknown_ref",
    });
    expect(
      resolveRef(spec("browser_fill"), { ref: "e2", snapshot_id: "s0" }, [record()]),
    ).toMatchObject({
      error_code: "other_snapshot",
    });
    expect(
      resolveRef(spec("browser_press"), { action: "click", ref: "e2", snapshot_id: "s1" }, [
        record({ tool: "browser_fill" }),
        record(),
      ]),
    ).toMatchObject({ error_code: "snapshot_used" });
    expect(
      resolveRef(spec("browser_press"), { action: "click", ref: "e2", snapshot_id: "s1" }, []),
    ).toMatchObject({
      error_code: "no_snapshot",
    });
    expect(
      resolveRef(spec("browser_extract"), { ref: "e2", snapshot_id: "s1" }, [record()]),
    ).toMatchObject({
      ref: "e2",
    });
  });

  test("browser actions without a ref only take the page origin", () => {
    const steps = [record({ tool: "browser_open", origin: "https://a.example.com" })];
    for (const [name, input] of [
      ["browser_press", { action: "key", key: "Tab" }],
      ["browser_press", { action: "scroll", direction: "down" }],
      ["browser_extract", {}],
      ["browser_open", { url: "https://b.example.com" }],
    ] as const) {
      expect(resolveRef(spec(name), input, steps)).toEqual({
        element: null,
        page_origin: "https://a.example.com",
        app: null,
        window_id: null,
        state_hash: null,
        ref: null,
      });
    }
    expect(resolveRef(spec("browser_open"), {}, [])).toMatchObject({ page_origin: null });
    expect(resolveRef(spec("browser_wait"), { for: "load", ref: "e2" }, steps)).toMatchObject({
      element: null,
      ref: null,
    });
  });

  test("computer refs carry the window and its state", () => {
    expect(resolveRef(spec("computer_press"), { ref: "@s1a:e3" }, [window])).toEqual({
      element: { role: "button", name: "Send" },
      page_origin: null,
      app: "Mail",
      window_id: "w1",
      state_hash: "h1",
      ref: "@s1a:e3",
    });
    expect(
      resolveRef(spec("computer_press"), { ref: "@s1a:e3" }, [
        record({ ...window, state_hash: null }),
      ]),
    ).toMatchObject({
      state_hash: null,
    });
    expect(resolveRef(spec("computer_press"), { ref: "@s1a:e9" }, [window])).toMatchObject({
      error_code: "unknown_ref",
    });
    expect(resolveRef(spec("computer_press"), { ref: "@s2b:e3" }, [window])).toMatchObject({
      error_code: "other_snapshot",
    });
    expect(resolveRef(spec("computer_press"), {}, [window])).toMatchObject({
      error_code: "other_snapshot",
    });
    expect(
      resolveRef(spec("computer_press"), { ref: "@s1a:e3" }, [{ ...window, refs: null }]),
    ).toMatchObject({
      error_code: "unknown_ref",
    });
    expect(
      resolveRef(spec("computer_press"), { ref: "@s1a:e3" }, [
        record({ ...window, tool: "computer_press" }),
      ]),
    ).toMatchObject({ error_code: "snapshot_used" });
  });

  test("a key goes to the window of the latest snapshot", () => {
    expect(resolveRef(spec("computer_key"), { window_id: "w1", keys: "cmd+s" }, [window])).toEqual({
      element: null,
      page_origin: null,
      app: "Mail",
      window_id: "w1",
      state_hash: "h1",
      ref: null,
    });
    expect(
      resolveRef(spec("computer_key"), { window_id: "w1" }, [{ ...window, state_hash: null }]),
    ).toMatchObject({
      state_hash: null,
    });
    expect(resolveRef(spec("computer_key"), { window_id: "w2" }, [window])).toMatchObject({
      error_code: "other_snapshot",
    });
    expect(resolveRef(spec("computer_key"), { window_id: "w1" }, [])).toMatchObject({
      error_code: "no_snapshot",
    });
    expect(
      resolveRef(spec("computer_key"), { window_id: "w1" }, [{ ...window, tool: "computer_type" }]),
    ).toMatchObject({
      error_code: "snapshot_used",
    });
  });

  test("computer and file reads need no snapshot", () => {
    expect(resolveRef(spec("computer_apps"), {}, [window])).toMatchObject({
      element: null,
      app: "Mail",
      window_id: "w1",
    });
    expect(resolveRef(spec("files_list"), { path: "/a/b" }, [])).toMatchObject({ element: null });
  });
});

describe("values the job filled in", () => {
  test("only filling tools fill, named after the field", () => {
    const field = { role: "textbox", name: "An" };
    expect(filledBy(spec("browser_fill"), { text: "a@b.de" }, field)).toEqual([
      { field: "An", value: "a@b.de" },
    ]);
    expect(filledBy(spec("browser_fill"), { values: ["1", 2, ""] }, null)).toEqual([
      { field: null, value: "1" },
      { field: null, value: "2" },
    ]);
    expect(filledBy(spec("browser_fill"), { text: "" }, field)).toEqual([]);
    expect(filledBy(spec("browser_fill"), {}, field)).toEqual([]);
    expect(filledBy(spec("computer_set_value"), { value: "7" }, field)).toEqual([
      { field: "An", value: "7" },
    ]);
    expect(filledBy(spec("computer_select"), { option: "B" }, field)).toEqual([
      { field: "An", value: "B" },
    ]);
    expect(filledBy(spec("computer_type"), { text: "hi" }, field)).toEqual([
      { field: "An", value: "hi" },
    ]);
    expect(filledBy(spec("browser_press"), { text: "x" }, field)).toEqual([]);
  });
});

describe("what a dispatched step leaves behind", () => {
  const base = { device_id: "d", filled: [{ field: "An", value: "a@b.de" }] };

  test("an action keeps its origin and fills", () => {
    expect(
      stepRecord(
        { ...base, tool: "browser_fill" },
        { step: { origin: "https://a.example.com" } },
        "c",
      ),
    ).toEqual({
      tool: "browser_fill",
      device_id: "d",
      origin: "https://a.example.com",
      snapshot_id: null,
      window_id: null,
      state_hash: null,
      app: null,
      refs: null,
      filled: base.filled,
    });
    expect(stepRecord({ ...base, tool: "browser_fill" }, null, "c").origin).toBeNull();
    expect(stepRecord({ ...base, tool: "browser_fill" }, { step: "x" }, "c").origin).toBeNull();
    expect(stepRecord({ ...base, tool: "browser_fill" }, { step: null }, "c").origin).toBeNull();
    expect(stepRecord({ ...base, tool: "browser_fill" }, "x", "c").origin).toBeNull();
  });

  test("a browser snapshot is named by its call", () => {
    expect(
      stepRecord(
        { ...base, tool: "browser_snapshot" },
        {
          snapshot: { snapshot: '- button "Senden" [ref=e3]' },
          step: { origin: "https://a.example.com" },
        },
        "call-7",
      ),
    ).toMatchObject({
      snapshot_id: "call-7",
      origin: "https://a.example.com",
      refs: { e3: { role: "button", name: "Senden" } },
    });
  });

  test("a window snapshot keeps its id, window, state and app", () => {
    expect(
      stepRecord(
        { ...base, tool: "computer_snapshot" },
        {
          snapshot_id: "1a",
          window: { id: "w1" },
          state_hash: "h",
          app: "Mail",
          tree: { role: "button", name: "Send", ref: "@s1a:e3" },
        },
        "c",
      ),
    ).toMatchObject({
      snapshot_id: "1a",
      window_id: "w1",
      state_hash: "h",
      app: "Mail",
      refs: { "@s1a:e3": { role: "button", name: "Send" } },
    });
    expect(
      stepRecord(
        { ...base, tool: "computer_press" },
        { snapshot_id: "1a", window: { id: "w1" }, delivery: "delivered" },
        "c",
      ),
    ).toMatchObject({ snapshot_id: null, window_id: null });
    expect(stepRecord({ ...base, tool: "computer_snapshot" }, {}, "c")).toMatchObject({
      snapshot_id: null,
      refs: null,
    });
  });

  test("the same element means the same role and name", () => {
    expect(
      sameElement({ role: "button", name: "Kaufen" }, { role: "button", name: "Kaufen" }),
    ).toBe(true);
    expect(sameElement({ role: "button", name: "Kaufen" }, { role: "link", name: "Kaufen" })).toBe(
      false,
    );
    expect(sameElement({ role: "button", name: "Kaufen" }, { role: "button", name: "Abo" })).toBe(
      false,
    );
    expect(sameElement(null, { role: "button", name: "Kaufen" })).toBe(false);
    expect(sameElement({ role: "button", name: "Kaufen" }, undefined)).toBe(false);
  });
});
