import { describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as jose from "jose";
import {
  API_KEY_TOKEN_TYPE,
  applyTokenGrants,
  deriveTokenExchangeSecret,
  keyVersionFingerprint,
  looksLikeExchangedToken,
  narrowGrants,
  parseScopeParam,
  resolveTtlSeconds,
  TOKEN_EXCHANGE_DEFAULT_TTL_SECONDS,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_EXCHANGE_MAX_TTL_SECONDS,
  TokenExchangeError,
  verifyExchangedToken,
} from "./token-exchange.ts";
import { parseTokenExchangeArgs, readKeyFile } from "./token-exchange-cli.ts";

describe("token exchange — grant constants", () => {
  test("uses the RFC 8693 grant URN and a SubKit-owned subject token type", () => {
    expect(TOKEN_EXCHANGE_GRANT_TYPE).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(API_KEY_TOKEN_TYPE).toBe("urn:subkit:params:oauth:token-type:api-key");
  });
});

describe("resolveTtlSeconds", () => {
  test("defaults to 900 and caps at 3600", () => {
    expect(resolveTtlSeconds(undefined)).toBe(TOKEN_EXCHANGE_DEFAULT_TTL_SECONDS);
    expect(resolveTtlSeconds("")).toBe(900);
    expect(resolveTtlSeconds(60)).toBe(60);
    expect(resolveTtlSeconds("120")).toBe(120);
    expect(resolveTtlSeconds(7200)).toBe(TOKEN_EXCHANGE_MAX_TTL_SECONDS);
    expect(resolveTtlSeconds("99999")).toBe(3600);
  });

  test("refuses non-positive or non-integer lifetimes with invalid_request", () => {
    for (const bad of [0, -1, "abc", "1.5", Number.NaN]) {
      let caught: unknown;
      try {
        resolveTtlSeconds(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TokenExchangeError);
      expect((caught as TokenExchangeError).oauth_error).toBe("invalid_request");
    }
  });
});

describe("parseScopeParam", () => {
  test("splits on whitespace and de-duplicates", () => {
    expect(parseScopeParam(undefined)).toEqual([]);
    expect(parseScopeParam("  ")).toEqual([]);
    expect(parseScopeParam("a  b\ta a")).toEqual(["a", "b"]);
  });
});

describe("narrowGrants", () => {
  const key = { scopes: ["workflows:read", "metrics:read"] };

  test("an empty request inherits the key's scopes", () => {
    expect(narrowGrants([], key)).toEqual({ scopes: ["workflows:read", "metrics:read"] });
  });

  test("a subset narrows", () => {
    expect(narrowGrants(["metrics:read"], key)).toEqual({ scopes: ["metrics:read"] });
  });

  test("anything wider is invalid_scope", () => {
    expect(() => narrowGrants(["workflows:write"], key)).toThrow(TokenExchangeError);
    try {
      narrowGrants(["metrics:read", "workflows:write"], key);
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as TokenExchangeError).oauth_error).toBe("invalid_scope");
    }
  });

  test("a wildcard key covers any scope", () => {
    expect(narrowGrants(["executions:read"], { scopes: ["*"] })).toEqual({
      scopes: ["executions:read"],
    });
  });

  test("workflow:<id> narrows the workflows within the key's allow-list", () => {
    expect(narrowGrants(["workflow:wf-a"], { scopes: ["*"], allowed_workflows: "all" })).toEqual({
      scopes: ["*"],
      allowed_workflows: ["wf-a"],
    });
    expect(
      narrowGrants(["workflow:wf-a", "metrics:read"], {
        ...key,
        allowed_workflows: ["wf-a", "wf-b"],
      }),
    ).toEqual({ scopes: ["metrics:read"], allowed_workflows: ["wf-a"] });
    expect(() => narrowGrants(["workflow:wf-z"], { ...key, allowed_workflows: ["wf-a"] })).toThrow(
      /workflow not granted/,
    );
    expect(() => narrowGrants(["workflow:"], { scopes: ["*"] })).toThrow(TokenExchangeError);
  });
});

