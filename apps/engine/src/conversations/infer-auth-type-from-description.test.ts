import { describe, expect, it } from "bun:test";
import { inferAuthTypeFromDescription } from "./connector-template-intelligence.ts";

describe("inferAuthTypeFromDescription", () => {
  it("oauth wins over everything else", () => {
    expect(inferAuthTypeFromDescription("OAuth2 with username and password")).toBe("oauth2");
    expect(inferAuthTypeFromDescription("uses oauth")).toBe("oauth2");
  });

  it("API token with email → basic (Atlassian pattern)", () => {
    expect(inferAuthTypeFromDescription("Jira Cloud, API token with email")).toBe("basic");
  });

  it("basic auth / username / password / email all signal basic", () => {
    expect(inferAuthTypeFromDescription("basic auth")).toBe("basic");
    expect(inferAuthTypeFromDescription("login with username")).toBe("basic");
    expect(inferAuthTypeFromDescription("requires a password")).toBe("basic");
    expect(inferAuthTypeFromDescription("authenticate with your email and a token")).toBe("basic");
  });

  it("bearer / personal access token → bearer", () => {
    expect(inferAuthTypeFromDescription("bearer token")).toBe("bearer");
    expect(inferAuthTypeFromDescription("GitHub personal access token")).toBe("bearer");
  });

  it("bare token / api key are ambiguous → null", () => {
    expect(inferAuthTypeFromDescription("uses a token")).toBeNull();
    expect(inferAuthTypeFromDescription("authenticate with an API token")).toBeNull();
    expect(inferAuthTypeFromDescription("api key")).toBeNull();
  });

  it("query / header / public remain recognised", () => {
    expect(inferAuthTypeFromDescription("api key in the query string")).toBe("query");
    expect(inferAuthTypeFromDescription("api key in a custom header")).toBe("header");
    expect(inferAuthTypeFromDescription("public API, no auth")).toBe("none");
    expect(inferAuthTypeFromDescription("unauthenticated endpoint")).toBe("none");
  });

  it("returns null for empty / missing descriptions", () => {
    expect(inferAuthTypeFromDescription(null)).toBeNull();
    expect(inferAuthTypeFromDescription(undefined)).toBeNull();
    expect(inferAuthTypeFromDescription("a plain REST API")).toBeNull();
  });
});
