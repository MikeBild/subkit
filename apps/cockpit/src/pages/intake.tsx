import {
  CATEGORIES_KEY,
  CLIPS_KEY,
  DEFAULT_CATEGORY_KEY,
  invalidateIntake,
} from "./intake-queries";

export {
  CATEGORIES_KEY,
  CLIPS_KEY,
  DEFAULT_CATEGORY_KEY,
  invalidateIntake,
} from "./intake-queries";

import { IntakeDefaultCategoryDialog, IntakeNoteDialog } from "./intake-dialogs";

export { IntakeEditDialog } from "./intake-dialogs";
export { loadSkillBinding, ProposalCard } from "./intake-proposal";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import {
  ArrowRight,
  Bookmark,
  MessageSquareText,
  PenLine,
  Puzzle,
  StickyNote,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/api/client";
import {
  deleteDiscardedIntakeClip,
  getIntakeDefaultCategory,
  type IntakeClip,
  type IntakeSnapshot,
  listIntakeCategories,
  listIntakeClips,
  setIntakeDefaultCategory,
} from "@/api/intake";
import { absolute, chatNewHref, docsHref, recordHref } from "@/app/links";
import { CatalogCategories } from "@/components/cockpit/catalog-categories";
import {
  CatalogCategoryChips,
  catalogCategoryGrouping,
} from "@/components/cockpit/catalog-grouping";
import {
  ActionMenu,
  type ActionMenuItem,
  Button,
  Chip,
  type CockpitColumn,
  ConfirmDialog,
  DataState,
  DataTable,
  FilterBar,
  type FilterSelect,
  GroupingTabs,
  IconTile,
  type IconTileSize,
  OnboardingFrame,
  Page,
  PageHeader,
  rowsByGroup,
  SectionHeading,
  StatusBadge,
  SummaryLine,
  SummaryParts,
  type TableSelection,
} from "@/components/cockpit/patterns";
import { AssistantIcon } from "@/components/cockpit/service-icon";
import { tableColumns } from "@/components/cockpit/table-columns";
import { ForbiddenState } from "@/components/failure-state";
import { useI18n } from "@/lib/i18n-context";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useSearchParamState, writeSearchParam } from "@/lib/use-search-param-state";
import { cn } from "@/lib/utils";
import { humanizeCategory, UNCATEGORIZED } from "@/lib/workflow-category";
import {
  INTAKE_ORIGINS,
  INTAKE_STATES,
  type IntakeOrigin,
  intakeAssistant,
  intakeAwaitingAssistantReview,
  intakeCategoryFromSearch,
  intakeChatPrompt,
  intakeNeedsAssistantReview,
  intakeOrigin,
  intakeOriginLabel,
  intakeOriginLabelKey,
  intakeStateLabelKey,
  sessionSnapshot,
} from "./intake-model";

const INTAKE_WAYS = [
  { key: "clipper", icon: Puzzle, href: docsHref("web-clipper") },
  { key: "session", icon: MessageSquareText, href: docsHref("use-sk-from-a-coding-agent") },
] as const;

const INTAKE_FLOW = ["collect", "propose", "confirm", "knowledge"] as const;

export function IntakeOriginIcon({
  snapshot,
  tile,
  size = "size-3.5",
}: {
  snapshot: IntakeSnapshot;
  tile?: IconTileSize;
  size?: string;
}) {
  const session = sessionSnapshot(snapshot);
  if (session)
    return (
      <AssistantIcon
        mark={intakeAssistant(session).mark}
        tile={tile}
        {...(tile ? {} : { className: size })}
      />
    );
  const Icon = intakeOrigin(snapshot) === "note" ? PenLine : Bookmark;
  if (!tile)
    return <Icon aria-hidden="true" className={cn("shrink-0 text-muted-foreground", size)} />;
  return (
    <IconTile size={tile}>
      <Icon />
    </IconTile>
  );
}

