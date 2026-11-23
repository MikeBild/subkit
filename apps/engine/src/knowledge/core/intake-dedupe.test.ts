import { describe, expect, test } from "bun:test";
import {
  cosine,
  intakeGroupKey,
  mostSimilar,
  normalizeSourceUrl,
  sameSourceUrl,
  similarityText,
  sourceUrlHost,
} from "./intake-dedupe.ts";

describe("normalizeSourceUrl", () => {
  test("ignores scheme, www, case of the host, fragment, trailing slash and default port", () => {
    expect(normalizeSourceUrl("https://WWW.Example.com:443/Docs/Guide/#intro")).toBe(
      "example.com/Docs/Guide",
    );
    expect(normalizeSourceUrl("http://example.com/Docs/Guide")).toBe("example.com/Docs/Guide");
  });

  test("drops tracking parameters and sorts the rest", () => {
    expect(normalizeSourceUrl("https://example.com/a?utm_source=x&b=2&a=1&fbclid=z")).toBe(
      "example.com/a?a=1&b=2",
    );
  });

  test("keeps a non-default port", () => {
    expect(normalizeSourceUrl("http://localhost:8080/x/")).toBe("localhost:8080/x");
  });

  test("returns null for missing, invalid or non-web addresses", () => {
    expect(normalizeSourceUrl(undefined)).toBeNull();
    expect(normalizeSourceUrl("not a url")).toBeNull();
    expect(normalizeSourceUrl("mailto:someone@example.com")).toBeNull();
  });
});

describe("sourceUrlHost", () => {
  test("returns the bare host", () => {
    expect(sourceUrlHost("https://www.example.com/a/b?c=1")).toBe("example.com");
    expect(sourceUrlHost("https://example.com")).toBe("example.com");
    expect(sourceUrlHost("http://localhost:8080/x")).toBe("localhost");
    expect(sourceUrlHost(null)).toBeNull();
  });
});

describe("sameSourceUrl", () => {
  const candidates = [
    { id: "a", source_url: null },
    { id: "b", source_url: "https://example.com/post?utm_medium=mail" },
    { id: "c", source_url: "https://example.com/post" },
  ];

  test("finds the first candidate with the same normalized address", () => {
    expect(sameSourceUrl("http://www.example.com/post/", candidates)?.id).toBe("b");
  });

  test("finds nothing without an address or without a match", () => {
    expect(sameSourceUrl(undefined, candidates)).toBeNull();
    expect(sameSourceUrl("https://example.com/other", candidates)).toBeNull();
  });
});

describe("mostSimilar", () => {
  test("picks the closest candidate at or above the threshold", () => {
    const found = mostSimilar(
      [1, 0],
      [
        { id: "far", vector: [0, 1] },
        { id: "near", vector: [0.95, Math.sqrt(1 - 0.95 ** 2)] },
        { id: "same", vector: [2, 0] },
        { id: "none", vector: null },
      ],
    );
    expect(found?.id).toBe("same");
    expect(found?.cosine).toBeCloseTo(1);
  });

  test("accepts a score exactly at the threshold and rejects one just below", () => {
    const at = [0.9, Math.sqrt(1 - 0.81)];
    expect(mostSimilar([1, 0], [{ id: "at", vector: at }], 0.9)?.id).toBe("at");
    expect(mostSimilar([1, 0], [{ id: "below", vector: [0.89, Math.sqrt(1 - 0.89 ** 2)] }])).toBe(
      null,
    );
  });

  test("cosine of a zero vector is zero", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("similarityText", () => {
  test("joins title and body and caps the length", () => {
    expect(similarityText(" Title ", " Body ")).toBe("Title\n\nBody");
    expect(similarityText("t", "x".repeat(5000)).length).toBe(2000);
  });
});

describe("intakeGroupKey", () => {
  test("groups by site first", () => {
    expect(
      intakeGroupKey({ source_url: "https://www.Example.com/a", repo: "r", tags: ["z"] }),
    ).toBe("site:example.com");
  });

  test("then by repository, then by the first tag", () => {
    expect(intakeGroupKey({ repo: " Org/Repo " })).toBe("repo:org/repo");
    expect(intakeGroupKey({ tags: ["Zeta", " alpha "] })).toBe("tag:alpha");
  });

  test("is null when nothing groups the item", () => {
    expect(intakeGroupKey({})).toBeNull();
    expect(intakeGroupKey({ source_url: "nope", repo: " ", tags: [" "] })).toBeNull();
  });
});
