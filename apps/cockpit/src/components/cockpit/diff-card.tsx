import { CircleAlert, CircleCheck } from "lucide-react";
import type { PatchCandidateDryRun } from "@/api/decisions";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n-context";
import {
  type DiffLine,
  type FocusedRow,
  focusDiff,
  selectChangeView,
  toDiffLines,
} from "@/lib/line-diff";
import { cn } from "@/lib/utils";

export interface DiffCardProps {
  targetLabel: string;
  before: unknown;
  after: unknown;
  lines?: readonly DiffLine[];
  rows?: readonly FocusedRow[];
  changeShownAbove?: boolean;
  changedPaths?: readonly string[];
  driftSummary?: string | null;
  patch?: unknown;
  fixtureAvailable?: boolean;
  dryRun?: PatchCandidateDryRun | null;
  dryRunPending?: boolean;
  embedded?: boolean;
  testId: string;
}

const LINE_STYLE: Record<DiffLine["type"], string> = {
  context: "text-muted-foreground",
  removed: "bg-destructive/10 text-destructive",
  added: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
};

const LINE_PREFIX: Record<DiffLine["type"], string> = {
  context: " ",
  removed: "-",
  added: "+",
};

export function FocusedDiff({ rows, testId }: { rows: readonly FocusedRow[]; testId?: string }) {
  const { t } = useI18n();
  return (
    <pre
      className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-2 text-xs leading-relaxed"
      data-testid={testId}
    >
      {rows.map((row, index) =>
        row.type === "gap" ? (
          <code
            key={`gap-${index}`}
            className="block text-muted-foreground italic"
            data-diff-gap={row.count}
          >
            {`⋯ ${t("diff.unchangedLines", { count: row.count })}`}
          </code>
        ) : (
          <code
            key={`${row.type}-${index}-${row.text}`}
            className={cn("block whitespace-pre-wrap", LINE_STYLE[row.type])}
            data-diff-line={row.type}
          >
            {LINE_PREFIX[row.type]} {row.text}
          </code>
        ),
      )}
    </pre>
  );
}

export function DiffCard({
  targetLabel,
  before,
  after,
  lines: streamed,
  rows,
  changeShownAbove = false,
  changedPaths,
  driftSummary,
  patch,
  fixtureAvailable,
  dryRun,
  dryRunPending,
  embedded = false,
  testId,
}: DiffCardProps) {
  const { t } = useI18n();
  const view = streamed || rows ? null : selectChangeView({ before, after, patch });
  const lines = rows ?? focusDiff(streamed ?? (view?.kind === "diff" ? view.lines : []));
  const hasDiff = lines.length > 0;
  const patchLines = view?.kind === "patch" ? view.lines : [];

  return (
    <section className={embedded ? "mt-3 border-t pt-3" : "rounded-lg border"} data-testid={testId}>
      {changeShownAbove ? null : (
        <header
          className={
            embedded
              ? "flex flex-wrap items-center gap-2 pb-2"
              : "flex flex-wrap items-center gap-2 border-b px-4 py-2"
          }
        >
          <span className="min-w-0 truncate text-sm font-medium" data-testid={`${testId}-target`}>
            {targetLabel}
          </span>
          {changedPaths?.length ? (
            <Badge variant="secondary" className="font-normal">
              {t("diff.changedPaths", { paths: changedPaths.join(", ") })}
            </Badge>
          ) : null}
        </header>
      )}

      <div className={cn("grid gap-3", !embedded && "p-4", !changeShownAbove && "lg:grid-cols-2")}>
        {changeShownAbove ? null : (
          <div className="min-w-0">
            <p className="mb-1 text-xs font-medium text-muted-foreground">{t("diff.title")}</p>
            {!hasDiff && patchLines.length > 0 ? (
              <div className="grid gap-2" data-testid={`${testId}-patch`}>
                {driftSummary && (
                  <p className="text-xs whitespace-pre-wrap text-muted-foreground">
                    {driftSummary}
                  </p>
                )}
                <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-2 text-xs leading-relaxed">
                  {patchLines.map((line, index) => (
                    <code
                      key={`patch-${index}-${line}`}
                      className={cn("block whitespace-pre-wrap", LINE_STYLE.added)}
                    >
                      + {line}
                    </code>
                  ))}
                </pre>
                <p className="text-xs text-muted-foreground">{t("diff.noSnapshot")}</p>
              </div>
            ) : !hasDiff ? (
              <p className="text-sm text-muted-foreground" data-testid={`${testId}-unchanged`}>
                {t("diff.unchanged")}
              </p>
            ) : (
              <FocusedDiff rows={lines} testId={`${testId}-lines`} />
            )}
          </div>
        )}

        <div className="min-w-0">
          <p className="mb-1 text-xs font-medium text-muted-foreground">{t("diff.checkTitle")}</p>
          {dryRunPending ? (
            <p className="text-sm text-muted-foreground" data-testid={`${testId}-check-pending`}>
              {t("diff.checkRunning")}
            </p>
          ) : dryRun ? (
            <div className="grid gap-2" data-testid={`${testId}-check`}>
              <p
                className={cn(
                  "flex items-center gap-2 text-sm",
                  dryRun.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive",
                )}
              >
                {dryRun.ok ? (
                  <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
                ) : (
                  <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
                )}
                {dryRun.ok ? t("diff.checkPassed") : (dryRun.error ?? t("diff.checkFailed"))}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(
                  dryRun.fixture_source === "recorded"
                    ? "diff.fixtureRecorded"
                    : "diff.fixtureSynthesized",
                )}
              </p>
              {dryRun.value_preview !== undefined && dryRun.value_preview !== null && (
                <pre className="max-h-40 overflow-auto rounded-md border bg-muted/40 p-2 text-xs">
                  {toDiffLines(dryRun.value_preview).join("\n")}
                </pre>
              )}
            </div>
          ) : fixtureAvailable === false ? (
            <p className="text-sm text-muted-foreground" data-testid={`${testId}-check-no-fixture`}>
              {t("diff.checkNoFixture")}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid={`${testId}-check-absent`}>
              {t("diff.checkAbsent")}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