export function IntakeOnboarding({ onAddNote }: { onAddNote?: () => void }) {
  const { t } = useI18n();
  return (
    <OnboardingFrame lead={t("intake.onboarding.lead")} testId="intake-onboarding">
      <ul className={onAddNote ? "grid gap-3 sm:grid-cols-3" : "grid gap-3 sm:grid-cols-2"}>
        {INTAKE_WAYS.map((way) => (
          <li key={way.key} className="flex h-full flex-col gap-2 rounded-lg border p-4">
            <IconTile>
              <way.icon />
            </IconTile>
            <span className="text-sm font-medium">{t(`intake.onboarding.${way.key}.title`)}</span>
            <span className="flex-1 text-xs text-muted-foreground">
              {t(`intake.onboarding.${way.key}.line`)}
            </span>
            <Button variant="outline" size="sm" className="w-fit" asChild>
              <a href={absolute(way.href)} data-testid={`intake-onboarding-${way.key}`}>
                {t(`intake.onboarding.${way.key}.action`)}
              </a>
            </Button>
          </li>
        ))}
        {onAddNote ? (
          <li className="flex h-full flex-col gap-2 rounded-lg border p-4">
            <IconTile>
              <StickyNote />
            </IconTile>
            <span className="text-sm font-medium">{t("intake.onboarding.note.title")}</span>
            <span className="flex-1 text-xs text-muted-foreground">
              {t("intake.onboarding.note.line")}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={onAddNote}
              data-testid="intake-onboarding-note"
            >
              {t("intake.onboarding.note.action")}
            </Button>
          </li>
        ) : null}
      </ul>
      <section
        className="rounded-lg border p-4"
        aria-labelledby="intake-onboarding-flow"
        data-testid="intake-onboarding-flow"
      >
        <SectionHeading id="intake-onboarding-flow">{t("intake.onboarding.flow")}</SectionHeading>
        <ol className="mt-3 flex flex-col gap-3 text-sm sm:flex-row sm:items-center">
          {INTAKE_FLOW.map((step, index) => (
            <li key={step} className="flex items-center gap-2">
              <span className="inline-grid size-6 shrink-0 place-items-center rounded-full border text-xs font-medium tabular-nums">
                {index + 1}
              </span>
              {t(`intake.onboarding.flow.${step}`)}
              {index < INTAKE_FLOW.length - 1 ? (
                <ArrowRight
                  aria-hidden="true"
                  className="ml-2 hidden size-4 text-muted-foreground sm:inline-block"
                />
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </OnboardingFrame>
  );
}

export function IntakePage({ permissions }: { permissions: readonly string[] }) {
  const { t, dateTime } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const intakeSearch = useRouterState({ select: (router) => router.location.search });
  const requestedCategory = intakeCategoryFromSearch(intakeSearch);
  const canRead = permissions.includes("intake:read");
  const canWrite = permissions.includes("intake:write");
  const canChat = permissions.includes("conversation:write");
  const [category, setCategoryState] = useState<string | "all" | null>(requestedCategory);
  useEffect(() => {
    if (requestedCategory !== null) setCategoryState(requestedCategory);
  }, [requestedCategory]);
  const setCategory = (next: string | "all" | null) => {
    setCategoryState(next);
    writeSearchParam("category", next, "");
  };
  const [sorting, setSorting] = useState<SortingState>([{ id: "captured_at", desc: true }]);
  const [search, setSearch] = useSearchParamState("q", "");
  const needle = useDebouncedValue(search).trim().toLowerCase();
  const [groupMode, setGroupMode] = useSearchParamState("group", "all");
  const [settingDefaultCategory, setSettingDefaultCategory] = useState(false);
  const [addingNote, setAddingNote] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [deleteTargets, setDeleteTargets] = useState<IntakeClip[]>([]);
  const [deletePending, setDeletePending] = useState(false);
  const [state, setState] = useSearchParamState<"all" | (typeof INTAKE_STATES)[number]>(
    "state",
    "all",
    (value): value is (typeof INTAKE_STATES)[number] =>
      (INTAKE_STATES as readonly string[]).includes(value),
  );
  const [origin, setOrigin] = useSearchParamState<"all" | IntakeOrigin>(
    "origin",
    "all",
    (value): value is IntakeOrigin => (INTAKE_ORIGINS as readonly string[]).includes(value),
  );
  const categories = useQuery({
    queryKey: CATEGORIES_KEY,
    queryFn: listIntakeCategories,
    enabled: canRead,
  });
  const defaultCategory = useQuery({
    queryKey: DEFAULT_CATEGORY_KEY,
    queryFn: getIntakeDefaultCategory,
    enabled: canRead,
  });
  const effectiveCategory =
    category === "all" ? undefined : (category ?? defaultCategory.data?.category);
  const clips = useQuery({
    queryKey: [...CLIPS_KEY, effectiveCategory, state],
    queryFn: () =>
      listIntakeClips({
        ...(effectiveCategory ? { category: effectiveCategory } : {}),
        ...(state === "all" ? {} : { state }),
      }),
    enabled: canRead,
  });
  const categoryClips = useQuery({
    queryKey: [...CLIPS_KEY, effectiveCategory, "all"],
    queryFn: () => listIntakeClips(effectiveCategory ? { category: effectiveCategory } : {}),
    enabled: canRead && state !== "all",
  });
  const categoryValues = useMemo(
    () => [
      ...new Set([
        ...(defaultCategory.data ? [defaultCategory.data.category] : []),
        ...(categories.data?.categories.map((item) => item.category) ?? []),
      ]),
    ],
    [categories.data, defaultCategory.data],
  );
  const awaitingReview = intakeAwaitingAssistantReview(
    (state === "all" ? clips.data?.items : categoryClips.data?.items) ?? [],
  );
  const clipItems = (clips.data?.items ?? []).filter(
    (clip) =>
      (origin === "all" || intakeOrigin(clip.original_snapshot) === origin) &&
      (!needle || `${clip.title}\n${clip.body}`.toLowerCase().includes(needle)),
  );
  const selectedDiscarded = clipItems.filter(
    (clip) => clip.state === "discarded" && selectedIds.has(clip.id),
  );
  const discardedCount = clipItems.filter((clip) => clip.state === "discarded").length;
  const deleteSelection: TableSelection<IntakeClip> | undefined =
    canWrite && discardedCount > 0
      ? {
          selected: selectedIds,
          onChange: setSelectedIds,
          canSelect: (clip) => clip.state === "discarded",
          rowLabel: (clip) => t("intake.selectDiscarded", { title: clip.title }),
          allLabel: t("intake.deleteSelectedObject", { count: discardedCount }),
          bar:
            selectedDiscarded.length > 0 ? (
              <div
                className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                data-testid="intake-delete-bulk-bar"
              >
                <span className="me-auto font-medium">
                  {t("intake.deleteSelectedObject", { count: selectedDiscarded.length })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDeleteTargets(selectedDiscarded)}
                  data-testid="intake-delete-selected"
                >
                  {t("intake.deleteSelected", { count: selectedDiscarded.length })}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedIds(new Set())}
                  data-testid="intake-delete-clear-selection"
                >
                  {t("intake.clearDeletionSelection")}
                </Button>
              </div>
            ) : undefined,
        }
      : undefined;
  const loadedCategoryCounts = new Map(
    [...rowsByGroup(clipItems, (clip) => clip.category || UNCATEGORIZED)].map(
      ([key, members]) => [key, members.length] as const,
    ),
  );
  const categoryUsage = categoryValues
    .map((item) => ({
      category: item,
      count:
        categories.data?.categories.find((entry) => entry.category === item)?.counts?.intake ?? 0,
    }))
    .filter((entry) => entry.count > 0 || entry.category === defaultCategory.data?.category);
  const write = useMutation({
    mutationFn: async (run: () => Promise<unknown>) => run(),
    onSuccess: async () => {
      await invalidateIntake(queryClient);
    },
    onError: (error) =>
      toast.error(
        t(
          error instanceof ApiError && error.status === 409
            ? "intake.proposal.confirmConflict"
            : "common.actionFailed",
        ),
      ),
  });
  if (!canRead)
    return (
      <Page
        kind="list"
        surface="collection"
        scroll="page"
        testId="intake-page"
        header={<PageHeader title={t("nav.inbox")} />}
      >
        <ForbiddenState />
      </Page>
    );
  const loading =
    categories.isPending ||
    defaultCategory.isPending ||
    clips.isPending ||
    (state !== "all" && categoryClips.isPending);
  const failed = Boolean(
    categories.error ||
      defaultCategory.error ||
      clips.error ||
      (state !== "all" && categoryClips.error),
  );
  const menuItems: ActionMenuItem[] = [
    ...(canChat
      ? [
          {
            label: t("intake.reviewChat"),
            href: absolute(chatNewHref({ prompt: intakeChatPrompt(effectiveCategory ?? "", t) })),
            testId: "intake-review-chat",
          },
        ]
      : []),
    ...(canWrite
      ? [
          {
            label: t("intake.chooseDefault"),
            onSelect: () => setSettingDefaultCategory(true),
            testId: "intake-category-default",
          },
        ]
      : []),
  ];
  const untouched = category === null && state === "all" && origin === "all" && !needle;
  const onboarding =
    !loading &&
    !failed &&
    untouched &&
    clipItems.length === 0 &&
    (categories.data?.categories ?? []).every((entry) => !entry.counts?.intake);
  const addButton = (testId: string) =>
    canWrite ? (
      <Button onClick={() => setAddingNote(true)} data-testid={testId}>
        {t("intake.add")}
      </Button>
    ) : undefined;
  const clipColumns = (() => {
    const column = tableColumns<IntakeClip>({ t, dateTime });
    return [
      column.custom(
        "title",
        (clip) => clip.title,
        t("knowledge.column.name"),
        (clip) => (
          <span className="flex min-w-0 items-center gap-3">
            <IntakeOriginIcon snapshot={clip.original_snapshot} tile="md" />
            <span className="truncate font-medium">{clip.title}</span>
          </span>
        ),
        { sortable: true, width: "w-[30%]" },
      ),
      column.custom(
        "origin",
        (clip) => intakeOrigin(clip.original_snapshot),
        t("intake.origin"),
        (clip) => (
          <Chip testId={`intake-origin-${clip.id}`}>
            <IntakeOriginIcon snapshot={clip.original_snapshot} size="size-3" />
            {intakeOriginLabel(clip.original_snapshot, t)}
          </Chip>
        ),
        { width: "w-[12%]" },
      ),
      column.custom(
        "category",
        (clip) => clip.category,
        t("intake.category"),
        (clip) => humanizeCategory(clip.category, t("catalog.categoryOther")),
        { sortable: true, width: "w-[15%]" },
      ),
      column.custom(
        "state",
        (clip) => clip.state,
        t("resource.field.status"),
        (clip) => <StatusBadge state={clip.state} label={t(intakeStateLabelKey(clip.state))} />,
        { width: "w-[15%]" },
      ),
      column.date(
        "captured_at",
        (clip) => clip.original_snapshot.captured_at,
        t("resource.field.createdAt"),
        { width: "w-[18%]" },
      ),
    ] satisfies CockpitColumn<IntakeClip>[];
  })();
  return (
    <Page
      kind="list"
      surface="collection"
      scroll="page"
      testId="intake-page"
      header={
        <PageHeader
          title={t("nav.inbox")}
          action={onboarding ? undefined : addButton("intake-add")}
          menu={
            menuItems.length > 0 ? (
              <ActionMenu alwaysMenu testId="intake-page-actions" items={menuItems} />
            ) : undefined
          }
        />
      }
    >
      <div className="flex flex-col gap-6 py-4">
        {canWrite ? (
          <IntakeNoteDialog
            categories={categoryValues}
            initialCategory={effectiveCategory ?? defaultCategory.data?.category}
            open={addingNote}
            onOpenChange={setAddingNote}
            onCreated={(clip) => {
              setAddingNote(false);
              void navigate({ to: recordHref("intake", clip.id) });
            }}
          />
        ) : null}
        <IntakeDefaultCategoryDialog
          category={defaultCategory.data?.category}
          initialCategory={effectiveCategory}
          categories={categoryValues}
          open={settingDefaultCategory}
          onOpenChange={setSettingDefaultCategory}
          onSave={(next) =>
            write.mutate(() => setIntakeDefaultCategory(next), {
              onSuccess: () => {
                setCategory(next);
                setSettingDefaultCategory(false);
              },
            })
          }
        />
        <ConfirmDialog
          open={deleteTargets.length > 0}
          onOpenChange={(next) => {
            if (!next) setDeleteTargets([]);
          }}
          object={
            deleteTargets.length === 1
              ? (deleteTargets[0]?.title ?? "")
              : t("intake.deleteSelectedObject", { count: deleteTargets.length })
          }
          verb={t("intake.delete")}
          consequence={t(
            deleteTargets.length === 1
              ? "intake.deleteConsequence"
              : "intake.deleteSelectedConsequence",
          )}
          destructive
          pending={deletePending}
          onConfirm={async () => {
            setDeletePending(true);
            const failedIds = new Set<string>();
            let conflict = false;
            let deleted = 0;
            try {
              for (const target of deleteTargets) {
                try {
                  await deleteDiscardedIntakeClip(target.id, target.version);
                  deleted += 1;
                } catch (error) {
                  failedIds.add(target.id);
                  if (error instanceof ApiError && error.status === 409) conflict = true;
                }
              }
              await invalidateIntake(queryClient);
              setSelectedIds(failedIds);
              setDeleteTargets([]);
              if (deleted > 0)
                toast.success(
                  t(deleted === 1 ? "intake.deleteSuccess" : "intake.deleteSelectedSuccess"),
                );
              if (failedIds.size > 0)
                toast.error(t(conflict ? "intake.deleteConflict" : "common.actionFailed"));
            } finally {
              setDeletePending(false);
            }
          }}
          testId="intake-delete-dialog"
        />
        {loading ? <DataState state="loading" testId="intake-loading" /> : null}
        {failed ? (
          <DataState
            state="error"
            line={t("intake.loadFailed")}
            onRetry={() => void invalidateIntake(queryClient)}
            testId="intake-error"
          />
        ) : null}
        {onboarding ? (
          <IntakeOnboarding {...(canWrite ? { onAddNote: () => setAddingNote(true) } : {})} />
        ) : null}
        {!loading && !failed && !onboarding ? (
          <>
            <SummaryLine
              text={
                <SummaryParts
                  parts={[
                    t(clipItems.length === 1 ? "intake.summary.one" : "intake.summary.other", {
                      count: clipItems.length,
                    }),
                    awaitingReview > 0 ? (
                      <button
                        type="button"
                        className="text-left font-medium text-foreground underline-offset-2 hover:underline"
                        onClick={() => setOrigin("session")}
                        data-testid="intake-awaiting-review"
                      >
                        {t(
                          awaitingReview === 1
                            ? "intake.awaitingReview.one"
                            : "intake.awaitingReview.other",
                          { count: awaitingReview },
                        )}
                      </button>
                    ) : null,
                    <CatalogCategories key="categories" kind="intake" />,
                  ]}
                />
              }
              help={t("intake.explanation")}
              testId="intake-summary"
            />
            <DataTable<IntakeClip>
              columns={clipColumns}
              data={clipItems}
              groupingTabs={
                <>
                  <GroupingTabs
                    label={t("common.groupBy")}
                    value={groupMode}
                    onChange={setGroupMode}
                    options={[
                      { value: "all", label: t("common.all") },
                      { value: "category", label: t("intake.category") },
                      { value: "state", label: t("resource.field.status") },
                      { value: "origin", label: t("intake.origin") },
                    ]}
                    testId="intake-grouping"
                  />
                  <CatalogCategoryChips
                    usage={categoryUsage}
                    value={
                      category === "all"
                        ? "all"
                        : (category ?? defaultCategory.data?.category ?? "all")
                    }
                    onChange={(value) => setCategory(value === "all" ? "all" : value)}
                    testId="intake-category-chips"
                  />
                </>
              }
              grouping={
                groupMode === "all"
                  ? undefined
                  : groupMode === "category"
                    ? catalogCategoryGrouping<IntakeClip>({
                        getCategory: (clip) => clip.category || UNCATEGORIZED,
                        otherLabel: t("catalog.categoryOther"),
                        counts: loadedCategoryCounts,
                        needsAttention: intakeNeedsAssistantReview,
                      })
                    : {
                        getKey: (clip) =>
                          groupMode === "state"
                            ? t(intakeStateLabelKey(clip.state))
                            : t(intakeOriginLabelKey(intakeOrigin(clip.original_snapshot))),
                      }
              }
              getRowId={(clip) => clip.id}
              selection={deleteSelection}
              rowActions={
                canWrite && discardedCount > 0
                  ? (clip) =>
                      clip.state === "discarded" ? (
                        <ActionMenu
                          alwaysMenu
                          size="sm"
                          items={[
                            {
                              label: t("intake.delete"),
                              destructive: true,
                              onSelect: () => setDeleteTargets([clip]),
                              testId: `intake-delete-${clip.id}`,
                            },
                          ]}
                        />
                      ) : null
                  : undefined
              }
              toolbar={
                <>
                  <FilterBar
                    search={{
                      value: search,
                      onChange: setSearch,
                      placeholder: t("intake.search"),
                      testId: "intake-search",
                    }}
                    selects={
                      [
                        {
                          value:
                            category === "all"
                              ? "all"
                              : (category ?? defaultCategory.data?.category ?? "all"),
                          onChange: (value) => setCategory(value === "all" ? "all" : value),
                          label: t("intake.category"),
                          testId: "intake-category",
                          options: [
                            { value: "all", label: t("intake.allCategories") },
                            ...categoryValues.map((item) => ({
                              value: item,
                              label: humanizeCategory(item, t("catalog.categoryOther")),
                            })),
                          ],
                        },
                        {
                          value: state,
                          onChange: (value) => setState(value as typeof state),
                          label: t("intake.stateFilter"),
                          testId: "intake-state",
                          options: [
                            { value: "all", label: t("intake.state.all") },
                            ...INTAKE_STATES.map((item) => ({
                              value: item,
                              label: t(intakeStateLabelKey(item)),
                            })),
                          ],
                        },
                        {
                          value: origin,
                          onChange: (value) => setOrigin(value as typeof origin),
                          label: t("intake.originFilter"),
                          testId: "intake-origin",
                          options: [
                            { value: "all", label: t("intake.origin.all") },
                            ...INTAKE_ORIGINS.map((item) => ({
                              value: item,
                              label: t(intakeOriginLabelKey(item)),
                            })),
                          ],
                        },
                      ] satisfies FilterSelect[]
                    }
                    reset={{
                      label: t("catalog.clearFilters"),
                      onClick: () => {
                        setSearch("");
                        setCategory(null);
                        setState("all");
                        setOrigin("all");
                      },
                    }}
                  />
                  {origin === "all" ? null : (
                    <Button
                      variant="secondary"
                      size="sm"
                      title={t("intake.originChipClear")}
                      data-testid="intake-origin-filter-chip"
                      onClick={() => setOrigin("all")}
                    >
                      {t("intake.originChip", { origin: t(intakeOriginLabelKey(origin)) })}
                      <X aria-hidden="true" />
                    </Button>
                  )}
                </>
              }
              pending={false}
              emptyState={{
                zero: {
                  title: t("intake.empty"),
                  ...(canWrite ? { action: addButton("intake-empty-add") } : {}),
                },
                filtered: {
                  title: t("resource.noMatches"),
                  description: t("resource.broaderSearch"),
                  resetLabel: t("catalog.clearFilters"),
                  onReset: () => {
                    setSearch("");
                    setCategory(null);
                    setState("all");
                    setOrigin("all");
                  },
                },
              }}
              hasActiveFilters={!untouched}
              sorting={sorting}
              onSortingChange={setSorting}
              onOpen={(clip) => void navigate({ to: recordHref("intake", clip.id) })}
              rowHref={(clip) => recordHref("intake", clip.id)}
              rowLabel={(clip) => clip.title}
              columnsLabel={t("catalog.columns")}
              actionsLabel={t("common.actions")}
              collectionId="intake-items"
            />
          </>
        ) : null}
      </div>
    </Page>
  );
}
