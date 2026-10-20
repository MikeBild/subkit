import { describe, expect, test } from "bun:test";
import type { TenantBranding } from "@/api/tenant-branding";
import { BRANDING_SWATCHES, brandingDraft, brandingLogo, brandingPreviewLogo } from "./branding";

const branding: TenantBranding = {
  configured: true,
  revision: 7,
  display_name: "Example",
  subtitle: null,
  palette: "indigo",
  logos: { light: true, dark: false },
  logo_urls: { light: "/logo?tenant_context=example&revision=7", dark: null },
};

function luminance(color: string) {
  const channels = color
    .slice(1)
    .match(/../g)
    ?.map((hex) => {
      const value = Number.parseInt(hex, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
  if (channels?.length !== 3) throw new Error("invalid_color");
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
}

function contrast(a: string, b: string) {
  return (
    (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
  );
}

describe("tenant branding client contracts", () => {
  test("a single uploaded logo is available in either theme", () => {
    expect(brandingLogo(branding, "dark")).toBe(branding.logo_urls.light);
    expect(brandingLogo(branding, "light")).toBe(branding.logo_urls.light);
    expect(brandingLogo(undefined, "dark")).toBeNull();
  });

  test("editing text preserves both stored logos and the reviewed revision", () => {
    expect(brandingDraft(branding)).toMatchObject({
      revision: 7,
      logos: { light: { operation: "keep" }, dark: { operation: "keep" } },
    });
    expect(brandingDraft(branding)).not.toHaveProperty("logo_urls");
  });

  test("local removals and replacements affect only the preview until saved", () => {
    const draft = brandingDraft(branding);
    draft.logos.light = { operation: "remove" };
    expect(brandingPreviewLogo(draft, branding, "dark")).toBeNull();
    draft.logos.dark = { operation: "replace", mime_type: "image/png", content_base64: "aGVsbG8=" };
    expect(brandingPreviewLogo(draft, branding, "light")).toBe("data:image/png;base64,aGVsbG8=");
    expect(branding.logo_urls.light).toContain("tenant_context=example");
  });

  test("effective fallback URLs do not turn an empty upload slot into a stored logo", () => {
    const saved: TenantBranding = {
      ...branding,
      logo_urls: { light: "/logo?theme=light", dark: "/logo?theme=dark" },
    };
    const draft = brandingDraft(saved);
    draft.logos.light = { operation: "remove" };
    expect(brandingPreviewLogo(draft, saved, "dark")).toBeNull();
    expect(brandingPreviewLogo(draft, saved, "light")).toBeNull();
  });

  for (const [palette, colors] of Object.entries(BRANDING_SWATCHES)) {
    test(`${palette} foreground pairs meet text and focus contrast in both themes`, () => {
      expect(contrast(colors[0], "#f8fafc")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors[1], "#ffffff")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors[2], "#0f172a")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors[3], "#020817")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors[1], "#ffffff")).toBeGreaterThanOrEqual(3);
      expect(contrast(colors[3], "#0f172a")).toBeGreaterThanOrEqual(3);
    });
  }
});
