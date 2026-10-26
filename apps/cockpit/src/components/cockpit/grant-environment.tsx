import {
  type ApprovalChoice,
  approvalChoice,
  approvalRemedy,
  type EnvironmentBlock,
} from "@shared/approval-choice.ts";
import { absolute } from "@/app/links";
import { Button, Field, FieldLabel, SegmentedControl } from "@/components/cockpit/patterns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cronWords } from "@/lib/cron-words";
import { approvalRemedyLink, BLOCK_SENTENCE_KEYS } from "@/lib/grant-decision";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import type { ReviewEnvironment } from "@/lib/review-environment";
import type { WorkflowAuthorityPreview } from "@/lib/workflow-authorities";

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
  if (choice.kind === "choice")
    return <GrantEnvironmentChoice environment={environment} busy={busy} onSelect={onSelect} />;
  return <GrantEnvironmentSingle choice={choice} preview={preview} />;
}

function GrantEnvironmentSingle({
  choice,
  preview,
}: {
  choice: Extract<ApprovalChoice, { kind: "single" }>;
  preview: WorkflowAuthorityPreview;
}) {
  const { t, locale } = useI18n();
  const word = useEnvironmentWord();
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
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="authority-decision">
      <p data-testid="authority-decision-single">
        {t("authority.decision.validFor", { environment: word(environment) })} {why}
      </p>
      <p className="text-xs text-muted-foreground">{t("authority.decision.words")}</p>
    </div>
  );
}

function GrantEnvironmentChoice({
  environment,
  busy,
  onSelect,
}: {
  environment: ReviewEnvironment;
  busy: boolean;
  onSelect(environment: ReviewEnvironment): void;
}) {
  const { t } = useI18n();
  return (
    <Field data-testid="authority-decision">
      <FieldLabel>{t("authority.decision.choice.label")}</FieldLabel>
      <SegmentedControl
        label={t("authority.decision.choice.label")}
        value={environment}
        onValueChange={(value) => {
          if (busy || (value !== "dev" && value !== "prod") || value === environment) return;
          onSelect(value);
        }}
        testId="authority-environment"
        options={[
          { value: "dev", label: t("authority.development"), testId: "authority-environment-dev" },
          {
            value: "prod",
            label: t("authority.production"),
            testId: "authority-environment-prod",
          },
        ]}
      />
      <p className="text-xs text-muted-foreground" data-testid="authority-choice-dev">
        {t("authority.decision.choice.dev")}
      </p>
      <p className="text-xs text-muted-foreground" data-testid="authority-choice-prod">
        {t("authority.decision.choice.prod")}
      </p>
    </Field>
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
