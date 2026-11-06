import { z } from "@hono/zod-openapi";

export const OAuthStartResponse = z
  .object({
    authorization_url: z.string(),
    state: z.string(),
  })
  .openapi("OAuthStartResponse");

export const OAuthCallbackQuery = z
  .object({
    state: z.string(),
    code: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .openapi("OAuthCallbackQuery");
