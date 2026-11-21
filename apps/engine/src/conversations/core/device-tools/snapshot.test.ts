import { describe, expect, test } from "bun:test";
import {
  browserRefKey,
  computerRefSnapshot,
  parseBrowserSnapshot,
  parseWindowSnapshot,
  refFreshness,
} from "./snapshot.ts";

const PAGE = [
  '- heading "Kontakt" [level=1, ref=e1]',
  '- textbox "E-Mail" [ref=e2]',
  '- button "Senden \\"jetzt\\"" [ref=e3]',
  "- link [ref=e4]",
  "  - /url: /home",
  '- text "no ref here"',
  "- /url: /orphan",
].join("\n");

describe("browser snapshot", () => {
  test("reads refs from the snapshot text and the page origin from the step", () => {
    const page = parseBrowserSnapshot({
      snapshot: { snapshot: PAGE },
      step: { origin: "https://mail.example" },
    });
    expect(page.origin).toBe("https://mail.example");
    expect(page.text).toBe(PAGE);
    expect(page.refs).toEqual({
      e1: { role: "heading", name: "Kontakt", href: null },
      e2: { role: "textbox", name: "E-Mail", href: null },
      e3: { role: "button", name: 'Senden \\"jetzt\\"', href: null },
      e4: { role: "link", name: null, href: "/home" },
    });
  });

  test("a link's url belongs to the line above it only when indented below it", () => {
    const refs = (text: string) => parseBrowserSnapshot({ snapshot: text }).refs;
    expect(refs('- link "A" [ref=e1]\n- /url: /a').e1?.href).toBeNull();
    expect(refs('  - link "A" [ref=e1]\n   - /url:   /a  ').e1?.href).toBe("/a");
    expect(refs('- link "A" [ref=e1]\n  - /url: /a\n  - /url: /b').e1?.href).toBe("/b");
    expect(refs("  - /url: /a")).toEqual({});
    expect(refs('- link "A" [ref=e1]\n  -/url:/a').e1?.href).toBe("/a");
    expect(refs('- link "A" [ref=e1]\n  - /url: ').e1?.href).toBeNull();
    expect(refs('- link "A" [ref=e1]\n  x - /url: /a').e1?.href).toBeNull();
    expect(refs('- link "A" [ref=e1]\n  - /url: /a b').e1?.href).toBeNull();
  });

  test("the refs map of the snapshot wins over the text and fills gaps", () => {
    const page = parseBrowserSnapshot({
      snapshot: {
        snapshot: PAGE,
        refs: {
          e2: { role: "searchbox" },
          "@e4": { name: "Home" },
          e9: { role: "", name: 3 },
          e8: "junk",
          e7: { role: "link", url: "/u" },
          e6: { role: "link", href: "/h", url: "/u" },
        },
      },
    });
    expect(page.refs.e2).toEqual({ role: "searchbox", name: "E-Mail", href: null });
    expect(page.refs.e4).toEqual({ role: "link", name: "Home", href: "/home" });
    expect(page.refs.e9).toEqual({ role: null, name: null, href: null });
    expect(page.refs.e8).toEqual({ role: null, name: null, href: null });
    expect(page.refs.e7?.href).toBe("/u");
    expect(page.refs.e6?.href).toBe("/h");
    expect(page.origin).toBeNull();
  });

  test("a plain string snapshot and broken outputs stay empty and safe", () => {
    expect(parseBrowserSnapshot({ snapshot: '- button "Buy" [ref=e1]' }).refs).toEqual({
      e1: { role: "button", name: "Buy", href: null },
    });
    expect(parseBrowserSnapshot(null)).toEqual({ origin: null, text: "", refs: {} });
    expect(parseBrowserSnapshot([1])).toEqual({ origin: null, text: "", refs: {} });
    expect(parseBrowserSnapshot({ snapshot: { snapshot: 5 }, step: [] }).text).toBe("");
    expect(parseBrowserSnapshot({ snapshot: '  -  button "x" [ref=e7]' }).refs.e7?.role).toBe(
      "button",
    );
    expect(parseBrowserSnapshot({ snapshot: 'x - button "x" [ref=e7]' }).refs).toEqual({});
    expect(parseBrowserSnapshot({ snapshot: '- button "" [ref=e7]' }).refs.e7?.name).toBeNull();
    expect(parseBrowserSnapshot({ snapshot: '- button "x" [ref=e7' }).refs).toEqual({});
    expect(parseBrowserSnapshot({ snapshot: '- button "x" [aref=e7]' }).refs).toEqual({});
    expect(parseBrowserSnapshot({ snapshot: '- button "x" [x, ref=e7, y]' }).refs.e7?.name).toBe(
      "x",
    );
    expect(
      parseBrowserSnapshot({ snapshot: '- button   "Two spaces" [ref=e12]' }).refs.e12,
    ).toEqual({
      role: "button",
      name: "Two spaces",
      href: null,
    });
  });

  test("ref keys drop a leading @", () => {
    expect(browserRefKey("@e12")).toBe("e12");
    expect(browserRefKey("e12")).toBe("e12");
  });
});

