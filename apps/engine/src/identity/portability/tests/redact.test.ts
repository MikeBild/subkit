import { describe, expect, test } from "bun:test";
import { carriesMask, stripMaskedUrl, stripMaskedValues, stripSecretFields } from "../redact.ts";

const MASK = "***redacted***";

describe("stripMaskedUrl", () => {
  test("keeps a plain url untouched", () => {
    expect(stripMaskedUrl("https://api.example.test/v1", "base_url")).toEqual({
      value: "https://api.example.test/v1",
      removed: [],
    });
    expect(stripMaskedUrl(null, "base_url")).toEqual({ value: null, removed: [] });
  });

  test("removes masked userinfo", () => {
    const out = stripMaskedUrl(`https://svc:${MASK}@api.example.test/v1`, "base_url");
    expect(out.value).toBe("https://api.example.test/v1");
    expect(out.removed).toEqual(["base_url.userinfo"]);
  });

  test("removes a token carried as the userinfo name", () => {
    const out = stripMaskedUrl("https://ghp_plaintoken@api.example.test/v1", "base_url");
    expect(out.value).toBe("https://api.example.test/v1");
    expect(out.removed).toEqual(["base_url.userinfo"]);
  });

  test("removes masked query parameters and keeps plain ones", () => {
    const out = stripMaskedUrl(
      `https://api.example.test/v1?api_key=${MASK}&format=json`,
      "base_url",
    );
    expect(out.value).toBe("https://api.example.test/v1?format=json");
    expect(out.removed).toEqual(["base_url.query.api_key"]);
  });

  test("drops an unparseable url that carries the mask", () => {
    expect(stripMaskedUrl(`not a url ${MASK}`, "base_url")).toEqual({
      value: null,
      removed: ["base_url"],
    });
  });
});

describe("stripMaskedValues", () => {
  test("removes masked values in nested objects and arrays", () => {
    const out = stripMaskedValues(
      {
        static_headers: { Authorization: MASK, Accept: "application/json" },
        list: ["keep", "***redacted:token***"],
        nested: { deep: { secret: MASK, label: "x" } },
      },
      "config",
    );
    expect(out.value).toEqual({
      static_headers: { Accept: "application/json" },
      list: ["keep"],
      nested: { deep: { label: "x" } },
    });
    expect(out.removed.sort()).toEqual([
      "config.list[1]",
      "config.nested.deep.secret",
      "config.static_headers.Authorization",
    ]);
    expect(carriesMask(out.value)).toBe(false);
  });
});

describe("stripSecretFields", () => {
  test("removes sensitive keys and non-plain header values from raw values", () => {
    const out = stripSecretFields(
      {
        client_id: "public-id",
        client_secret: "plain-client-secret",
        token_endpoint: "https://auth.example.test/token",
        extra_headers: { Authorization: "Bearer plain-header-secret", Accept: "application/json" },
        nested: { private_key: "-----BEGIN-----" },
      },
      "oauth",
    );
    expect(out.value).toEqual({
      client_id: "public-id",
      token_endpoint: "https://auth.example.test/token",
      extra_headers: { Accept: "application/json" },
      nested: {},
    });
    const text = JSON.stringify(out.value);
    expect(text).not.toContain("plain-client-secret");
    expect(text).not.toContain("plain-header-secret");
    expect(out.removed.sort()).toEqual([
      "oauth.client_secret",
      "oauth.extra_headers.Authorization",
      "oauth.nested.private_key",
    ]);
  });
});
