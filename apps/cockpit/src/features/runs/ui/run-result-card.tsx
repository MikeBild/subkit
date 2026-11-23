import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@ui/atoms/collapsible";
import { IconTile } from "@ui/atoms/icon-tile";
import { Panel } from "@ui/atoms/pill";
import { CheckCircle2, ChevronRight, ExternalLink } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { buttonVariants, type Fact, FactList } from "@/components/cockpit/patterns";
import { pluralKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  type RunRecordLink,
  recordButtons,
  recordSystems,
  runRecordLinks,
  runStepTally,
} from "../model/record-links";

function RecordAnchor({
  link,
  primary,
  testId,
}: {
  link: RunRecordLink;
  primary: boolean;
  testId: string;
}) {
  const { t } = useI18n();
  const text = t("runs.result.view", { system: link.connectorName });
  return (
    <a
      className={buttonVariants({ variant: primary ? "default" : "outline", size: "sm" })}
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={link.label ?? undefined}
      data-testid={testId}
    >
      <ExternalLink aria-hidden="true" />
      {text}
      <span className="sr-only">
        {link.label ? ` · ${link.label}` : ""} · {t("runs.result.newTab")}
      </span>
    </a>
  );
}

export function RunRecordsCard({
  detail,
  title,
  duration,
  details,
  testId,
}: {
  detail: unknown;
  title: ReactNode;
  duration: string | null;
  details?: ReactNode;
  testId?: string;
}) {
  const { t } = useI18n();
  const links = runRecordLinks(detail);
  if (links.length === 0) return null;
  const tally = runStepTally(detail);
  const facts: Fact[] = [
    ...(tally
      ? [
          {
            label: t("runs.result.steps"),
            value: t("runs.result.stepsValue", tally),
            testId: testId ? `${testId}-steps` : undefined,
          },
        ]
      : []),
    ...(duration ? [{ label: t("runs.result.duration"), value: duration }] : []),
  ];
  return (
    <RunResultCard
      title={title}
      line={t(pluralKey("runs.result.recordsLine", links.length), {
        count: links.length,
        systems: recordSystems(links),
      })}
      facts={facts}
      links={links}
      details={details}
      testId={testId}
    />
  );
}

export function RunResultCard({
  title,
  line,
  facts,
  links,
  details,
  testId = "run-result-card",
}: {
  title: ReactNode;
  line?: ReactNode;
  facts: readonly Fact[];
  links: readonly RunRecordLink[];
  details?: ReactNode;
  testId?: string;
}) {
  const { t } = useI18n();
  const heading = useId();
  const [open, setOpen] = useState(false);
  const buttons = recordButtons(links);
  return (
    <section aria-labelledby={heading} data-testid={testId}>
      <Panel>
        <div className="flex items-start gap-3">
          <IconTile icon={CheckCircle2} size="sm" />
          <div className="min-w-0">
            <p id={heading} className="font-semibold" data-testid={`${testId}-title`}>
              {title}
            </p>
            {line ? (
              <p className="text-sm text-muted-foreground" data-testid={`${testId}-line`}>
                {line}
              </p>
            ) : null}
          </div>
        </div>
        {facts.length > 0 ? (
          <div className="mt-3">
            <FactList items={facts} testId={`${testId}-facts`} />
          </div>
        ) : null}
        {buttons.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {buttons.map((link, index) => (
              <RecordAnchor
                key={link.url}
                link={link}
                primary={index === 0}
                testId={`${testId}-open-${index}`}
              />
            ))}
          </div>
        ) : null}
        <Collapsible open={open} onOpenChange={setOpen} className="mt-3">
          <CollapsibleTrigger
            className="group/details -ml-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`${testId}-details-toggle`}
          >
            <ChevronRight
              aria-hidden="true"
              className="size-4 text-muted-foreground transition-transform group-data-[state=open]/details:rotate-90"
            />
            {t(open ? "runs.result.hideDetails" : "runs.result.showDetails")}
          </CollapsibleTrigger>
          <CollapsibleContent className="sk-collapsible overflow-hidden">
            <div className="flex flex-col gap-3 pt-2" data-testid={`${testId}-details`}>
              {links.length > 0 ? (
                <ul className="flex flex-col gap-2 text-sm" data-testid={`${testId}-records`}>
                  {links.map((link, index) => (
                    <li key={link.url} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <a
                        className="break-all underline underline-offset-4"
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid={`${testId}-record-${index}`}
                      >
                        {link.label ?? link.connectorName}
                        <span className="sr-only"> · {t("runs.result.newTab")}</span>
                      </a>
                      <span className="text-muted-foreground">
                        {[
                          link.connectorName,
                          link.stepKey ? t("runs.result.step", { step: link.stepKey }) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {details}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Panel>
    </section>
  );
}
