import { Button, ContextHelp, Section, TechnicalDetails } from "@/components/cockpit/patterns";
import type { ProposalsModel } from "@/lib/authority-proposals";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";

export function GrantBoundaryProposals({
  model,
  nextVersion,
  busy,
  applying,
  applyFailed,
  trialSkipped,
  mayApply,
  mayTry,
  onApply,
  onTrial,
}: {
  model: ProposalsModel;
  nextVersion: string | null;
  busy: boolean;
  applying: boolean;
  applyFailed: boolean;
  trialSkipped: boolean;
  mayApply: boolean;
  mayTry: boolean;
  onApply: () => void;
  onTrial: () => void;
}) {
  const { t, tn } = useI18n();
  const proposed = model.rows.length;
  const untried = model.untried.length;
  const remaining = model.remaining.length;
  if (proposed + untried + remaining === 0) return null;
  const technical = [...model.untried, ...model.remaining];
  return (
    <Section
      testId="authority-repair"
      label={t("authorityProposals.title")}
      aside={
        <ContextHelp label={t("authorityProposals.title")} testId="authority-repair-help">
          {t("authorityProposals.help")}
        </ContextHelp>
      }
    >
      <div className="flex flex-col items-start gap-3 text-sm">
        {proposed > 0 && (
          <p data-testid="authority-proposals-summary">
            {tn("authorityProposals.summary", proposed)}
          </p>
        )}
        {proposed > 0 && (
          <ul className="flex w-full flex-col divide-y rounded-md border">
            {model.rows.map((row) => (
              <li
                key={row.step_id}
                className="flex min-w-0 flex-col gap-1 px-3 py-2"
                data-testid={`authority-proposal-${row.step_id}`}
                data-destructive={row.destructive}
              >
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{row.label}</span>
                  <span
                    className={cn(row.destructive ? "text-destructive" : "text-muted-foreground")}
                  >
                    {t(row.title)}
                  </span>
                </p>
                <ul className="flex flex-col gap-0.5 text-xs">
                  {row.lines.map((line) => (
                    <li key={`${line.key}:${JSON.stringify(line.values)}`}>
                      {t(line.key, line.values)}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {model.listsValues && (
          <p data-testid="authority-proposals-listed">{t("authorityProposals.listedValues")}</p>
        )}
        {untried > 0 && (
          <p className="flex items-center gap-1" data-testid="authority-proposals-untried">
            {tn("authorityProposals.untried", untried)}
            <ContextHelp
              label={t("authorityProposals.trial.start")}
              testId="authority-proposals-trial-help"
            >
              {t("authorityProposals.trial.what")}
            </ContextHelp>
          </p>
        )}
        {remaining > 0 && (
          <div className="flex flex-col gap-1">
            <p data-testid="authority-repair-remaining">
              {tn("authorityProposals.remaining", remaining)}
            </p>
            <ul className="flex flex-col gap-0.5 text-xs">
              {model.remaining.map((entry) => (
                <li
                  key={`${entry.step_id}:${entry.code}`}
                  data-testid={`authority-proposal-reason-${entry.step_id}`}
                >
                  <span className="font-medium">{entry.label}</span>
                  {": "}
                  {t(entry.reason)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {trialSkipped && (
          <p role="status" data-testid="authority-proposals-trial-none">
            {t("authorityProposals.trial.notStarted")}
          </p>
        )}
        {applyFailed && (
          <p role="alert" data-testid="authority-repair-failed">
            {t("authorityProposals.failed")}
          </p>
        )}
        {proposed > 0 && nextVersion ? (
          <p className="text-muted-foreground" data-testid="authority-repair-creates">
            {t("authorityProposals.creates", { version: nextVersion })}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {proposed > 0 && mayApply && (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              pending={applying}
              onClick={onApply}
              data-testid="authority-repair-apply"
            >
              {t(applying ? "authorityProposals.applying" : "authorityProposals.apply")}
            </Button>
          )}
          {untried > 0 && mayTry && (
            <Button
              type="button"
              size="sm"
              variant={proposed > 0 && mayApply ? "outline" : "default"}
              disabled={busy}
              onClick={onTrial}
              data-testid="authority-proposals-trial"
            >
              {t("authorityProposals.trial.start")}
            </Button>
          )}
        </div>
        <TechnicalDetails testId="authority-proposals-technical">
          <ul className="flex flex-col gap-2 text-xs">
            {model.rows.map((row) => (
              <li key={row.step_id} className="flex min-w-0 flex-col">
                <span className="font-mono">{row.step_id}</span>
                <span className="break-all text-muted-foreground">
                  {t("authorityProposals.technical.sample", { sample: row.technical })}
                </span>
              </li>
            ))}
            {technical.map((entry) => (
              <li key={`${entry.step_id}:${entry.code}`} className="flex min-w-0 flex-col">
                <span className="font-mono">{`${entry.step_id} · ${entry.code}`}</span>
                <span className="text-muted-foreground">{t(entry.reason)}</span>
              </li>
            ))}
          </ul>
        </TechnicalDetails>
      </div>
    </Section>
  );
}
