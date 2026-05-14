// Tests for the structural connector-overlap scorer (Adoption A).

import { describe, expect, it } from "bun:test";
import { baseUrlHost, compareConnectorOverlap, scoreConnectorOverlap } from "./overlap.ts";

const PROPOSED = {
  driver: "http",
  base_url: "https://si-emobility.atlassian.net/wiki/api/v2",
  auth_type: "basic",
};

function existingConnector(over: Partial<typeof PROPOSED> & { id: string }) {
  return { ...PROPOSED, ...over };
}

describe("baseUrlHost", () => {
  it("returns lowercased host for a normal URL", () => {
    expect(baseUrlHost("https://Si-EMobility.Atlassian.NET/wiki/api/v2")).toBe(
      "si-emobility.atlassian.net",
    );
  });

  it("returns empty string for null / empty / malformed input", () => {
    expect(baseUrlHost(null)).toBe("");
    expect(baseUrlHost(undefined)).toBe("");
    expect(baseUrlHost("")).toBe("");
    expect(baseUrlHost("not a url")).toBe("");
  });
});

describe("scoreConnectorOverlap", () => {
  it("scores 3 (all dimensions match)", () => {
    const r = scoreConnectorOverlap(existingConnector({ id: "c1" }), PROPOSED);
    expect(r.score).toBe(3);
    expect(r.dimensions).toEqual(["driver", "base_url_host", "auth_type"]);
  });

  it("scores 2 when driver + host match but auth_type differs", () => {
    const r = scoreConnectorOverlap(
      existingConnector({ id: "c2", auth_type: "oauth2_authorization_code" }),
      PROPOSED,
    );
    expect(r.score).toBe(2);
    expect(r.dimensions).toEqual(["driver", "base_url_host"]);
  });

  it("scores 2 when driver + auth match but host differs", () => {
    const r = scoreConnectorOverlap(
      existingConnector({ id: "c3", base_url: "https://example.atlassian.net" }),
      PROPOSED,
    );
    expect(r.score).toBe(2);
    expect(r.dimensions).toEqual(["driver", "auth_type"]);
  });

  it("scores 1 when only driver matches", () => {
    const r = scoreConnectorOverlap(
      existingConnector({
        id: "c4",
        base_url: "https://example.com",
        auth_type: "none",
      }),
      PROPOSED,
    );
    expect(r.score).toBe(1);
    expect(r.dimensions).toEqual(["driver"]);
  });

  it("scores 0 when nothing matches", () => {
    const r = scoreConnectorOverlap(
      existingConnector({
        id: "c5",
        driver: "graphql",
        base_url: "https://example.com",
        auth_type: "none",
      }),
      PROPOSED,
    );
    expect(r.score).toBe(0);
    expect(r.dimensions).toEqual([]);
  });

  it("does NOT count base_url_host when either side has no URL", () => {
    const r = scoreConnectorOverlap(
      { ...PROPOSED, id: "c6", base_url: null as string | null },
      PROPOSED,
    );
    expect(r.dimensions).not.toContain("base_url_host");
  });
});

describe("compareConnectorOverlap", () => {
  it("filters by minScore (default 2) and sorts by score descending", () => {
    const matches = compareConnectorOverlap(
      [
        // Score 1 — should drop with default threshold.
        existingConnector({
          id: "weak",
          base_url: "https://example.com",
          auth_type: "none",
        }),
        // Score 2 — auth_type differs.
        existingConnector({ id: "auth-mismatch", auth_type: "oauth2_authorization_code" }),
        // Score 3 — full match.
        existingConnector({ id: "exact" }),
      ],
      PROPOSED,
    );
    expect(matches.length).toBe(2);
    expect(matches[0]?.connector.id).toBe("exact");
    expect(matches[0]?.score).toBe(3);
    expect(matches[1]?.connector.id).toBe("auth-mismatch");
    expect(matches[1]?.score).toBe(2);
  });

  it("allows surfacing weak matches when minScore=1", () => {
    const matches = compareConnectorOverlap(
      [
        existingConnector({
          id: "weak",
          base_url: "https://example.com",
          auth_type: "none",
        }),
      ],
      PROPOSED,
      { minScore: 1 },
    );
    expect(matches.length).toBe(1);
    expect(matches[0]?.score).toBe(1);
  });

  it("returns no matches when minScore=3 and none are exact", () => {
    const matches = compareConnectorOverlap(
      [existingConnector({ id: "near", auth_type: "oauth2_authorization_code" })],
      PROPOSED,
      { minScore: 3 },
    );
    expect(matches.length).toBe(0);
  });
});
