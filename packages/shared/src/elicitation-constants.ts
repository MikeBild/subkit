import { z } from "zod";

export const OAUTH_AUTHORIZATION_URL_FIELD = "authorization_url";

export const OAuthApprovalInputSchema = z
  .object({
    kind: z.literal("external_write"),
    question: z.string().min(1),
    summary: z.string().min(1),
    [OAUTH_AUTHORIZATION_URL_FIELD]: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), {
        message: "authorization_url must be an http(s) URL",
      }),
    redirect_uri: z.string().url(),
  })
  .passthrough();
