// The per-tool trust list has one writer. Every other config writer carries
// the stored list over, and refuses a payload that names a different one —
// the rule that keeps an authoring conversation from granting itself trust.

import { describe, expect, test } from "bun:test";
import { BadRequestError } from "../http/errors.ts";
import { carryMcpTrustList, mcpTrustedTools, withoutMcpTrustList } from "./mcp-tool-trust.ts";

const stored = { mcp: { transport: "http", tools_without_confirmation: ["b", "a"] } };

describe("carryMcpTrustList", () => {
  test("a config edit that omits the list keeps the stored one", () => {
    const next = carryMcpTrustList("mcp", stored, { mcp: { transport: "sse" } });
    expect(next).toEqual({ mcp: { transport: "sse", tools_without_confirmation: ["a", "b"] } });
  });

  test("the same list sent back unchanged is accepted", () => {
    const next = { mcp: { transport: "http", tools_without_confirmation: ["a", "b"] } };
    expect(carryMcpTrustList("mcp", stored, next)).toBe(next);
  });

  test("a different list is refused", () => {
    expect(() =>
      carryMcpTrustList("mcp", stored, {
        mcp: { transport: "http", tools_without_confirmation: ["a", "b", "c"] },
      }),
    ).toThrow(BadRequestError);
  });

  test("a new connector may not name a list", () => {
    expect(() =>
      carryMcpTrustList("mcp", null, {
        mcp: { transport: "http", tools_without_confirmation: ["a"] },
      }),
    ).toThrow(BadRequestError);
    expect(carryMcpTrustList("mcp", null, { mcp: { transport: "http" } })).toEqual({
      mcp: { transport: "http" },
    });
  });

  test("other drivers and an absent config pass through untouched", () => {
    const http = { default_headers: {} };
    expect(carryMcpTrustList("http", stored, http)).toBe(http);
    expect(carryMcpTrustList("mcp", stored, undefined)).toBeUndefined();
  });
});

describe("mcpTrustedTools / withoutMcpTrustList", () => {
  test("reads a sorted, de-duplicated list and ignores junk", () => {
    expect(mcpTrustedTools({ mcp: { tools_without_confirmation: ["b", "a", "b", 3] } })).toEqual([
      "a",
      "b",
    ]);
    expect(mcpTrustedTools(null)).toEqual([]);
  });

  test("a copy drops the list and keeps the rest", () => {
    expect(withoutMcpTrustList(stored)).toEqual({ mcp: { transport: "http" } });
    expect(withoutMcpTrustList({ mcp: { transport: "http" } })).toEqual({
      mcp: { transport: "http" },
    });
  });
});
