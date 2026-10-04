import { describe, expect, it } from "bun:test";
import { baseUrlHost, compareConnectorOverlap, scoreConnectorOverlap } from "./overlap.ts";

const PROPOSED = {
  driver: "http",
  base_url: "https://acme.atlassian.net/wiki/api/v2",
  auth_type: "basic",
};

type ExistingRow = {
  id: string;
  driver: string;
  base_url: string | null;
  auth_type: string;
};

function existingConnector(row: ExistingRow): ExistingRow {
  return row;
}

describe("baseUrlHost", () => {
  it("returns lowercased host for a normal URL", () => {
    expect(baseUrlHost("https://Acme.Atlassian.NET/wiki/api/v2")).toBe("acme.atlassian.net");
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
    const r = scoreConnectorOverlap(
      existingConnector({
        id: "c1",
        driver: "http",
        base_url: "https://acme.atlassian.net",
        auth_type: "basic",
      }),
      PROPOSED,
    );
    expect(r.score).toBe(3);
    expect(r.dimensions).toEqual(["driver", "base_url_host", "auth_type"]);
  });

  it("scores 2 when driver + host match but auth_type differs", () => {
    const r = scoreConnectorOverlap(
      existingConnector({
        id: "c2",
        driver: "http",
        base_url: "https://acme.atlassian.net",
        auth_type: "oauth2_authorization_code",
      }),
      PROPOSED,
    );
    expect(r.score).toBe(2);
    expect(r.dimensions).toEqual(["driver", "base_url_host"]);
  });

  it("scores 2 when driver + auth match but host differs", () => {
    const r = scoreConnectorOverlap(
      existingConnector({
        id: "c3",
        driver: "http",
        base_url: "https://example.atlassian.net",
        auth_type: "basic",
      }),
      PROPOSED,
    );
    expect(r.score).toBe(2);
    expect(r.dimensions).toEqual(["driver", "auth_type"]);
  });

  it("scores 1 when only driver matches", () => {
    const r = scoreConnectorOverlap(
      existingConnector({
        id: "c4",
        driver: "http",
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
      existingConnector({
        id: "c6",
        driver: "http",
        base_url: null,
        auth_type: "basic",
      }),
      PROPOSED,
    );
    expect(r.dimensions).not.toContain("base_url_host");
  });
});

describe("compareConnectorOverlap", () => {
  it("filters by minScore (default 2) and sorts by score descending", () => {
    const matches = compareConnectorOverlap(
      [
        existingConnector({
          id: "weak",
          driver: "http",
          base_url: "https://example.com",
          auth_type: "none",
        }),
        existingConnector({
          id: "auth-mismatch",
          driver: "http",
          base_url: "https://acme.atlassian.net",
          auth_type: "oauth2_authorization_code",
        }),
        existingConnector({
          id: "exact",
          driver: "http",
          base_url: "https://acme.atlassian.net",
          auth_type: "basic",
        }),
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
          driver: "http",
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
      [
        existingConnector({
          id: "near",
          driver: "http",
          base_url: "https://acme.atlassian.net",
          auth_type: "oauth2_authorization_code",
        }),
      ],
      PROPOSED,
      { minScore: 3 },
    );
    expect(matches.length).toBe(0);
  });
});
