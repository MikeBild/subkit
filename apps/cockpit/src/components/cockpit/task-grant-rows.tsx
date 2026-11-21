import { useQuery } from "@tanstack/react-query";
import { Pill } from "@ui/components/proto/Pill";
import {
  BookOpen,
  ChevronRight,
  type LucideIcon,
  PenLine,
  Play,
  Plug,
  TriangleExclamationPoint,
} from "lucide-react";
import { useState } from "react";
import { apiCall } from "@/api/call";
import { absolute, workflowHref, workflowSectionHref } from "@/app/links";
import { useSession } from "@/app/session";
import { useConnectorNames, useConnectorServices } from "@/components/cockpit/connector-names";
import { GrantEffectReview } from "@/components/cockpit/grant-effect-review";
import { RowsSkeleton } from "@/components/cockpit/patterns";
import {
  blockedNotice,
  type EffectWord,
  type TaskGrantBlockReason,
  type TaskGrantRow,
  type WorkflowRow,
  type WorkflowStanding,
} from "@/components/cockpit/task-grant-model";
import { authorityProblems } from "@/lib/authority-issues";
import { authorityReviewModel } from "@/lib/authority-review-model";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";

const VERB_ICONS: Record<TaskGrantRow["verb"], LucideIcon> = {
  read: BookOpen,
  write: PenLine,
  use: Plug,
  start: Play,
};

const VERB_KEYS = {
  read: "taskGrant.verb.read",
  write: "taskGrant.verb.write",
  use: "taskGrant.verb.use",
  start: "taskGrant.verb.start",
} as const satisfies Record<TaskGrantRow["verb"], TranslationKey>;

const WORD_KEYS = {
  read: "taskGrant.effect.read",
  write: "taskGrant.effect.write",
  delete: "taskGrant.effect.delete",
  unknown: "taskGrant.effect.unknown",
} as const satisfies Record<EffectWord, TranslationKey>;

const STANDING_KEYS = {
  covered: "taskGrant.standing.covered",
  co_granted: "taskGrant.standing.coGranted",
  asks: "taskGrant.standing.asks",
  unavailable: "taskGrant.standing.unavailable",
} as const satisfies Record<Exclude<WorkflowStanding, "included">, TranslationKey>;

const REASON_KEYS = {
  workflow_missing: "taskGrant.reason.workflow_missing",
  workflow_not_active: "taskGrant.reason.workflow_not_active",
  workflow_sensitive: "taskGrant.reason.workflow_sensitive",
  workflow_not_repeatable: "taskGrant.reason.workflow_not_repeatable",
  workflow_permission_missing: "taskGrant.reason.workflow_permission_missing",
  workflow_not_readable: "taskGrant.reason.workflow_not_readable",
} as const satisfies Record<TaskGrantBlockReason, TranslationKey>;

const WARN = "text-warning-ink";
const ROW = "flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm";
const VERB = "flex w-24 shrink-0 items-center gap-2 text-muted-foreground";
const LINK = "underline underline-offset-4";

export type TaskGrantRowsMode = "review" | "standing";

function Verb({ verb }: { verb: TaskGrantRow["verb"] }) {
  const { t } = useI18n();
  const Icon = VERB_ICONS[verb];
  return (
    <span className={VERB}>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {t(VERB_KEYS[verb])}
    </span>
  );
}

function StandingChip({ standing, testId }: { standing: WorkflowStanding; testId: string }) {
  const { t } = useI18n();
  if (standing === "included") return null;
  return (
    <span className="contents" data-testid={testId} data-standing={standing}>
      <Pill tone={standing === "asks" || standing === "unavailable" ? "warning" : "success"}>
        {t(STANDING_KEYS[standing])}
      </Pill>
    </span>
  );
}

function useSummaryText(row: WorkflowRow): string {
  const { t } = useI18n();
  if (!row.manifest) return "";
  return row.summary.length === 0
    ? t("taskGrant.effect.none")
    : row.summary.map((entry) => t(WORD_KEYS[entry.word], { name: entry.name })).join(", ");
}

