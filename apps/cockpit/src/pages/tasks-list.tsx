import { useNavigate } from "@tanstack/react-router";
import { listPageFailure } from "@ui/lib/errors";
import { BarChart3, ClipboardCheck, Receipt, Tags } from "lucide-react";
import { useMemo, useState } from "react";
import { taskHref } from "@/app/links";
import {
  Button,
  type CockpitColumn,
  DataTable,
  FilterBar,
  IconTile,
  OnboardingFrame,
  Page,
  PageHeader,
  RowName,
  SegmentedControl,
  StatusBadge,
  SummaryLine,
  SummaryParts,
  TemplateCard,
  TemplateGrid,
} from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import { ForbiddenState } from "@/components/failure-state";
import { cronWords } from "@/lib/cron-words";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useSearchParamState } from "@/lib/use-search-param-state";
import { TaskFormDialog } from "@/pages/tasks-form";
import {
  badgeState,
  displayState,
  isTaskFilter,
  listNextStart,
  listStates,
  matchesFilter,
  stateTone,
  stateWords,
  summaryParts,
  TASK_FILTERS,
  TASK_TEMPLATES,
  type TaskDraft,
  type TaskFilter,
  type TaskRow,
  type TaskTemplate,
  taskCounts,
  taskRows,
} from "@/pages/tasks-model";
import { useTasks } from "@/pages/tasks-queries";

const TEMPLATE_ICONS: Record<TaskTemplate, typeof Receipt> = {
  invoices: Receipt,
  numbers: BarChart3,
  prices: Tags,
};

function TasksOnboarding({ onPick }: { onPick?: (template: TaskTemplate) => void }) {
  const { t } = useI18n();
  return (
    <OnboardingFrame lead={t("tasks.empty.lead")} testId="tasks-onboarding">
      {onPick ? (
        <TemplateGrid>
          {TASK_TEMPLATES.map((template) => {
            const Icon = TEMPLATE_ICONS[template];
            return (
              <TemplateCard
                key={template}
                title={t(`tasks.template.${template}.title`)}
                line={t(`tasks.template.${template}.line`)}
                icons={[<Icon key="icon" />]}
                onSelect={() => onPick(template)}
                testId={`tasks-template-${template}`}
              />
            );
          })}
        </TemplateGrid>
      ) : null}
    </OnboardingFrame>
  );
}

