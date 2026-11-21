import {
  type ApprovalChoice,
  approvalChoice,
  approvalRemedy,
  type EnvironmentBlock,
} from "@shared/approval-choice.ts";
import { Label } from "@ui/atoms/label";
import { RadioGroup, RadioGroupItem } from "@ui/atoms/radio-group";
import { Alert, AlertDescription, AlertTitle } from "@ui/molecules/alert";
import type { ReactNode } from "react";
import { absolute } from "@/app/links";
import { Button } from "@/components/cockpit/patterns";
import { approvalRemedyLink, BLOCK_SENTENCE_KEYS } from "@/features/grants/model/grant-decision";
import type { ReviewEnvironment } from "@/features/grants/model/review-environment";
import type { WorkflowAuthorityPreview } from "@/features/grants/model/workflow-authorities";
import { cronWords } from "@/features/workflows/model";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

function other(environment: ReviewEnvironment): ReviewEnvironment {
  return environment === "dev" ? "prod" : "dev";
}

function useEnvironmentWord() {
  const { t } = useI18n();
  return (environment: ReviewEnvironment) =>
    t(environment === "prod" ? "authority.production" : "authority.development");
}

function useBlockSentences() {
  const { t } = useI18n();
  const word = useEnvironmentWord();
  return (blocks: readonly (EnvironmentBlock & { environment: ReviewEnvironment })[]) => {
    const sentences = blocks.map((block) =>
      t(BLOCK_SENTENCE_KEYS[block.code], {
        connector: block.connector_name ?? t("authority.decision.unnamedConnector"),
        environment: word(block.environment),
      }),
    );
    return [...new Set(sentences)];
  };
}

export function GrantEnvironmentDecision({
  preview,
  environment,
  busy,
  onSelect,
}: {
  preview: WorkflowAuthorityPreview;
  environment: ReviewEnvironment;
  busy: boolean;
  onSelect(environment: ReviewEnvironment): void;
}) {
  const choice = approvalChoice(preview, environment);
  if (choice.kind === "none") return <GrantEnvironmentBlocked choice={choice} />;
  return (
    <GrantEnvironmentChoice
      environment={choice.kind === "single" ? choice.environment : environment}
      fixed={choice.kind === "single"}
      busy={busy}
      onSelect={onSelect}
      note={choice.kind === "single" ? <SingleReason choice={choice} preview={preview} /> : null}
    />
  );
}

function SingleReason({
  choice,
  preview,
}: {
  choice: Extract<ApprovalChoice, { kind: "single" }>;
  preview: WorkflowAuthorityPreview;
}) {
  const { t, locale } = useI18n();
  const sentences = useBlockSentences();
  const { environment, reason } = choice;
  const schedules = preview.schedules.map((schedule) =>
    cronWords(schedule.cron, t, LOCALE_TAGS[locale]),
  );
  const why =
    reason === "only_possible"
      ? sentences(
          preview.environments[other(environment)].reasons.map((block) => ({
            ...block,
            environment: other(environment),
          })),
        ).join(" ")
      : reason === "schedule"
        ? schedules.length === 1
          ? t("authority.decision.reason.scheduleWhen", { when: schedules[0] ?? "" })
          : t("authority.decision.reason.schedule")
        : t(`authority.decision.reason.${reason}`);
  return <span data-testid="authority-decision-single">{why}</span>;
}

function GrantEnvironmentChoice({
  environment,
  fixed,
  busy,
  note,
  onSelect,
}: {
  environment: ReviewEnvironment;
  fixed: boolean;
  busy: boolean;
  note: ReactNode;
  onSelect(environment: ReviewEnvironment): void;
}) {
  const { t } = useI18n();
  return (
    <fieldset data-testid="authority-decision">
      <legend className="mb-2 text-sm font-medium">{t("authority.environment")}</legend>
      <RadioGroup
        value={environment}
        disabled={busy}
        onValueChange={(value) => {
          if (busy || fixed || (value !== "dev" && value !== "prod") || value === environment)
            return;
          onSelect(value);
        }}
        className="flex gap-4"
        data-testid="authority-environment"
      >
        {(["dev", "prod"] as const).map((entry) => (
          <div key={entry} className="flex items-center gap-2">
            <RadioGroupItem
              id={`authority-environment-${entry}`}
              value={entry}
              disabled={fixed && entry !== environment}
              data-testid={`authority-environment-${entry}`}
            />
            <Label htmlFor={`authority-environment-${entry}`}>
              {t(entry === "prod" ? "authority.production" : "authority.development")}
            </Label>
          </div>
        ))}
      </RadioGroup>
      <p
        className="mt-2 text-xs text-muted-foreground"
        data-testid={`authority-choice-${environment}`}
      >
        {note ??
          t(
            environment === "prod"
              ? "authority.decision.choice.prod"
              : "authority.decision.choice.dev",
          )}
      </p>
    </fieldset>
  );
}

function GrantEnvironmentBlocked({
  choice,
}: {
  choice: Extract<ApprovalChoice, { kind: "none" }>;
}) {
  const { t } = useI18n();
  const sentences = useBlockSentences();
  const link = approvalRemedyLink(approvalRemedy(choice.reasons));
  return (
    <Alert data-testid="authority-decision-blocked">
      <AlertTitle>{t("authority.decision.none.title")}</AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {sentences(choice.reasons).map((sentence) => (
            <li key={sentence}>{sentence}</li>
          ))}
        </ul>
        {link && (
          <Button asChild size="sm" className="mt-2 w-fit">
            <a href={absolute(link.href)} data-testid="authority-decision-remedy">
              {t(link.labelKey)}
            </a>
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
