import { createPrivateKey } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import { now } from "../utils/clock.ts";

const SignedJwtAlgorithmSchema = z.enum(["ES256", "RS256"]);
const ClaimPrimitiveSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const ReservedClaimNames = new Set([
  "iss",
  "sub",
  "aud",
  "exp",
  "nbf",
  "iat",
  "jti",
  "alg",
  "kid",
  "typ",
]);

export const SignedJwtConfigSchema = z
  .object({
    algorithm: SignedJwtAlgorithmSchema,
    audience: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    issuer: z.string().min(1).optional(),
    subject: z.string().min(1).optional(),
    key_id: z.string().min(1).max(256).optional(),
    claims: z
      .record(
        z.string().min(1).max(256),
        z.union([ClaimPrimitiveSchema, z.array(ClaimPrimitiveSchema).max(64)]),
      )
      .optional(),
    ttl_seconds: z.number().int().min(60).max(3600).default(300),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const name of Object.keys(value.claims ?? {})) {
      if (ReservedClaimNames.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["claims", name],
          message: `claims.${name} is a registered JWT claim and must be configured explicitly`,
        });
      }
    }
  });

type SignedJwtConfig = z.infer<typeof SignedJwtConfigSchema>;

export function parseSignedJwtConfig(config: Record<string, unknown>): SignedJwtConfig {
  const parsed = SignedJwtConfigSchema.safeParse(config.signed_jwt);
  if (parsed.success) return parsed.data;
  throw Object.assign(new Error("invalid signed_jwt connector configuration"), {
    code: "signed_jwt_config_invalid",
    details: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  });
}

export function normalizeSignedJwtPrivateKey(privateKey: string): string {
  const trimmed = privateKey.trim();
  const match = /^-----BEGIN (PRIVATE KEY)-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END \1-----$/s.exec(
    trimmed,
  );
  if (!match) {
    throw Object.assign(new Error("signed_jwt private_key must be a PKCS#8 PEM private key"), {
      code: "signed_jwt_private_key_invalid",
    });
  }
  const encoded = match[2]!.replaceAll(/\s/g, "");
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw Object.assign(new Error("signed_jwt private_key is not valid PEM base64"), {
      code: "signed_jwt_private_key_invalid",
    });
  }
  return `-----BEGIN ${match[1]}-----\n${encoded.match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END ${match[1]}-----`;
}

export async function validateSignedJwtPrivateKey(
  privateKey: string,
  algorithm: SignedJwtConfig["algorithm"],
): Promise<void> {
  const normalized = normalizeSignedJwtPrivateKey(privateKey);
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(normalized);
  } catch {
    throw Object.assign(new Error("signed_jwt private_key cannot be parsed"), {
      code: "signed_jwt_private_key_invalid",
    });
  }
  const type = key.asymmetricKeyType;
  if ((algorithm === "ES256" && type !== "ec") || (algorithm === "RS256" && type !== "rsa")) {
    throw Object.assign(new Error(`signed_jwt ${algorithm} requires a matching private key`), {
      code: "signed_jwt_private_key_algorithm_mismatch",
    });
  }
  if (algorithm === "RS256") {
    const modulusLength = key.asymmetricKeyDetails?.modulusLength;
    if (!modulusLength || modulusLength < 2048 || modulusLength > 4096) {
      throw Object.assign(
        new Error("signed_jwt RS256 requires an RSA key between 2048 and 4096 bits"),
        {
          code: "signed_jwt_private_key_invalid",
        },
      );
    }
  }
  if (algorithm === "ES256" && key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw Object.assign(new Error("signed_jwt ES256 requires a P-256 private key"), {
      code: "signed_jwt_private_key_invalid",
    });
  }
  try {
    await importPKCS8(normalized, algorithm);
  } catch {
    throw Object.assign(new Error("signed_jwt private_key cannot be imported"), {
      code: "signed_jwt_private_key_invalid",
    });
  }
}

export async function signJwtBearer(p: {
  private_key: string;
  config: SignedJwtConfig;
  now_ms?: number;
}): Promise<string> {
  await validateSignedJwtPrivateKey(p.private_key, p.config.algorithm);
  const key = await importPKCS8(normalizeSignedJwtPrivateKey(p.private_key), p.config.algorithm);
  const issuedAt = Math.floor((p.now_ms ?? now()) / 1000);
  const jwt = new SignJWT(p.config.claims ?? {})
    .setProtectedHeader({
      alg: p.config.algorithm,
      typ: "JWT",
      ...(p.config.key_id ? { kid: p.config.key_id } : {}),
    })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + p.config.ttl_seconds)
    .setAudience(p.config.audience);
  if (p.config.issuer) jwt.setIssuer(p.config.issuer);
  if (p.config.subject) jwt.setSubject(p.config.subject);
  return await jwt.sign(key);
}
