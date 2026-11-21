import { CopyField } from "@/components/cockpit/patterns";
import { inviteLink } from "@/features/admin/model";
import { useI18n } from "@/lib/i18n-context";
import type { Invitation } from "./use-setup";

export function PreparedInvitation({
  email,
  invitation,
}: {
  email: string;
  invitation: Invitation;
}) {
  const { t, dateTime } = useI18n();
  return (
    <div className="flex flex-col gap-2" data-testid="setup-invitation">
      <p className="text-sm font-medium">{t("setup.prepared")}</p>
      <p className="text-sm text-muted-foreground">
        {t("setup.preparedBody", { email, time: dateTime(invitation.expires_at) })}
      </p>
      <CopyField
        value={inviteLink(window.location.origin, invitation.plaintext_token)}
        label={t("setup.preparedLink")}
        testId="setup-invitation-link"
      />
    </div>
  );
}
