import { IconTile } from "@ui/atoms/icon-tile";
import { Panel, Pill } from "@ui/atoms/pill";
import { Skeleton } from "@ui/atoms/skeleton";
import { ErrorNotice } from "@ui/molecules/error-notice";
import { Gauge } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SegmentedControl } from "@/components/cockpit/patterns";
import { Button } from "@/components/cockpit/patterns/controls";
import { Progress } from "@/components/cockpit/patterns/meter";
import { SectionHeading } from "@/components/cockpit/patterns/section";
import { errorRows } from "@/lib/error-rows";
import { useI18n } from "@/lib/i18n-context";
import type { SpendIntent, SpendPanel } from "./spend-model";

export function SpendPanelView({
  panel,
  loading = false,
  failed = false,
  onRetry = () => {},
  usd,
  intent,
  saving,
  saveError,
  onRaise,
  onContinue,
}: {
  panel: SpendPanel | null;
  loading?: boolean;
  failed?: boolean;
  onRetry?: () => void;
  usd: (amount: number) => string;
  intent: SpendIntent;
  saving: boolean;
  saveError: unknown;
  onRaise: (limit: number, onDone: () => void) => void;
  onContinue: () => void;
}) {
  const { t } = useI18n();
  const [choosing, setChoosing] = useState(intent === "raise");
  const keepGoing = useRef<HTMLButtonElement>(null);
  const canContinue = panel?.canContinue === true;
  useEffect(() => {
    if (intent === "continue" && canContinue) keepGoing.current?.focus();
  }, [intent, canContinue]);
  const limitLabel = (limit: number) => (limit > 0 ? usd(limit) : t("setup.budget.none"));
  return (
    <Panel className="flex flex-col">
      <div className="mb-4 flex items-center gap-3">
        <IconTile icon={Gauge} size="sm" />
        <SectionHeading className="flex-1 font-semibold">{t("us.spend")}</SectionHeading>
        {panel && (
          <span data-testid="us-spend-state" data-state={panel.state}>
            <Pill tone={panel.tone}>{t(`us.spendState.${panel.state}`)}</Pill>
          </span>
        )}
      </div>
      {loading ? (
        <div className="flex flex-col gap-3" data-testid="us-spend-loading">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-2 w-full" />
          <Skeleton className="h-4 w-20" />
        </div>
      ) : failed ? (
        <ErrorNotice
          testId="us-spend-failed"
          kind="pageFailed"
          rows={[]}
          primary={{ label: t("kn.retry"), onClick: onRetry }}
        />
      ) : panel ? (
        <div className="flex flex-col gap-3" data-testid="us-spend">
          <p className="font-mono text-2xl font-semibold" data-testid="us-spend-spent">
            {usd(panel.spent)}
          </p>
          {panel.limit !== null && panel.pct !== null && (
            <Progress value={Math.min(100, panel.pct)} aria-label={t("us.spend")} />
          )}
          <p className="text-sm text-muted-foreground" data-testid="us-spend-limit">
            {panel.limit === null
              ? t("setup.budget.none")
              : t("us.spendOf", { limit: usd(panel.limit) })}
          </p>
          {(panel.canRaise || panel.canContinue) && (
            <div className="flex flex-wrap gap-2">
              {panel.canContinue && (
                <Button
                  ref={keepGoing}
                  size="sm"
                  disabled={saving}
                  onClick={onContinue}
                  data-testid="us-spend-continue"
                >
                  {t("us.spendContinue")}
                </Button>
              )}
              {panel.canRaise && (
                <Button
                  size="sm"
                  variant="outline"
                  aria-expanded={choosing}
                  disabled={saving}
                  onClick={() => setChoosing(!choosing)}
                  data-testid="us-spend-raise"
                >
                  {t("us.spendRaise")}
                </Button>
              )}
            </div>
          )}
          {choosing && panel.canRaise && (
            <SegmentedControl
              wrap
              label={t("setup.question.budget")}
              testId="us-spend-choices"
              disabled={saving}
              value={panel.limit === null ? "0" : String(panel.limit)}
              onValueChange={(next) => onRaise(Number(next), () => setChoosing(false))}
              options={panel.choices.map((choice) => ({
                value: String(choice),
                label: limitLabel(choice),
                testId: `us-spend-choice-${choice}`,
              }))}
            />
          )}
          {saveError ? (
            <ErrorNotice
              testId="us-spend-save-failed"
              kind="settingNotSaved"
              rows={errorRows(saveError, t)}
            />
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="us-spend-none">
          {t("us.spendNotUsd")}
        </p>
      )}
    </Panel>
  );
}
