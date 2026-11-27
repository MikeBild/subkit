import { EyeOff } from "lucide-react";
import { Button, CopyField } from "@/components/cockpit/patterns";
import { auditActionLabel } from "@/features/audit/model";
import { usageLine, usageTone } from "@/features/vault/model/uses";
import { activityTone, revealedRows, type VaultActivityEntry } from "@/features/vault/model/vault";
import { formatDateTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

const TONE_DOT = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-destructive",
  neutral: "bg-muted-foreground/40",
} as const;

export function VaultRevealed({
  values,
  secondsLeft,
  onHide,
}: {
  values: Readonly<Record<string, string>>;
  secondsLeft: number;
  onHide(): void;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-2" data-testid="vault-revealed">
      {revealedRows(values).map((row) => {
        const field = row.label ? t(row.label) : row.field;
        return (
          <CopyField
            key={row.field}
            value={row.value}
            label={t("vault.reveal.value", { field })}
            labelled
            testId={`vault-revealed-${row.field}`}
          />
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground" role="timer">
          {t("vault.reveal.hidesIn", { seconds: secondsLeft })}
        </p>
        <Button variant="ghost" size="sm" onClick={onHide} data-testid="vault-reveal-hide">
          <EyeOff data-icon="inline-start" />
          {t("vault.reveal.hide")}
        </Button>
      </div>
    </div>
  );
}

export function VaultActivityList({ entries }: { entries: readonly VaultActivityEntry[] }) {
  const { t, locale } = useI18n();
  if (entries.length === 0)
    return (
      <p className="text-sm text-muted-foreground" data-testid="vault-activity-empty">
        {t("vault.activity.empty")}
      </p>
    );
  return (
    <ol className="grid gap-1.5" data-testid="vault-activity">
      {entries.map((entry) => {
        const label = auditActionLabel(entry.action);
        const use = usageLine(entry);
        const tone = use ? usageTone(entry) : activityTone(entry.result);
        return (
          <li
            key={entry.id}
            className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm"
            data-action={entry.action}
          >
            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
            <span className="min-w-0 flex-1">
              {use ? (
                <span data-testid="vault-activity-use">
                  {use.origin
                    ? t("vault.use.line", { purpose: t(use.purpose), origin: use.origin })
                    : t(use.purpose)}
                  {use.outcome ? (
                    <span className="text-muted-foreground"> · {t(use.outcome)}</span>
                  ) : null}
                </span>
              ) : label.kind === "named" ? (
                t(label.key)
              ) : (
                <span className="font-mono text-xs">{label.value}</span>
              )}
            </span>
            <time dateTime={entry.at} className="shrink-0 text-xs text-muted-foreground">
              {formatDateTime(locale, entry.at)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}
