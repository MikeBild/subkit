import { describe, expect, test } from "bun:test";
import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import {
  normalizeSignedJwtPrivateKey,
  parseSignedJwtConfig,
  signJwtBearer,
  validateSignedJwtPrivateKey,
} from "./signed-jwt.ts";

async function es256Key(): Promise<string> {
  const pair = await generateKeyPair("ES256", { extractable: true });
  return await exportPKCS8(pair.privateKey);
}

describe("signed_jwt", () => {
  test("RS256 signatures verify with the public key and expire on schedule", async () => {
    const pair = await generateKeyPair("RS256", { extractable: true, modulusLength: 2048 });
    const config = parseSignedJwtConfig({
      signed_jwt: { algorithm: "RS256", audience: ["one", "two"], ttl_seconds: 60 },
    });
    const token = await signJwtBearer({
      private_key: await exportPKCS8(pair.privateKey),
      config,
      now_ms: 1_700_000_000_000,
    });
    const verified = await jwtVerify(token, pair.publicKey, {
      algorithms: ["RS256"],
      audience: "two",
      currentDate: new Date(1_700_000_001_000),
    });
    expect(verified.payload.exp).toBe(1_700_000_060);
    await expect(
      jwtVerify(token, pair.publicKey, {
        algorithms: ["RS256"],
        currentDate: new Date(1_700_000_061_000),
      }),
    ).rejects.toThrow();
  });

  test("rejects invalid lifetimes and a different elliptic curve", async () => {
    for (const ttl_seconds of [0, 59, 3601, 1.5]) {
      expect(() =>
        parseSignedJwtConfig({ signed_jwt: { algorithm: "ES256", audience: "test", ttl_seconds } }),
      ).toThrow();
    }
    const pair = await generateKeyPair("ES384", { extractable: true });
    await expect(
      validateSignedJwtPrivateKey(await exportPKCS8(pair.privateKey), "ES256"),
    ).rejects.toThrow("P-256");
  });
  test("mints an ES256 bearer with configured identity and a deterministic lifetime", async () => {
    const private_key = await es256Key();
    const config = parseSignedJwtConfig({
      signed_jwt: {
        algorithm: "ES256",
        audience: "provider-api",
        issuer: "issuer-id",
        subject: "subject-id",
        key_id: "key-id",
        claims: { role: "reader", enabled: true },
        ttl_seconds: 300,
      },
    });
    const token = await signJwtBearer({ private_key, config, now_ms: 1_700_000_000_000 });
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "ES256", kid: "key-id", typ: "JWT" });
    expect(decodeJwt(token)).toMatchObject({
      aud: "provider-api",
      iss: "issuer-id",
      sub: "subject-id",
      role: "reader",
      enabled: true,
      iat: 1_700_000_000,
      exp: 1_700_000_300,
    });
  });

  test("normalizes a pasted PKCS#8 key without PEM line breaks", async () => {
    const private_key = await es256Key();
    const pasted = private_key.replaceAll("\n", "");
    const normalized = normalizeSignedJwtPrivateKey(pasted);
    await validateSignedJwtPrivateKey(normalized, "ES256");
  });

  test("rejects reserved static claims and an incompatible key", async () => {
    expect(() =>
      parseSignedJwtConfig({
        signed_jwt: { algorithm: "ES256", audience: "provider", claims: { exp: 1 } },
      }),
    ).toThrow(/invalid signed_jwt/);
    await expect(validateSignedJwtPrivateKey(await es256Key(), "RS256")).rejects.toThrow(
      /requires a matching private key/,
    );
  });
});
