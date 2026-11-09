import { z } from "zod";

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

export type SignedJwtConfig = z.infer<typeof SignedJwtConfigSchema>;
