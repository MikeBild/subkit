import { cockpitApiHref } from "@/app/installation-context";
import type { BrandingPalette, TenantBranding, TenantBrandingUpdate } from "@/api/tenant-branding";

export const BRANDING_PALETTES: readonly BrandingPalette[] = ["standard", "indigo", "teal"];

export function brandingLogo(value: TenantBranding | undefined, theme: "light" | "dark") {
  const source = value?.logo_urls[theme] ?? value?.logo_urls[theme === "light" ? "dark" : "light"] ?? null;
  return source ? cockpitApiHref(source) : null;
}

export const BRANDING_SWATCHES = {
  standard: ["#0f172a", "#2563eb", "#f8fafc", "#60a5fa"],
  indigo: ["#312e81", "#4f46e5", "#e0e7ff", "#a5b4fc"],
  teal: ["#134e4a", "#0f766e", "#ccfbf1", "#5eead4"],
} as const;

export function brandingDraft(value: TenantBranding): TenantBrandingUpdate {
  return {
    revision: value.revision,
    display_name: value.display_name,
    subtitle: value.subtitle,
    palette: value.palette,
    logos: { light: { operation: "keep" }, dark: { operation: "keep" } },
  };
}

export function brandingDraftLogo(
  draft: TenantBrandingUpdate,
  saved: TenantBranding,
  theme: "light" | "dark",
): string | null {
  const change = draft.logos[theme];
  if (change.operation === "remove") return null;
  if (change.operation === "replace")
    return `data:${change.mime_type};base64,${change.content_base64}`;
  const source = saved.logo_urls[theme];
    return source ? cockpitApiHref(source) : null;
}

export function brandingPreviewLogo(
  draft: TenantBrandingUpdate,
  saved: TenantBranding,
  theme: "light" | "dark",
): string | null {
  return (
    brandingDraftLogo(draft, saved, theme) ??
    brandingDraftLogo(draft, saved, theme === "light" ? "dark" : "light")
  );
}

export async function readBrandingLogo(file: File) {
  if (file.size > 2 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("branding_image_invalid");
  const bitmap = await createImageBitmap(file);
  const valid = bitmap.width * bitmap.height <= 4_000_000;
  bitmap.close();
  if (!valid) throw new Error("branding_image_invalid");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("branding_image_invalid"));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("branding_image_invalid"));
    reader.readAsDataURL(file);
  });
  return {
    operation: "replace" as const,
    mime_type: file.type as "image/png" | "image/jpeg" | "image/webp",
    content_base64: data.slice(data.indexOf(",") + 1),
  };
}
