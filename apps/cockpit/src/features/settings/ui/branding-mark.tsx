import { cn } from "@ui/lib/utils";
import { useEffect } from "react";
import { cockpitBasePath, installationId } from "@/app/installation-context";
import { useSession } from "@/app/session";
import { brandingLogo } from "@/features/settings/model/branding";
import { useI18n } from "@/lib/i18n-context";
import { useTheme } from "@/lib/theme";
import { BrandingLogo } from "./branding-logo";

export function BrandingAppearance() {
  const session = useSession();
  const value = session.branding;
  const installed = Boolean(installationId());
  useEffect(() => {
    const root = document.documentElement;
    const title = document.title;
    const touchIcon = installed ? document.createElement("link") : null;
    if (touchIcon) {
      touchIcon.rel = "apple-touch-icon";
      touchIcon.sizes = "512x512";
      touchIcon.type = "image/png";
      touchIcon.crossOrigin = "use-credentials";
      touchIcon.href = `${cockpitBasePath()}/icon/512.png?revision=${value?.revision ?? 0}`;
      document.head.append(touchIcon);
    }
    if (value?.configured) {
      root.dataset.brandPalette = value.palette ?? "standard";
    }
    if (installed || value?.configured) document.title = session.tenant.display_name;
    return () => {
      delete root.dataset.brandPalette;
      document.title = title;
      touchIcon?.remove();
    };
  }, [value, installed, session.tenant.id, session.tenant.display_name]);
  return null;
}

export function BrandingWordmark() {
  const session = useSession();
  const { t } = useI18n();
  const { resolved } = useTheme();
  const value = session.branding;
  const src = brandingLogo(value, resolved);
  return (
    <>
      <span
        data-testid="cockpit-wordmark-icon"
        className={cn(
          "grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg",
          !src && "bg-primary text-primary-foreground",
        )}
      >
        <BrandingLogo key={src} src={src} />
      </span>
      <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
        <span data-testid="cockpit-wordmark-name" className="truncate font-semibold">
          {installationId() || value?.configured ? session.tenant.display_name : t("app.name")}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {value?.configured ? value.subtitle : session.tenant.display_name}
        </span>
      </span>
    </>
  );
}

export function BrandingAttribution() {
  const session = useSession();
  if (!session.branding?.configured) return null;
  return (
    <p
      className="px-2 text-xs leading-4 text-muted-foreground group-data-[collapsible=icon]:sr-only"
      data-testid="branding-attribution"
    >
      powered by <span className="font-medium text-foreground">SubKit</span>
    </p>
  );
}
