// Unit tests for the placeholder scanner.

import { describe, expect, it } from "bun:test";
import { placeholderScanner } from "../scanners/placeholder.ts";

const ctx = { engine_url: "https://subkit-api.example.com" };

describe("placeholderScanner", () => {
  it("flags `your-subkit-instance.com`", () => {
    const vs = placeholderScanner.scan("Use https://your-subkit-instance.com/mcp", ctx);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.kind).toBe("placeholder.host");
    expect(vs[0]?.details?.match).toContain("your-subkit-instance");
  });

  it("flags `your-host.com` and `example.com` as placeholder hosts", () => {
    const vs = placeholderScanner.scan(
      "POST your-host.com/foo and also example.com/bar are placeholders",
      ctx,
    );
    expect(vs.map((v) => v.kind)).toEqual(["placeholder.host", "placeholder.host"]);
  });

  it("flags <YOUR_API_KEY>-style angle placeholders", () => {
    const vs = placeholderScanner.scan("Authorization: Bearer <YOUR_API_KEY>", ctx);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.kind).toBe("placeholder.angle");
    expect(vs[0]?.details?.match).toBe("<YOUR_API_KEY>");
  });

  it("flags `[rest-of-your-key]` truncation markers", () => {
    const vs = placeholderScanner.scan("wf_live_A-GG[rest-of-your-key]", ctx);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.kind).toBe("placeholder.key_template");
  });

  it("flags the bare <placeholder> token", () => {
    const vs = placeholderScanner.scan("Use <placeholder> here", ctx);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.kind).toBe("placeholder.angle_generic");
  });

  it("returns no violations on clean text", () => {
    const vs = placeholderScanner.scan(
      "Use https://subkit-api.example.com/mcp with the key the create_api_key tool returned.",
      ctx,
    );
    expect(vs).toEqual([]);
  });

  it("returns multiple violations across patterns and offsets in one pass", () => {
    const text = "Use your-subkit-instance.com and <YOUR_KEY> and [rest-of-your-key]";
    const vs = placeholderScanner.scan(text, ctx);
    expect(vs.length).toBeGreaterThanOrEqual(3);
    const kinds = vs.map((v) => v.kind).sort();
    expect(kinds).toContain("placeholder.host");
    expect(kinds).toContain("placeholder.angle");
    expect(kinds).toContain("placeholder.key_template");
  });

  it("does not panic on empty input", () => {
    expect(placeholderScanner.scan("", ctx)).toEqual([]);
  });

  it("regex state is reset across calls (no lastIndex leak)", () => {
    placeholderScanner.scan("your-subkit-instance.com once", ctx);
    placeholderScanner.scan("your-subkit-instance.com twice", ctx);
    const third = placeholderScanner.scan("your-subkit-instance.com three", ctx);
    expect(third).toHaveLength(1);
  });

  it("carries a `repair` host when engine_url is available so the orchestrator can heal in-place", () => {
    const vs = placeholderScanner.scan("Use https://your-subkit-instance.com/mcp", ctx);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.kind).toBe("placeholder.host");
    expect(vs[0]?.repair).toBe("subkit-api.example.com");
    expect(vs[0]?.details?.repaired_to).toBe("subkit-api.example.com");
  });

  it("omits `repair` when no engine_url is exposed (falls back to the guard marker)", () => {
    const vs = placeholderScanner.scan("Use your-subkit-instance.com", {});
    expect(vs).toHaveLength(1);
    expect(vs[0]?.kind).toBe("placeholder.host");
    expect(vs[0]?.repair).toBeUndefined();
  });

  it("does not attach `repair` to angle placeholders — those have no grounded substitute", () => {
    const vs = placeholderScanner.scan("Authorization: Bearer <YOUR_API_KEY>", ctx);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.kind).toBe("placeholder.angle");
    expect(vs[0]?.repair).toBeUndefined();
  });
});
