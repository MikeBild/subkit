import { CircleAlert, CircleCheck } from "lucide-react";
import type { PatchCandidateDryRun } from "@/api/decisions";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n-context";
import { computeLineDiff, type DiffLine, isUnchanged, toDiffLines } from "@/lib/line-diff";
import { cn } from "@/lib/utils";

export interface DiffCardProps {
  /** Object · version, resolved by the caller — never an id. */
  targetLabel: string;
  before: unknown;
  after: unknown;
  changedPaths?: readonly string[];
  dryRun?: PatchCandidateDryRun | null;
  dryRunPending?: boolean;
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

export function DiffCard({
  targetLabel,
  before,
  after,
  changedPaths,
  dryRun,
  dryRunPending,
  testId,
}: DiffCardProps) {
  const { t } = useI18n();
  const lines = computeLineDiff(toDiffLines(before), toDiffLines(after));
  const unchanged = lines.length === 0 || isUnchanged(lines);

  return (
    <section className="rounded-lg border" data-testid={testId}>
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="min-w-0 truncate text-sm font-medium" data-testid={`${testId}-target`}>
          {targetLabel}
        </span>
        {changedPaths?.length ? (
          <Badge variant="secondary" className="font-normal">
            {t("diff.changedPaths", { paths: changedPaths.join(", ") })}
          </Badge>
        ) : null}
      </header>

      <div className="grid gap-3 p-3 lg:grid-cols-2">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-medium text-muted-foreground">{t("diff.title")}</p>
          {unchanged ? (
            <p className="text-sm text-muted-foreground" data-testid={`${testId}-unchanged`}>
              {t("diff.unchanged")}
            </p>
          ) : (
            <pre
              className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-2 text-xs leading-relaxed"
              data-testid={`${testId}-lines`}
            >
              {lines.map((line, index) => (
                <code
                  key={`${line.type}-${index}-${line.text}`}
                  className={cn("block whitespace-pre-wrap", LINE_STYLE[line.type])}
                >
                  {LINE_PREFIX[line.type]} {line.text}
                </code>
              ))}
            </pre>
          )}
        </div>

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
