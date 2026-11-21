import { Badge } from "@ui/atoms/badge";
import { cn } from "@ui/lib/utils";
import { CircleCheck, CircleExclamationPoint } from "lucide-react";
import type { PatchCandidateDryRun } from "@/api/decisions";
import { Section } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import {
  type DiffLine,
  type FocusedRow,
  focusDiff,
  selectChangeView,
  splitSides,
  toDiffLines,
} from "@/lib/line-diff";

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
  added: "bg-emerald-500/10 text-success-ink",
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

const SIDE_FRAME = {
  before: "border-destructive/30 bg-destructive/5",
  after: "border-success/30 bg-success/5",
} as const;

const SIDE_HEADING = {
  before: "text-destructive",
  after: "text-success",
} as const;

const SIDE_LINE: Record<DiffLine["type"], string> = {
  context: "text-muted-foreground",
  removed: "bg-destructive/10 text-destructive",
  added: "bg-success/10 text-success",
};

function VersionSide({
  side,
  rows,
  testId,
}: {
  side: "before" | "after";
  rows: readonly FocusedRow[];
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <div
      className={cn("min-w-0 rounded-md border p-3 text-sm", SIDE_FRAME[side])}
      data-testid={testId}
      data-diff-side={side}
    >
      <p className={cn("mb-1 text-xs font-medium", SIDE_HEADING[side])}>
        {t(side === "before" ? "diff.before" : "diff.after")}
      </p>
      <pre className="max-h-72 overflow-auto text-xs leading-relaxed">
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
              className={cn("block rounded-sm px-1 whitespace-pre-wrap", SIDE_LINE[row.type])}
              data-diff-line={row.type}
            >
              {row.text || " "}
            </code>
          ),
        )}
      </pre>
    </div>
  );
}

export function VersionChange({
  label,
  rows,
  testId,
}: {
  label: string;
  rows: readonly FocusedRow[];
  testId: string;
}) {
  const { t } = useI18n();
  const sides = splitSides(rows);
  return (
    <Section label={label} testId={`${testId}-change`}>
      {rows.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2" data-testid={`${testId}-diff`}>
          <VersionSide side="before" rows={sides.before} testId={`${testId}-before`} />
          <VersionSide side="after" rows={sides.after} testId={`${testId}-after`} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid={`${testId}-unchanged`}>
          {t("knowledge.versions.unchanged")}
        </p>
      )}
    </Section>
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
                  dryRun.ok ? "text-success-ink" : "text-destructive",
                )}
              >
                {dryRun.ok ? (
                  <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
                ) : (
                  <CircleExclamationPoint aria-hidden="true" className="size-4 shrink-0" />
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
