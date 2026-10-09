import { z } from "zod";

export const VerifiedProviderIdentitySchema = z.object({
  issuer: z
    .string()
    .url()
    .refine((value) => {
      try {
        const url = new URL(value);
        return !url.username && !url.password && !url.search && !url.hash;
      } catch {
        return false;
      }
    }),
  subject: z.string().min(1).max(512),
  source: z.enum(["token_endpoint", "openid_claims"]),
});

export type VerifiedProviderIdentity = z.infer<typeof VerifiedProviderIdentitySchema>;

export const CredentialUseSnapshotSchema = z.object({
  connector_id: z.string().uuid(),
  environment: z.enum(["dev", "prod"]),
  credential_id: z.string().uuid().nullable(),
  credential_generation: z.number().int().positive().nullable(),
  connection_id: z.string().uuid().nullable(),
  access_token_version: z.number().int().positive().nullable(),
  identity: VerifiedProviderIdentitySchema.nullable(),
});

export type CredentialUseSnapshot = z.infer<typeof CredentialUseSnapshotSchema>;

export function identityFromTokenResponse(
  issuer: string,
  response: unknown,
): VerifiedProviderIdentity | null {
  const parsed = z.object({ sub: z.string().min(1).max(512) }).safeParse(response);
  if (!parsed.success) return null;
  const identity = VerifiedProviderIdentitySchema.safeParse({
    issuer,
    subject: parsed.data.sub,
    source: "token_endpoint",
  });
  return identity.success ? identity.data : null;
}