function WorkflowReviewRow({ row, index }: { row: WorkflowRow; index: number }) {
  const { t } = useI18n();
  const connectorNames = useConnectorNames();
  const connectorServices = useConnectorServices();
  const summary = useSummaryText(row);
  const name = row.name ?? t("taskGrant.workflow.unnamed");
  const head = (
    <>
      <Verb verb="start" />
      <span className="min-w-0 truncate font-medium">{name}</span>
      <span className="min-w-0 flex-1 text-muted-foreground">{summary}</span>
      <StandingChip standing={row.standing} testId={`task-grant-standing-${index}`} />
    </>
  );
  if (!row.manifest || row.manifest.effects.length === 0)
    return (
      <li className={ROW} data-testid={`task-grant-row-${index}`} data-verb="start">
        {head}
      </li>
    );
  const model = authorityReviewModel({
    preview: { manifest: row.manifest, approval_carries_over: false, schedules: [] },
    connectorNames,
    connectorServices,
    automation: { schedule: false, webhook: false },
    activation: false,
    carryOver: false,
  });
  return (
    <li data-testid={`task-grant-row-${index}`} data-verb="start">
      <details className="group/task">
        <summary
          className={cn(
            ROW,
            "cursor-pointer list-none rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden",
          )}
          data-testid={`task-grant-row-toggle-${index}`}
        >
          {head}
          <ChevronRight
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground transition-transform group-open/task:rotate-90 motion-reduce:transition-none"
          />
        </summary>
        <div className="px-3 pb-3">
          <GrantEffectReview
            model={model}
            growth={undefined}
            problems={[]}
            loading={false}
            toolPinsCompared={false}
          />
        </div>
      </details>
    </li>
  );
}

function WorkflowStandingRow({
  row,
  index,
  live,
}: {
  row: WorkflowRow;
  index: number;
  live: boolean;
}) {
  const { t, tn, dateTime } = useI18n();
  const summary = useSummaryText(row);
  const linked = row.reason !== "workflow_missing" && row.reason !== "workflow_not_readable";
  const standing: WorkflowStanding = live && row.standing === "included" ? "asks" : row.standing;
  const approval = row.approval
    ? [
        row.approval.validUntil === null
          ? t("taskPermissions.approval.untilRevoked")
          : t("taskPermissions.approval.until", { date: dateTime(row.approval.validUntil) }),
        ...(row.approval.remainingRuns === null
          ? []
          : [tn("taskPermissions.remaining", row.approval.remainingRuns)]),
      ].join(" · ")
    : null;
  return (
    <li className={ROW} data-testid={`task-grant-row-${index}`} data-verb="start">
      <Verb verb="start" />
      {linked ? (
        <a
          href={absolute(workflowHref(row.workflowId))}
          className={cn(LINK, "min-w-0 truncate font-medium")}
          data-testid={`task-grant-workflow-${index}`}
        >
          {row.name ?? t("taskGrant.workflow.unnamed")}
        </a>
      ) : (
        <span className="min-w-0 truncate font-medium">
          {row.name ?? t("taskGrant.workflow.unnamed")}
        </span>
      )}
      <span className="min-w-0 flex-1 text-muted-foreground">{summary}</span>
      {approval ? (
        <a
          href={absolute(workflowSectionHref(row.workflowId, "approvals"))}
          className={cn(LINK, "text-muted-foreground")}
          data-testid={`task-grant-approval-${index}`}
        >
          {approval}
        </a>
      ) : null}
      <StandingChip
        standing={standing === "covered" ? "included" : standing}
        testId={`task-grant-standing-${index}`}
      />
    </li>
  );
}

export function TaskGrantRows({
  rows,
  mode,
  live = false,
  testId,
}: {
  rows: readonly TaskGrantRow[];
  mode: TaskGrantRowsMode;
  live?: boolean;
  testId: string;
}) {
  const { t } = useI18n();
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground" data-testid={`${testId}-empty`}>
        {t("taskGrant.nothingBound")}
      </p>
    );
  return (
    <ul
      aria-label={t("taskGrant.list")}
      className="flex min-w-0 flex-col divide-y rounded-md border"
      data-testid={testId}
    >
      {rows.map((row, index) =>
        row.kind === "workflow" ? (
          mode === "review" ? (
            <WorkflowReviewRow key={row.key} row={row} index={index} />
          ) : (
            <WorkflowStandingRow key={row.key} row={row} index={index} live={live} />
          )
        ) : (
          <li
            key={row.key}
            className={ROW}
            data-testid={`task-grant-row-${index}`}
            data-verb={row.verb}
          >
            <Verb verb={row.verb} />
            <span className="min-w-0 flex-1 truncate font-medium">
              {row.kind === "web"
                ? t("taskGrant.webSearch")
                : (row.name ?? t("taskGrant.connector.unnamed"))}
            </span>
          </li>
        ),
      )}
    </ul>
  );
}

