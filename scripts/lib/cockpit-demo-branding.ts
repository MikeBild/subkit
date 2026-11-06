import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cockpitDemoBrandName = "Brennwerk";
const cockpitDemoBrandSubtitle = "Logistik";
const cockpitDemoBrandPalette = "teal" as const;

const directory = fileURLToPath(new URL("./demo-brand/", import.meta.url));

type ImageChange = {
  operation: "replace";
  mime_type: "image/png";
  content_base64: string;
};

type CockpitDemoBrandingUpdate = {
  revision: number;
  display_name: string;
  subtitle: string;
  palette: typeof cockpitDemoBrandPalette;
  logos: { light: ImageChange; dark: ImageChange };
  app_icon: ImageChange;
};

function image(file: string): ImageChange {
  return {
    operation: "replace",
    mime_type: "image/png",
    content_base64: readFileSync(`${directory}${file}`).toString("base64"),
  };
}

export function cockpitDemoBrandingUpdate(revision: number): CockpitDemoBrandingUpdate {
  return {
    revision,
    display_name: cockpitDemoBrandName,
    subtitle: cockpitDemoBrandSubtitle,
    palette: cockpitDemoBrandPalette,
    logos: { light: image("logo-light.png"), dark: image("logo-dark.png") },
    app_icon: image("app-icon.png"),
  };
}

export function cockpitDemoBrandingDigest(): string {
  const { revision: _revision, ...desired } = cockpitDemoBrandingUpdate(0);
  return createHash("sha256").update(JSON.stringify(desired)).digest("hex");
}

export async function applyCockpitDemoBranding(
  request: (path: string, method?: string, body?: unknown) => Promise<unknown>,
  appliedDigest: string | undefined,
): Promise<string> {
  const digest = cockpitDemoBrandingDigest();
  if (appliedDigest === digest) return digest;
  const current = (await request("/v1/tenant/branding")) as {
    revision: number;
  };
  await request("/v1/tenant/branding", "PUT", cockpitDemoBrandingUpdate(current.revision));
  return digest;
}