describe("applyTokenGrants", () => {
  test("the key row stays authoritative — a scope dropped from the key is gone from the token", () => {
    const principal = applyTokenGrants(
      {
        provider: "api_key",
        kind: "user",
        id: "u1",
        tenant_id: "t1",
        roles: ["member"],
        scopes: ["workflows:read"],
        allowed_workflows: ["wf-a", "wf-b"],
      },
      {
        tenant_id: "t1",
        api_key_id: "k1",
        key_version: "v",
        scope: "workflows:read metrics:read",
        allowed_workflows: ["wf-a", "wf-c"],
      },
      { scopes: ["workflows:read"] },
    );
    expect(principal.scopes).toEqual(["workflows:read"]);
    expect(principal.allowed_workflows).toEqual(["wf-a"]);
  });
});

describe("token shape", () => {
  test("verify accepts only our typ + issuer, signed with the MASTER_KEY-derived secret", async () => {
    const secret = deriveTokenExchangeSecret();
    const claims = { tenant_id: "t1", api_key_id: "k1", key_version: "abc", scope: "a" };
    const good = await new jose.SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "subkit-tx+jwt" })
      .setIssuer("subkit")
      .setSubject("u1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret);
    expect(looksLikeExchangedToken(good)).toBe(true);
    expect(looksLikeExchangedToken("wf_live_abcdefghijklmnop")).toBe(false);
    expect(looksLikeExchangedToken("a.b")).toBe(false);

    const foreignTyp = await new jose.SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("subkit")
      .setSubject("u1")
      .setExpirationTime("5m")
      .sign(secret);
    expect(looksLikeExchangedToken(foreignTyp)).toBe(false);

    const wrongSecret = await new jose.SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "subkit-tx+jwt" })
      .setIssuer("subkit")
      .setSubject("u1")
      .setExpirationTime("5m")
      .sign(deriveTokenExchangeSecret("cd".repeat(32)));
    const expired = await new jose.SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "subkit-tx+jwt" })
      .setIssuer("subkit")
      .setSubject("u1")
      .setIssuedAt(1)
      .setExpirationTime(2)
      .sign(secret);

    const verified = await verifyExchangedToken(good);
    expect(verified?.sub).toBe("u1");
    expect(verified?.api_key_id).toBe("k1");
    expect(await verifyExchangedToken(wrongSecret)).toBeNull();
    expect(await verifyExchangedToken(expired)).toBeNull();
    expect(await verifyExchangedToken(foreignTyp)).toBeNull();
  });

  test("key version fingerprint is not the stored hash and changes with it", () => {
    const a = keyVersionFingerprint("00".repeat(32));
    const b = keyVersionFingerprint("01".repeat(32));
    expect(a).not.toBe(b);
    expect(a).not.toContain("00000000");
    expect(a).toHaveLength(32);
  });
});

describe("engine --token-exchange argument parsing", () => {
  test("requires --key-file and reads scope / ttl", () => {
    expect(() => parseTokenExchangeArgs(["--token-exchange"])).toThrow(/--key-file/);
    expect(parseTokenExchangeArgs(["--token-exchange", "--key-file", "/etc/k"])).toEqual({
      keyFile: "/etc/k",
    });
    expect(
      parseTokenExchangeArgs([
        "--token-exchange",
        "--key-file=/etc/k",
        "--scope",
        "metrics:read",
        "--scope",
        "workflow:wf-a",
        "--ttl",
        "300",
      ]),
    ).toEqual({ keyFile: "/etc/k", scope: "metrics:read workflow:wf-a", ttl: 300 });
  });

  test("refuses a TTL outside 1..3600 and a dangling value", () => {
    expect(() =>
      parseTokenExchangeArgs(["--token-exchange", "--key-file", "/k", "--ttl", "0"]),
    ).toThrow(/--ttl/);
    expect(() =>
      parseTokenExchangeArgs(["--token-exchange", "--key-file", "/k", "--ttl", "3601"]),
    ).toThrow(/--ttl/);
    expect(() =>
      parseTokenExchangeArgs(["--token-exchange", "--key-file", "/k", "--scope"]),
    ).toThrow(/--scope/);
  });

  test("readKeyFile takes the first non-empty line, trimmed", () => {
    const tmp = join(tmpdir(), `subkit-token-exchange-${process.pid}.key`);
    writeFileSync(tmp, "\n  wf_live_abc  \nsecond\n");
    try {
      expect(readKeyFile(tmp)).toBe("wf_live_abc");
    } finally {
      unlinkSync(tmp);
    }
  });
});