export function TasksPage({ permissions }: { permissions: readonly string[] }) {
  const { t, tn, locale, dateTime } = useI18n();
  const navigate = useNavigate();
  const canRead = permissions.includes("task:read");
  const canWrite = permissions.includes("task:write");
  const [search, setSearch] = useSearchParamState("q", "");
  const [filter, setFilter] = useSearchParamState<TaskFilter>("filter", "all", isTaskFilter);
  const q = useDebouncedValue(search).trim();
  const [creating, setCreating] = useState<{ seed?: Partial<TaskDraft>; round: number } | null>(
    null,
  );
  const [now] = useState(() => Date.now());
  const list = useTasks(q, canRead);
  const tasks = list.data?.items ?? [];
  const all = taskRows(tasks);
  const rows = all.filter((row) => matchesFilter(row, filter));
  const title = t("nav.tasks");

  const columns = useMemo<CockpitColumn<TaskRow>[]>(() => {
    const column = tableColumns<TaskRow>({ t, dateTime });
    return [
      column.custom(
        "name",
        (row) => row.task.name,
        t("tasks.column.name"),
        (row) => (
          <span className="flex min-w-0 items-center gap-3">
            <IconTile size="sm" outline>
              <ClipboardCheck aria-hidden="true" />
            </IconTile>
            <span className="grid min-w-0">
              <span className="min-w-0 truncate">
                <RowName>{row.task.name}</RowName>
              </span>
              <span
                className="min-w-0 truncate text-xs text-muted-foreground"
                data-testid={`task-goal-${row.task.id}`}
              >
                {row.task.goal}
              </span>
            </span>
          </span>
        ),
        { width: "w-[46%]" },
      ),
      column.custom(
        "state",
        (row) => displayState(row.task, row.run),
        t("tasks.column.state"),
        (row) => (
          <span className="flex flex-wrap gap-1">
            {listStates(row.task, row.run).map((state) => (
              <StatusBadge
                key={state}
                state={badgeState(stateTone(state))}
                label={stateWords(state, row.run, { t, time: dateTime })}
              />
            ))}
          </span>
        ),
        { width: "w-[30%]" },
      ),
      column.custom(
        "next",
        (row) => row.task.next_start_at ?? row.task.schedule_cron ?? row.task.schedule_run_at,
        t("tasks.column.next"),
        (row) => {
          const next = listNextStart(row.task, now);
          if (next.kind === "at") return dateTime(next.at);
          if (next.kind === "due") return t(next.line);
          if (next.kind === "cron") return cronWords(next.cron, t, LOCALE_TAGS[locale]);
          if (next.kind === "once") return t("tasks.next.once", { date: dateTime(next.at) });
          return t(next.kind === "done" ? "tasks.next.done" : "tasks.next.manual");
        },
        { width: "w-[24%]" },
      ),
    ];
  }, [t, dateTime, locale, now]);

  if (!canRead)
    return (
      <Page
        kind="list"
        surface="collection"
        scroll="page"
        testId="tasks-page"
        header={<PageHeader title={title} />}
      >
        <ForbiddenState />
      </Page>
    );

  const pending = list.isPending && !list.failureReason;
  const failed = Boolean(list.error || list.failureReason);
  const filtered = Boolean(q) || filter !== "all";
  const empty = !pending && !failed && tasks.length === 0 && !filtered;
  const reset = () => {
    setSearch("");
    setFilter("all");
  };
  const open = (seed?: Partial<TaskDraft>) =>
    setCreating((current) => ({ seed, round: (current?.round ?? 0) + 1 }));

  return (
    <Page
      kind="list"
      surface="collection"
      scroll="content"
      testId="tasks-page"
      failure={listPageFailure({
        failed,
        loaded: list.data !== undefined,
        onRetry: () => void list.refetch(),
        error: list.error ?? list.failureReason,
        collectionId: "tasks",
      })}
      header={
        <PageHeader
          title={title}
          purpose={empty ? undefined : t("tasks.lead")}
          action={
            canWrite ? (
              <Button onClick={() => open()} data-testid="tasks-new">
                {t("tasks.new")}
              </Button>
            ) : undefined
          }
        />
      }
    >
      {empty ? (
        <TasksOnboarding
          onPick={
            canWrite
              ? (template) =>
                  open({
                    goal: t(`tasks.template.${template}.goal`),
                    doneWhen: t(`tasks.template.${template}.doneWhen`),
                    name: t(`tasks.template.${template}.title`),
                    nameEdited: true,
                  })
              : undefined
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <SummaryLine
            loading={pending}
            text={
              <SummaryParts
                parts={summaryParts(taskCounts(all)).map((part) => tn(part.key, part.count))}
              />
            }
            testId="tasks-summary"
          />
          <DataTable
            columns={columns}
            data={rows}
            toolbar={
              <FilterBar
                search={{
                  value: search,
                  onChange: setSearch,
                  placeholder: t("tasks.search"),
                  testId: "tasks-search",
                }}
                segmented={
                  <SegmentedControl
                    label={t("tasks.filter.label")}
                    value={filter}
                    onValueChange={(value) => setFilter(isTaskFilter(value) ? value : "all")}
                    testId="tasks-filter"
                    options={TASK_FILTERS.map((value) => ({
                      value,
                      label: t(`tasks.filter.${value}`),
                      testId: `tasks-filter-${value}`,
                    }))}
                  />
                }
              />
            }
            pending={pending}
            error={
              failed
                ? {
                    title: t("resource.loadFailed", { resource: title }),
                    description: t("resource.loadFailedDescription"),
                    retryLabel: t("session.retry"),
                    onRetry: () => void list.refetch(),
                  }
                : null
            }
            emptyState={{
              zero: { title: t("tasks.empty.none") },
              filtered: {
                title: t("resource.noMatches"),
                description: t("resource.broaderSearch"),
                resetLabel: t("catalog.clearFilters"),
                onReset: reset,
              },
            }}
            hasActiveFilters={filtered}
            sorting={[]}
            onSortingChange={() => undefined}
            getRowId={(row) => row.task.id}
            onOpen={(row) => void navigate({ to: taskHref(row.task.id) })}
            rowHref={(row) => taskHref(row.task.id)}
            rowLabel={(row) => row.task.name}
            columnsLabel={t("catalog.columns")}
            actionsLabel={t("common.actions")}
            pickColumns={false}
            collectionId="tasks"
          />
        </div>
      )}
      {canWrite && creating ? (
        <TaskFormDialog
          key={creating.round}
          open
          onOpenChange={(next) => !next && setCreating(null)}
          seed={creating.seed}
          permissions={permissions}
          onSaved={(task) => void navigate({ to: taskHref(task.id) })}
        />
      ) : null}
    </Page>
  );
}