export interface BlockedWorkflow {
  key: string;
  workflowId: string;
  versionId: string | null;
  name: string | null;
  standing: WorkflowStanding;
  reason: TaskGrantBlockReason | null;
}

function StepReasons({
  workflowId,
  versionId,
  environment,
  index,
}: {
  workflowId: string;
  versionId: string;
  environment: "dev" | "prod";
  index: number;
}) {
  const { t } = useI18n();
  const session = useSession();
  const preview = useQuery({
    queryKey: ["task-grant-workflow", workflowId, versionId, environment],
    enabled: session.permissions.includes("workflow:read"),
    queryFn: () =>
      apiCall("get", "/v1/workflows/{id}/versions/{version_id}/authority-preview", {
        path: { id: workflowId, version_id: versionId },
        query: { environment },
      }),
  });
  if (preview.isPending && preview.fetchStatus !== "idle")
    return <RowsSkeleton count={1} testId={`task-grant-steps-loading-${index}`} />;
  const problems = authorityProblems(preview.data, t);
  if (problems.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs" data-testid={`task-grant-steps-${index}`}>
      {problems.map((problem) => (
        <li key={problem}>{problem}</li>
      ))}
    </ul>
  );
}

export function TaskGrantBlocked({
  blocked,
  environment,
  links,
  testId,
}: {
  blocked: readonly BlockedWorkflow[];
  environment: "dev" | "prod";
  links: boolean;
  testId: string;
}) {
  const { t } = useI18n();
  const [opened, setOpened] = useState(false);
  const notice = blockedNotice(blocked);
  if (!notice) return null;
  const quoted = (name: string | null) =>
    name === null ? t("taskGrant.workflow.unnamed") : t("taskGrant.quoted", { name });
  return (
    <div className={cn("flex flex-col text-sm", WARN)} role="note" data-testid={testId}>
      <p className="flex items-start gap-2">
        <TriangleExclamationPoint aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span data-testid={`${testId}-sentence`}>
          {"count" in notice
            ? t(notice.key, { count: notice.count })
            : t(notice.key, { name: quoted(notice.name) })}
        </span>
      </p>
      <details
        className="group/why pl-6"
        onToggle={(event) => setOpened(event.currentTarget.open)}
        data-testid={`${testId}-why`}
      >
        <summary
          className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring underline underline-offset-4 [&::-webkit-details-marker]:hidden"
          data-testid={`${testId}-why-toggle`}
        >
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 transition-transform group-open/why:rotate-90 motion-reduce:transition-none"
          />
          {t("taskGrant.why")}
        </summary>
        <ul className="flex flex-col gap-3 pb-2 text-foreground">
          {blocked.map((entry, index) => (
            <li
              key={entry.key}
              className="flex flex-col gap-1"
              data-testid={`${testId}-reason-${index}`}
            >
              <span className="font-medium">{entry.name ?? t("taskGrant.workflow.unnamed")}</span>
              <span>{t(REASON_KEYS[entry.reason ?? "workflow_not_repeatable"])}</span>
              {opened && entry.reason === "workflow_not_repeatable" && entry.versionId ? (
                <StepReasons
                  workflowId={entry.workflowId}
                  versionId={entry.versionId}
                  environment={environment}
                  index={index}
                />
              ) : null}
              {!links ||
              entry.reason === "workflow_missing" ||
              entry.reason === "workflow_not_readable" ? null : (
                <a
                  href={absolute(workflowHref(entry.workflowId))}
                  className={cn(LINK, "w-fit")}
                  data-testid={`${testId}-open-${index}`}
                >
                  {t("taskGrant.openWorkflow")}
                </a>
              )}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
