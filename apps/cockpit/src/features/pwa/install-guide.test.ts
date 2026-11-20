import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import { installGuide, installOffered, installPlatform } from "./install-guide";

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  safari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  chrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
  firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0",
};

describe("install instructions", () => {
  test("recognise the browsers that install from their own menu", () => {
    expect(installPlatform(UA.iphone)).toBe("ios");
    expect(installPlatform(UA.safari, 5)).toBe("ios");
    expect(installPlatform(UA.safari)).toBe("safari");
    expect(installPlatform(UA.chrome)).toBe("other");
    expect(installPlatform(UA.edge)).toBe("other");
    expect(installPlatform(UA.firefox)).toBe("other");
  });

  test("Safari gets its own steps in both languages", () => {
    expect(translate("de", installGuide("ios").body)).toContain("„Zum Home-Bildschirm“");
    expect(translate("de", installGuide("safari").body)).toContain("„Zum Dock hinzufügen“");
    expect(translate("en", installGuide("ios").body)).toContain("“Add to Home Screen”");
    expect(translate("en", installGuide("safari").body)).toContain("“Add to Dock”");
    expect(installGuide("other")).toEqual({
      title: "installation.unavailableTitle",
      body: "installation.unavailable",
    });
  });

  test("the menu entry reads SubKit installieren", () => {
    expect(translate("de", "pwa.install.menu")).toBe("SubKit installieren");
    expect(translate("en", "pwa.install.menu")).toBe("Install SubKit");
  });

  test("the entry is offered only where installing makes sense", () => {
    expect(installOffered({ installed: false, desktop: false, secure: true })).toBeTrue();
    expect(installOffered({ installed: true, desktop: false, secure: true })).toBeFalse();
    expect(installOffered({ installed: false, desktop: true, secure: true })).toBeFalse();
    expect(installOffered({ installed: false, desktop: false, secure: false })).toBeFalse();
  });
});
