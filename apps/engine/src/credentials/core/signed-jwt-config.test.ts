import { expect, test } from "bun:test";
import fc from "fast-check";
import { SignedJwtConfigSchema } from "./signed-jwt-config.ts";

const valid = { algorithm: "ES256", audience: "service" } as const;

test("registered JWT claims must use their explicit configuration fields", () => {
  for (const name of ["iss", "sub", "aud", "exp", "nbf", "iat", "jti", "alg", "kid", "typ"]) {
    const result = SignedJwtConfigSchema.safeParse({ ...valid, claims: { [name]: "value" } });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("registered claim accepted");
    expect(result.error.issues).toContainEqual({
      code: "custom",
      path: ["claims", name],
      message: `claims.${name} is a registered JWT claim and must be configured explicitly`,
    });
  }
});

test("algorithm, audience, lifetime and optional identity constraints are enforced", () => {
  expect(SignedJwtConfigSchema.parse(valid)).toEqual({ ...valid, ttl_seconds: 300 });
  expect(
    SignedJwtConfigSchema.parse({
      ...valid,
      algorithm: "RS256",
      audience: ["a", "b"],
      issuer: "issuer",
      subject: "subject",
      key_id: "key",
      ttl_seconds: 60,
    }).ttl_seconds,
  ).toBe(60);
  expect(SignedJwtConfigSchema.parse({ ...valid, ttl_seconds: 3600 }).ttl_seconds).toBe(3600);
  for (const override of [
    { algorithm: "HS256" },
    { audience: "" },
    { audience: [] },
    { audience: [""] },
    { ttl_seconds: 59 },
    { ttl_seconds: 3601 },
    { ttl_seconds: 60.5 },
    { issuer: "" },
    { subject: "" },
    { key_id: "" },
    { key_id: "x".repeat(257) },
    { extra: true },
  ]) {
    expect(SignedJwtConfigSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  }
  expect(SignedJwtConfigSchema.safeParse({ ...valid, key_id: "x".repeat(256) }).success).toBe(true);
});

test("custom claims accept bounded primitive values and reject nested or unbounded inputs", () => {
  for (const value of ["text", 1, true, false, [], ["text", 1, true], Array(64).fill(0)])
    expect(SignedJwtConfigSchema.safeParse({ ...valid, claims: { custom: value } }).success).toBe(
      true,
    );
  for (const value of [null, {}, [[1]], Number.NaN, Number.POSITIVE_INFINITY, Array(65).fill(0)])
    expect(SignedJwtConfigSchema.safeParse({ ...valid, claims: { custom: value } }).success).toBe(
      false,
    );
  for (const name of ["", "x".repeat(257)])
    expect(SignedJwtConfigSchema.safeParse({ ...valid, claims: { [name]: "value" } }).success).toBe(
      false,
    );
  expect(
    SignedJwtConfigSchema.safeParse({ ...valid, claims: { ["x".repeat(256)]: "value" } }).success,
  ).toBe(true);
  fc.assert(
    fc.property(fc.string(), (value) => {
      const input = Object.freeze({ ...valid, claims: Object.freeze({ custom: value }) });
      expect(SignedJwtConfigSchema.parse(input).claims).toEqual({ custom: value });
      expect(input.claims.custom).toBe(value);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});
