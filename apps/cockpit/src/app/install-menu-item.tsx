import { Download } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { feedbackBridge } from "@/features/feedback/desktop-bridge";
import { runsInstalled } from "@/features/pwa/display-mode";
import { installOffered } from "@/features/pwa/install-guide";
import { openInstall } from "@/features/pwa/install-store";
import { useI18n } from "@/lib/i18n-context";

export function InstallMenuItem() {
  const { t } = useI18n();
  const offered = installOffered({
    installed: runsInstalled(),
    desktop: feedbackBridge() !== null,
    secure: typeof window !== "undefined" && window.isSecureContext,
  });
  if (!offered) return null;
  return (
    <DropdownMenuItem onSelect={() => openInstall()} data-testid="account-install">
      <Download data-icon="inline-start" />
      {t("pwa.install.menu")}
    </DropdownMenuItem>
  );
}
