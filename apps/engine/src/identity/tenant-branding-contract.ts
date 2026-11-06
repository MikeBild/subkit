import { z } from "zod";
import type { TenantBrandingValue } from "./tenant-branding.ts";

const TenantBrandingLogoOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("keep") }).strict(),
  z.object({ operation: z.literal("remove") }).strict(),
  z
    .object({
      operation: z.literal("replace"),
      mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
      content_base64: z.string().min(1).max(2_796_204),
    })
    .strict(),
]);

const TenantBrandingAppIconOperationSchema = TenantBrandingLogoOperationSchema;

export const TenantBrandingUpdateSchema = z
  .object({
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    display_name: z.string().trim().max(80).nullable(),
    subtitle: z.string().trim().max(160).nullable(),
    palette: z.enum(["standard", "indigo", "teal"]).nullable(),
    logos: z
      .object({ light: TenantBrandingLogoOperationSchema, dark: TenantBrandingLogoOperationSchema })
      .strict(),
    app_icon: TenantBrandingAppIconOperationSchema.optional(),
  })
  .strict();

export const TenantBrandingResetSchema = z
  .object({
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const TenantBrandingLogoReadSchema = z
  .object({
    theme: z.enum(["light", "dark"]),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const TenantBrandingResponseSchema = z.object({
  configured: z.boolean(),
  revision: z.number().int(),
  display_name: z.string().nullable(),
  subtitle: z.string().nullable(),
  palette: z.enum(["standard", "indigo", "teal"]).nullable(),
  logos: z.object({ light: z.boolean(), dark: z.boolean() }),
  logo_urls: z.object({ light: z.string().nullable(), dark: z.string().nullable() }),
  app_icon: z.boolean(),
  app_icon_urls: z.object({ icon_192: z.string().nullable(), icon_512: z.string().nullable() }),
});

export function tenantBrandingResponse(value: TenantBrandingValue, tenantId: string) {
  const query = new URLSearchParams({ tenant_context: tenantId, revision: String(value.revision) });
  const available = value.logos.light || value.logos.dark;
  return {
    ...value,
    logo_urls: {
      light: available ? `/v1/tenant/branding/logo?theme=light&${query}` : null,
      dark: available ? `/v1/tenant/branding/logo?theme=dark&${query}` : null,
    },
    app_icon_urls: {
      icon_192: value.app_icon ? `/v1/tenant/branding/icon?size=192&${query}` : null,
      icon_512: value.app_icon ? `/v1/tenant/branding/icon?size=512&${query}` : null,
    },
  };
}
