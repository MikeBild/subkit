import type { TranslationKey } from "@/lib/i18n";

export type InstallPlatform = "ios" | "safari" | "other";

export function installPlatform(userAgent: string, maxTouchPoints = 0): InstallPlatform {
  if (/iPad|iPhone|iPod/.test(userAgent)) return "ios";
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return "ios";
  const safari =
    /Safari\//.test(userAgent) &&
    /Macintosh/.test(userAgent) &&
    !/Chrome|Chromium|Edg|OPR|Firefox/.test(userAgent);
  return safari ? "safari" : "other";
}

export function installGuide(platform: InstallPlatform): {
  title: TranslationKey;
  body: TranslationKey;
} {
  if (platform === "ios") return { title: "pwa.install.guideTitle", body: "pwa.install.guide.ios" };
  if (platform === "safari")
    return { title: "pwa.install.guideTitle", body: "pwa.install.guide.safari" };
  return { title: "installation.unavailableTitle", body: "installation.unavailable" };
}

export function currentInstallGuide() {
  return installGuide(
    typeof navigator === "undefined"
      ? "other"
      : installPlatform(navigator.userAgent, navigator.maxTouchPoints),
  );
}

export function installOffered(input: {
  installed: boolean;
  desktop: boolean;
  secure: boolean;
}): boolean {
  return input.secure && !input.installed && !input.desktop;
}
