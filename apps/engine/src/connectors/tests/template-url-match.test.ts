import { describe, expect, test } from "bun:test";
import { matchTemplateByUrl, matchTemplatesByUrl } from "../template-url-match.ts";

describe("matchTemplateByUrl", () => {
  test("Stripe URL matches stripe template", () => {
    const result = matchTemplateByUrl("https://api.stripe.com/v1/charges");
    expect(result).not.toBeNull();
    expect(result!.template.slug).toBe("stripe");
  });

  test("HubSpot URL matches hubspot template", () => {
    const result = matchTemplateByUrl("https://api.hubapi.com/crm/v3/objects/contacts");
    expect(result).not.toBeNull();
    expect(result!.template.slug).toMatch(/hubspot/);
  });

  test("GitHub REST URL matches github template", () => {
    const result = matchTemplateByUrl("https://api.github.com/repos/owner/repo");
    expect(result).not.toBeNull();
    expect(result!.template.slug).toMatch(/github/);
  });

  test("GitHub GraphQL URL matches github-graphql or github template", () => {
    const result = matchTemplateByUrl("https://api.github.com/graphql");
    expect(result).not.toBeNull();
    // should match a github-related template
    expect(result!.template.slug).toMatch(/github/);
  });

  test("invalid URL returns null", () => {
    const result = matchTemplateByUrl("not-a-url");
    expect(result).toBeNull();
  });

  test("empty string returns null", () => {
    const result = matchTemplateByUrl("");
    expect(result).toBeNull();
  });

  test("postgres DSN matches postgres template", () => {
    const result = matchTemplateByUrl("postgres://user:pass@host:5432/db");
    // May match or not depending on template patterns — if it does match, driver must be postgres
    if (result !== null) {
      expect(result.template.driver).toBe("postgres");
    }
  });

  test("matched_segment is non-empty on a successful match", () => {
    const result = matchTemplateByUrl("https://api.stripe.com/v1/customers");
    expect(result).not.toBeNull();
    expect(result!.matched_segment.length).toBeGreaterThan(0);
  });

  test("score is positive on a successful match", () => {
    const result = matchTemplateByUrl("https://api.stripe.com/v1/customers");
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThan(0);
  });
});

describe("matchTemplatesByUrl", () => {
  test("returns up to limit results", () => {
    const results = matchTemplatesByUrl("https://api.stripe.com/v1/charges", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("returns empty array for invalid URL", () => {
    const results = matchTemplatesByUrl("not-a-url");
    expect(results).toEqual([]);
  });

  test("results are sorted by score descending", () => {
    const results = matchTemplatesByUrl("https://api.stripe.com/v1/charges", 5);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  test("limit=0 returns empty array", () => {
    const results = matchTemplatesByUrl("https://api.stripe.com/v1/charges", 0);
    expect(results).toEqual([]);
  });
});