describe("window snapshot", () => {
  const output = {
    snapshot_id: "1a",
    window: { id: "w7", title: "Budget" },
    app: "Numbers",
    state_hash: "f".repeat(64),
    tree: {
      role: "window",
      name: "Budget",
      children: [
        { role: "button", name: "Sichern", ref: "@s1a:e1" },
        { role: "cell", ref: "@s1a:e2", children: [{ role: "text", name: "B2", ref: "@s1a:e3" }] },
        { role: "group", children: "nope" },
      ],
    },
  };

  test("collects refs with role and name from the tree", () => {
    const window = parseWindowSnapshot(output);
    expect(window).toEqual({
      snapshot_id: "1a",
      window_id: "w7",
      state_hash: "f".repeat(64),
      app: "Numbers",
      tree: output.tree,
      refs: {
        "@s1a:e1": { role: "button", name: "Sichern" },
        "@s1a:e2": { role: "cell", name: null },
        "@s1a:e3": { role: "text", name: "B2" },
      },
    });
  });

  test("needs a snapshot id and a window", () => {
    expect(parseWindowSnapshot({ ...output, snapshot_id: "" })).toBeNull();
    expect(parseWindowSnapshot({ ...output, window: {} })).toBeNull();
    expect(parseWindowSnapshot(null)).toBeNull();
    expect(parseWindowSnapshot({ snapshot_id: "1", window: { id: "w" } })).toEqual({
      snapshot_id: "1",
      window_id: "w",
      state_hash: null,
      app: null,
      tree: null,
      refs: {},
    });
  });

  test("a very deep tree stops collecting", () => {
    let node: Record<string, unknown> = { role: "leaf", ref: "@s1:e999" };
    for (let i = 0; i < 205; i++) node = { role: "group", children: [node] };
    const top = { role: "top", ref: "@s1:e1", children: [node] };
    const window = parseWindowSnapshot({ snapshot_id: "1", window: { id: "w" }, tree: top });
    expect(window?.refs["@s1:e1"]).toBeDefined();
    expect(window?.refs["@s1:e999"]).toBeUndefined();
    let shallow: Record<string, unknown> = { role: "leaf", ref: "@s1:e5" };
    for (let i = 0; i < 200; i++) shallow = { role: "group", children: [shallow] };
    expect(
      parseWindowSnapshot({ snapshot_id: "1", window: { id: "w" }, tree: shallow })?.refs["@s1:e5"],
    ).toBeDefined();
  });

  test("a computer ref names its snapshot", () => {
    expect(computerRefSnapshot("@s1a:e3")).toBe("1a");
    expect(computerRefSnapshot("@s1a:e34")).toBe("1a");
    expect(computerRefSnapshot("@s1a:e3x")).toBeNull();
    expect(computerRefSnapshot("x@s1a:e3")).toBeNull();
    expect(computerRefSnapshot("e3")).toBeNull();
  });
});

describe("a ref action needs the snapshot taken right before it", () => {
  test.each([
    [null, "browser_snapshot", "s1", { fresh: false, reason: "no_snapshot" }],
    [
      { tool: "browser_press", snapshot_id: null },
      "browser_snapshot",
      "s1",
      { fresh: false, reason: "snapshot_used" },
    ],
    [
      { tool: "browser_snapshot", snapshot_id: "s2" },
      "browser_snapshot",
      "s1",
      { fresh: false, reason: "other_snapshot" },
    ],
    [
      { tool: "browser_snapshot", snapshot_id: "s1" },
      "browser_snapshot",
      null,
      { fresh: false, reason: "other_snapshot" },
    ],
    [
      { tool: "browser_snapshot", snapshot_id: "s1" },
      "browser_snapshot",
      "s1",
      { fresh: true, snapshot: { tool: "browser_snapshot", snapshot_id: "s1" } },
    ],
    [
      { tool: "computer_snapshot", snapshot_id: "1a" },
      "computer_snapshot",
      "1a",
      { fresh: true, snapshot: { tool: "computer_snapshot", snapshot_id: "1a" } },
    ],
  ] as const)("%j %s %s", (latest, tool, requested, expected) => {
    expect(refFreshness(latest, tool, requested)).toEqual(expected);
  });
});
