import { ContextHelp, FieldLabel, SegmentedControl } from "@/components/cockpit/patterns";
import type { GrantLimit } from "@/lib/core/authority-decision";
import { useI18n } from "@/lib/i18n-context";

const LIMITS = ["until_revoked", "30d", "7d"] as const satisfies readonly GrantLimit[];

const LIMIT_LABELS = {
  until_revoked: "authority.limit.untilRevoked",
  "30d": "authority.limit.thirtyDays",
  "7d": "authority.limit.sevenDays",
} as const satisfies Record<GrantLimit, string>;

const LIMIT_TEST_IDS = {
  until_revoked: "until-revoked",
  "30d": "thirty-days",
  "7d": "seven-days",
} as const satisfies Record<GrantLimit, string>;

export const GRANT_LIMIT_MEANINGS = {
  until_revoked: "authority.limit.untilRevokedMeaning",
  "30d": "authority.limit.thirtyDaysMeaning",
  "7d": "authority.limit.sevenDaysMeaning",
} as const satisfies Record<GrantLimit, string>;

export function GrantLimitField({
  limit,
  disabled,
  readOnly = false,
  onChange,
  testId,
}: {
  limit: GrantLimit;
  disabled: boolean;
  readOnly?: boolean;
  onChange(limit: GrantLimit): void;
  testId: string;
}) {
  const { t } = useI18n();
  if (readOnly)
    return (
      <>
        <FieldLabel>{t("authority.limit.label")}</FieldLabel>
        <p className="text-sm" data-testid={testId}>
          {t(LIMIT_LABELS[limit])}
        </p>
      </>
    );
  return (
    <>
      <FieldLabel className="flex items-center gap-1">
        {t("authority.limit.label")}
        <ContextHelp label={t("authority.limit.label")} testId={`${testId}-hint`}>
          {t(
            limit === "until_revoked"
              ? "authority.limit.untilRevokedHint"
              : "authority.limit.durationHint",
          )}
        </ContextHelp>
      </FieldLabel>
      <SegmentedControl
        label={t("authority.limit.label")}
        value={limit}
        disabled={disabled}
        onValueChange={(next) => {
          const chosen = LIMITS.find((entry) => entry === next);
          if (!disabled && chosen) onChange(chosen);
        }}
        testId={testId}
        options={LIMITS.map((entry) => ({
          value: entry,
          label: t(LIMIT_LABELS[entry]),
          testId: `${testId}-${LIMIT_TEST_IDS[entry]}`,
        }))}
      />
    </>
  );
}
