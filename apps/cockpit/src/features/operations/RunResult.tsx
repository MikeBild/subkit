import { MarkdownDocument } from "@ui/components/proto/MarkdownDocument";
import { Panel } from "@ui/components/proto/Pill";
import { IconTile, StepGraph } from "@ui/components/proto/visual";
import { FileText, ShieldCheck } from "lucide-react";
import { type ReactNode, useId } from "react";
import { useI18n } from "@/lib/i18n-context";
import type { RunGraphStep } from "./model";

export function RunWhy({
  rows,
  boundary,
  testId,
}: {
  rows: { label: string; value: ReactNode; mono?: boolean }[];
  boundary?: ReactNode;
  testId?: string;
}) {
  const { t } = useI18n();
  const heading = useId();
  return (
    <section aria-labelledby={heading} data-testid={testId}>
      <Panel>
        <div className="mb-3 flex items-center gap-3">
          <IconTile icon={ShieldCheck} size="sm" />
          <p id={heading} className="font-semibold">
            {t("runs.caller.why")}
          </p>
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <span className="text-muted-foreground">{row.label}</span>
              <span className={row.mono ? "break-all font-mono text-xs" : "min-w-0"}>
                {row.value}
              </span>
            </div>
          ))}
        </div>
        {boundary ? <p className="mt-3 rounded-lg bg-secondary p-3 text-sm">{boundary}</p> : null}
      </Panel>
    </section>
  );
}

export function RunStepGraph({ steps, testId }: { steps: RunGraphStep[]; testId?: string }) {
  const { t } = useI18n();
  if (steps.length === 0) return null;
  return (
    <div data-testid={testId}>
      <Panel>
        <StepGraph
          label={t("ops.steps")}
          steps={steps.map((step, index) => ({
            label: step.name ?? t("workflowFlow.stepNumber", { number: index + 1 }),
            state: step.state,
          }))}
        />
      </Panel>
    </div>
  );
}

export function RunResultDocument({
  result,
  empty,
  testId,
}: {
  result: { text: string; truncated: boolean } | null;
  empty?: string;
  testId?: string;
}) {
  const { t } = useI18n();
  const heading = useId();
  if (!result && !empty) return null;
  return (
    <section aria-labelledby={heading} data-testid={testId}>
      <Panel>
        <div className="mb-3 flex items-center gap-3">
          <IconTile icon={FileText} size="sm" />
          <p id={heading} className="font-semibold">
            {t("ops.run.result")}
          </p>
        </div>
        {result ? (
          <MarkdownDocument text={result.text} toolbar={false} toc={false} compact />
        ) : (
          <p
            className="text-sm text-muted-foreground"
            data-testid={testId ? `${testId}-empty` : undefined}
          >
            {empty}
          </p>
        )}
        {result?.truncated ? (
          <p
            className="mt-3 text-xs text-muted-foreground"
            data-testid={testId ? `${testId}-truncated` : undefined}
          >
            {t("ops.run.resultTruncated")}
          </p>
        ) : null}
      </Panel>
    </section>
  );
}
