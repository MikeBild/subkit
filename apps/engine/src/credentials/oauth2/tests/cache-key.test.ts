import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { oauthConfigCacheKey } from "../client.ts";
import type { OAuth2ClientConfig } from "../types.ts";

const cfg: OAuth2ClientConfig = {
  issuer_url: "https://issuer.example",
  client_id: "client",
  client_secret: "first-secret",
};

describe("oauthConfigCacheKey", () => {
  test("is stable for the same configuration and context", () => {
    expect(oauthConfigCacheKey(cfg, "t1", "strict", 1)).toBe(
      oauthConfigCacheKey({ ...cfg }, "t1", "strict", 1),
    );
  });

  test("changes with a rotated client secret, another tenant, mode or executor", () => {
    const base = oauthConfigCacheKey(cfg, "t1", "strict", 1);
    expect(oauthConfigCacheKey({ ...cfg, client_secret: "rotated" }, "t1", "strict", 1)).not.toBe(
      base,
    );
    expect(oauthConfigCacheKey(cfg, "t2", "strict", 1)).not.toBe(base);
    expect(oauthConfigCacheKey(cfg, "t1", "permissive", 1)).not.toBe(base);
    expect(oauthConfigCacheKey(cfg, "t1", "strict", 2)).not.toBe(base);
  });

  test("keys the cache by identity without digesting the client secret", () => {
    const key = oauthConfigCacheKey(cfg, null, null, 0);
    const digest = createHash("sha256")
      .update(JSON.stringify([cfg, null, null, 0]))
      .digest("hex");
    expect(key).not.toBe(digest);
    expect(JSON.parse(key)).toEqual([cfg, null, null, 0]);
  });
});
