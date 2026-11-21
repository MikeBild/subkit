import { Panel } from "@ui/components/proto/Pill";
import {
  IconTile,
  MiniBars,
  ServiceChips,
  StatusDot,
  StepGraph,
} from "@ui/components/proto/visual";
import {
  Check,
  Cog,
  Database,
  History,
  Loader2,
  PenLine,
  ShieldCheck,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import type { Tone } from "./model";
import { boundaryCounts, graphState, type StepRow } from "./workflow-model";

const KIND_ICON = { read: Database, write: PenLine, compute: Cog } as const;

export function WorkflowStepGraph({ rows }: { rows: StepRow[] }) {
  const { t } = useI18n();
  if (rows.length === 0) return null;
  return (
    <div data-testid="workflow-step-graph">
      <Panel>
        <StepGraph
          label={t("ops.steps")}
          steps={rows.map((row) => ({
            label: row.label,
            icon: KIND_ICON[row.kind],
            state: graphState(row.state),
            sub: <ServiceChips refs={[...row.reads, ...row.writes]} />,
          }))}
        />
      </Panel>
    </div>
  );
}

function StepMark({ row, index }: { row: StepRow; index: number }) {
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs",
        row.state === "failed" && "border-destructive text-destructive-ink",
      )}
    >
      {row.state === "done" ? (
        <Check className="size-3.5" aria-hidden />
      ) : row.state === "active" ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : row.state === "failed" ? (
        <X className="size-3.5" aria-hidden />
      ) : (
        index + 1
      )}
    </span>
  );
}

export function WorkflowStepsPanel({ rows, action }: { rows: StepRow[]; action?: ReactNode }) {
  const { t, tn } = useI18n();
  const counts = boundaryCounts(rows);
  const nothing = t("ops.wf.nothing");
  return (
    <div data-testid="workflow-steps-panel">
      <Panel>
        <div className="mb-3 flex items-center gap-3">
          <IconTile icon={WorkflowIcon} size="sm" />
          <p className="flex-1 font-semibold">{t("ops.steps")}</p>
          {action}
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("ops.wf.noSteps")}</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {rows.map((row, index) => (
              <li key={row.id} className="flex gap-3" data-testid={`workflow-step-row-${index}`}>
                <StepMark row={row} index={index} />
                <div className="flex-1 text-sm">
                  <div className="font-medium">{row.label}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t("ops.wf.reads")}:{" "}
                    <span className="font-mono">{row.reads.join(", ") || nothing}</span> ·{" "}
                    {t("ops.wf.writes")}:{" "}
                    <span className="font-mono">{row.writes.join(", ") || nothing}</span>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
        <div className="mt-4 rounded-lg bg-secondary p-3 text-sm" data-testid="workflow-boundary">
          <div className="flex items-center gap-3 font-medium">
            <IconTile icon={ShieldCheck} size="sm" variant="outline" />
            <span>
              {t("ops.boundary")}:{" "}
              <span className="font-mono">
                {[
                  tn("ops.boundary.reads", counts.reads),
                  tn("ops.boundary.writes", counts.writes),
                  tn("ops.boundary.services", counts.services),
                ].join(" · ")}
              </span>
            </span>
          </div>
          <ServiceChips
            className="mt-3"
            refs={rows.flatMap((row) => [...row.reads, ...row.writes])}
          />
        </div>
      </Panel>
    </div>
  );
}

export interface ApprovalRow {
  label: string;
  value: ReactNode;
}

export function CurrentApprovalBody({
  rows,
  used,
  children,
}: {
  rows: ApprovalRow[] | null;
  used: string | null;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3" data-testid="workflow-current-approval">
      {rows ? (
        <>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {rows.map((row) => (
              <div key={row.label} className="contents">
                <span className="text-muted-foreground">{row.label}</span>
                <span className="min-w-0">{row.value}</span>
              </div>
            ))}
          </div>
          {used ? (
            <p className="text-xs text-muted-foreground" data-testid="workflow-runs-used">
              {used}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t("ops.wf.noApproval")}</p>
      )}
      {children}
    </div>
  );
}

export interface HistoryRun {
  id: string;
  tone: Tone;
  pulse: boolean;
  label: string;
  time: string;
  href: string;
  onOpen?: () => void;
}

export function WorkflowHistoryPanel({
  durations,
  runs,
  more,
}: {
  durations: number[];
  runs: HistoryRun[];
  more?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div data-testid="workflow-history-panel">
      <Panel>
        <div className="mb-3 flex items-center gap-3">
          <IconTile icon={History} size="sm" />
          <p className="flex-1 font-semibold">{t("workflowPage.tab.history")}</p>
          {more}
        </div>
        {durations.length > 1 ? (
          <>
            <p className="mb-2 text-xs text-muted-foreground">{t("ops.durations")}</p>
            <MiniBars className="mb-3" label={t("ops.durations")} data={durations} />
          </>
        ) : null}
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("ops.recent.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {runs.map((run) => (
              <li key={run.id}>
                <a
                  href={run.href}
                  onClick={(event) => {
                    if (
                      !run.onOpen ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.button !== 0
                    )
                      return;
                    event.preventDefault();
                    run.onOpen();
                  }}
                  className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-secondary"
                  data-testid={`workflow-history-run-${run.id}`}
                >
                  <StatusDot tone={run.tone} pulse={run.pulse} />
                  <span className="flex-1">{run.label}</span>
                  <span className="font-mono text-xs text-muted-foreground">{run.time}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export function CurrentApprovalPanel({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div data-testid="workflow-approval-panel">
      <Panel>
        <div className="mb-3 flex items-center gap-3">
          <IconTile icon={ShieldCheck} size="sm" />
          <p className="font-semibold">{t("ops.wf.current")}</p>
        </div>
        {children}
      </Panel>
    </div>
  );
}
