import { isValidElement, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n-context";
import { CollapsibleSection } from "./section";
import { SummaryLine } from "./summary-line";

export function TechnicalDetails({
  children,
  testId = "technical-details",
}: {
  children: ReactNode;
  testId?: string;
}) {
  const { t } = useI18n();
  return (
    <CollapsibleSection label={t("common.technical")} testId={testId}>
      <div className="flex flex-col gap-3" data-slot="technical-details">
        {children}
      </div>
    </CollapsibleSection>
  );
}

export function TabBody({
  summary,
  children,
  more,
  technical,
  testId,
}: {
  summary?: ReactNode;
  children: ReactNode;
  more?: ReactNode;
  technical?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-col gap-6" data-slot="tab-body" data-testid={testId}>
      {summary === undefined || summary === null ? null : isValidElement(summary) ? (
        summary
      ) : (
        <SummaryLine text={summary} testId={testId ? `${testId}-summary` : undefined} />
      )}
      <div className="flex min-w-0 flex-col gap-6" data-slot="tab-main">
        {children}
      </div>
      {more ? (
        <div className="flex flex-col gap-6" data-slot="tab-more">
          {more}
        </div>
      ) : null}
      {technical ? (
        <TechnicalDetails testId={testId ? `${testId}-technical` : undefined}>
          {technical}
        </TechnicalDetails>
      ) : null}
    </div>
  );
}
