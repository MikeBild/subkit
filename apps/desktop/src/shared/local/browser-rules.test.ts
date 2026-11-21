import { describe, expect, test } from "bun:test";
import {
  type BrowserAllowances,
  pageState,
  parseFieldScan,
  sha256Hex,
  siteRulesFor,
  stateVersion,
  textOf,
} from "./browser-rules.ts";

const allowances: BrowserAllowances = {
  sites: [
    { origin: "https://shop.example.com", entered_by: "approval" },
    { origin: "https://bank.example.com", entered_by: "person" },
    { origin: "http://192.168.1.5", entered_by: "person" },
  ],
};

const site = (origin: string) => ({ origin, private: false, site_digest: "a".repeat(64) });

describe("site rules per kind of work", () => {
  test("chat and tasks use the personal model with person entries", () => {
    expect(siteRulesFor({ execution_id: null }, [site("https://x.com")], allowances)).toEqual({
      mode: "personal",
      options: {
        entered_by_person: ["https://bank.example.com", "http://192.168.1.5"],
      },
    });
    expect(siteRulesFor({ execution_id: "e1" }, undefined, allowances)).toBeNull();
  });

  test("workflows use approved sites intersected with the device allowance", () => {
    expect(
      siteRulesFor(
        { execution_id: "e1" },
        [
          site("https://shop.example.com/"),
          site("https://bank.example.com"),
          site("https://new.example.com"),
        ],
        allowances,
      ),
    ).toEqual({
      mode: "workflow",
      sites: [
        { origin: "https://shop.example.com", entered_by: "approval" },
        { origin: "https://bank.example.com", entered_by: "person" },
      ],
    });
    expect(siteRulesFor({ execution_id: "e1" }, [site("not a url")], allowances)).toEqual({
      mode: "workflow",
      sites: [],
    });
  });
});

describe("page evidence", () => {
  test("keeps the origin and a title hash, never the path or the title", () => {
    const state = pageState("https://shop.example.com/orders/4711?token=abc", "Order 4711");
    expect(state).toEqual({
      origin: "https://shop.example.com",
      title_sha256: sha256Hex("Order 4711"),
    });
    expect(stateVersion(state)).toMatch(/^page:[a-f0-9]{64}$/);
    expect(stateVersion(state)).not.toBe(
      stateVersion(pageState("https://shop.example.com/", "Other")),
    );
    expect(pageState(null, null)).toEqual({ origin: null, title_sha256: null });
    expect(pageState("chrome-error://chromewebdata/", "x").origin).toBeNull();
  });

  test("textOf reads the first string field", () => {
    expect(textOf("plain", ["url"])).toBe("plain");
    expect(textOf({ url: "https://a/" }, ["url"])).toBe("https://a/");
    expect(textOf({ value: 1, result: "r" }, ["value", "result"])).toBe("r");
    expect(textOf({ value: null, result: "r" }, ["value", "result"])).toBeNull();
    expect(textOf(null, ["url"])).toBeNull();
    expect(textOf(5, ["url"])).toBeNull();
    expect(textOf({}, ["url"])).toBeNull();
  });
});

describe("credential field scan", () => {
  const fields = [
    { type: "password", autocomplete: "", focused: false, x: 10, y: 20, width: 100, height: 30 },
    {
      type: "text",
      autocomplete: "one-time-code",
      focused: false,
      x: 0,
      y: 0,
      width: 50,
      height: 10,
    },
    { type: "text", autocomplete: "name", focused: true, x: 0, y: 0, width: 50, height: 10 },
    { type: "password", autocomplete: "", focused: false, x: 0, y: 0, width: 0, height: 10 },
  ];

  test("pads and scales credential field rects by the device pixel ratio", () => {
    expect(parseFieldScan({ result: JSON.stringify({ dpr: 2, fields }) })).toEqual({
      ok: true,
      secure_focus: false,
      rects: [
        { x: 16, y: 36, width: 208, height: 68 },
        { x: -4, y: -4, width: 108, height: 28 },
      ],
    });
  });

  test("reports a focused credential field and accepts several result shapes", () => {
    const focused = [{ ...fields[0], focused: true }];
    expect(parseFieldScan({ dpr: 1, fields: focused })).toMatchObject({
      ok: true,
      secure_focus: true,
    });
    expect(parseFieldScan(JSON.stringify({ dpr: 1, fields: [] }))).toEqual({
      ok: true,
      secure_focus: false,
      rects: [],
    });
    expect(parseFieldScan({ value: { dpr: 1, fields: [] } })).toMatchObject({ ok: true });
  });

  test("focus inside a frame that cannot be read counts as a focused secret", () => {
    expect(parseFieldScan({ dpr: 1, focus_unknown: true, fields: [] })).toEqual({
      ok: true,
      secure_focus: true,
      rects: [],
    });
  });

  test("anything unreadable is not ok", () => {
    for (const data of [null, "nope", { result: "{" }, { dpr: 0, fields: [] }, { dpr: 1 }, 7])
      expect(parseFieldScan(data)).toEqual({ ok: false });
  });
});
