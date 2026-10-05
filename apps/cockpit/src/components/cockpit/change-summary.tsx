import type { ReactNode } from "react";
import { FocusedDiff } from "@/components/cockpit/diff-card";
import { CollapsibleSection, type Fact, FactList } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import type { ChangeFact } from "@/pages/decisions-model";

const Code = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-xs">{children}</span>
);

export function ChangeSummary({
  facts,
  step,
  cause,
  collapsed = false,
  testId,
}: {
  facts: readonly ChangeFact[];
  step: string | null;
  cause?: ReactNode;
  collapsed?: boolean;
  testId: string;
}) {
  const { t } = useI18n();
  const fieldLabel = (fact: ChangeFact) =>
    fact.path ? <Code>{fact.path}</Code> : t("decisions.fact.wholeStep");
  const [only] = facts;
  const changes: Fact[] =
    facts.length === 1 && only?.inline
      ? [
          { label: t("decisions.fact.before"), value: <Code>{only.inline.before}</Code> },
          { label: t("decisions.fact.after"), value: <Code>{only.inline.after}</Code> },
        ]
      : facts.map((fact, index) => ({
          label: fieldLabel(fact),
          testId: `${testId}-field-${index}`,
          value: fact.inline ? (
            <Code>{`${fact.inline.before} → ${fact.inline.after}`}</Code>
          ) : collapsed ? (
            t("decisions.fact.changed")
          ) : (
            <FocusedDiff rows={fact.rows} testId={`${testId}-diff-${index}`} />
          ),
        }));
  const folded = collapsed ? facts.filter((fact) => !fact.inline) : [];
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid={testId}>
      <FactList
        testId={`${testId}-facts`}
        items={[
          ...(step ? [{ label: t("decisions.fact.step"), value: step }] : []),
          ...(cause ? [{ label: t("decisions.fact.cause"), value: cause }] : []),
          ...changes,
        ]}
      />
      {folded.length > 0 ? (
        <CollapsibleSection label={t("decisions.changeDetail")} testId={`${testId}-code`}>
          <div className="flex min-w-0 flex-col gap-3">
            {folded.map((fact, index) => (
              <div key={fact.path || index} className="flex min-w-0 flex-col gap-1">
                <p className="text-muted-foreground text-xs">{fieldLabel(fact)}</p>
                <FocusedDiff rows={fact.rows} testId={`${testId}-code-${index}`} />
              </div>
            ))}
          </div>
        </CollapsibleSection>
      ) : null}
    </div>
  );
}
