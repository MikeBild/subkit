import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { MessageSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import {
  confirmIntakeProposal,
  getIntakeClip,
  getIntakeDefaultCategory,
  type IntakeClip,
  type IntakeProposal,
  listIntakeCategories,
  listIntakeClips,
  listIntakeProposals,
  setIntakeClipState,
  setIntakeDefaultCategory,
  updateIntakeClip,
} from "@/api/intake";
import { absolute, chatNewHref, recordHref } from "@/app/links";
import { CatalogCategories } from "@/components/cockpit/catalog-categories";
import {
  categoryChoices,
  normalizeCategoryInput,
} from "@/components/cockpit/catalog-metadata-model";
import { SelectField, TextAreaField, TextField } from "@/components/cockpit/form-field";
import {
  ActionMenu,
  Button,
  type CockpitColumn,
  CodeBlock,
  CollapsibleSection,
  ConfirmDialog,
  DataState,
  DataTable,
  FactList,
  FilePreview,
  FilterBar,
  type FilterSelect,
  FormDialog,
  Page,
  PageHeader,
  RecordSheet,
  StatusBadge,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import { ForbiddenState } from "@/components/failure-state";
import { useI18n } from "@/lib/i18n-context";
import { humanizeCategory, UNCATEGORIZED } from "@/lib/workflow-category";
import {
  INTAKE_STATES,
  intakeItemChatPrompt,
  intakeStateLabelKey,
  publishedDate,
} from "./intake-model";

const CATEGORIES_KEY = ["intake", "categories"] as const;
const DEFAULT_CATEGORY_KEY = ["intake", "default-category"] as const;
const CLIPS_KEY = ["intake", "clips"] as const;
const NEW_CATEGORY = "__new__";

function invalidateIntake(queryClient: ReturnType<typeof useQueryClient>): Promise<unknown> {
  return queryClient.invalidateQueries({ queryKey: ["intake"] });
}

function IntakeEditDialog({
  clip,
  categories,
  open,
  pending,
  error,
  conflict,
  onReload,
  onOpenChange,
  onSave,
}: {
  clip: IntakeClip | null;
  categories: string[];
  open: boolean;
  pending: boolean;
  error: string | null;
  conflict: boolean;
  onReload(): void;
  onOpenChange(open: boolean): void;
  onSave(
    clip: IntakeClip,
    input: {
      expected_version: number;
      category?: string;
      title?: string;
      body?: string;
      note?: string;
    },
  ): void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(clip?.title ?? "");
  const [body, setBody] = useState(clip?.body ?? "");
  const [choice, setChoice] = useState(clip?.category ?? "");
  const [fresh, setFresh] = useState("");
  useEffect(() => {
    if (!open) return;
    setTitle(clip?.title ?? "");
    setBody(clip?.body ?? "");
    setChoice(clip?.category ?? "");
    setFresh("");
  }, [clip, open]);
  const freshCategory = choice === NEW_CATEGORY ? normalizeCategoryInput(fresh) : null;
  const category = choice === NEW_CATEGORY ? (freshCategory ?? "") : choice;
  const trimmedTitle = title.trim();
  const choices = categoryChoices(categories, clip?.category ?? "").filter(
    (item) => item !== UNCATEGORIZED,
  );
  const changed =
    clip !== null &&
    (trimmedTitle !== clip.title || body !== clip.body || category !== clip.category);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("intake.editItem")}
      submit={{
        label: t("common.save"),
        pending,
        disabled: !clip || !trimmedTitle || !body || !category || !changed,
        testId: "intake-edit-save",
      }}
      onSubmit={() => {
        if (!clip || !trimmedTitle || !body || !category || !changed) return;
        onSave(clip, {
          expected_version: clip.version,
          ...(trimmedTitle !== clip.title ? { title: trimmedTitle } : {}),
          ...(body !== clip.body ? { body } : {}),
          ...(category !== clip.category ? { category } : {}),
        });
      }}
      error={error}
      actions={
        conflict ? (
          <Button
            type="button"
            variant="outline"
            onClick={onReload}
            data-testid="intake-edit-reload"
          >
            {t("settings.reload")}
          </Button>
        ) : undefined
      }
      testId="intake-edit-dialog"
    >
      <TextField
        id="intake-edit-title"
        label={t("resource.field.title")}
        value={title}
        onChange={setTitle}
        error={title && !trimmedTitle ? t("intake.editTitleRequired") : null}
      />
      <TextAreaField
        id="intake-edit-body"
        label={t("knowledge.content")}
        value={body}
        onChange={setBody}
        rows={10}
        error={!body ? t("intake.editBodyRequired") : null}
      />
      <SelectField
        id="intake-edit-category"
        label={t("intake.category")}
        value={choice}
        onChange={setChoice}
        options={[
          ...choices.map((item) => ({
            value: item,
            label: humanizeCategory(item, t("catalog.categoryOther")),
          })),
          { value: NEW_CATEGORY, label: t("catalogMeta.newCategory") },
        ]}
      />
      {choice === NEW_CATEGORY ? (
        <TextField
          id="intake-edit-category-new"
          label={t("catalogMeta.newCategoryName")}
          value={fresh}
          onChange={setFresh}
          error={fresh.trim() && !freshCategory ? t("catalogMeta.invalidCategory") : null}
        />
      ) : null}
    </FormDialog>
  );
}

function IntakeDefaultCategoryDialog({
  category,
  initialCategory,
  categories,
  open,
  onOpenChange,
  onSave,
}: {
  category: string | undefined;
  initialCategory: string | undefined;
  categories: string[];
  open: boolean;
  onOpenChange(open: boolean): void;
  onSave(category: string): void;
}) {
  const { t } = useI18n();
  const [choice, setChoice] = useState(initialCategory ?? category ?? "");
  const [fresh, setFresh] = useState("");
  useEffect(() => {
    if (!open) return;
    setChoice(initialCategory ?? category ?? "");
    setFresh("");
  }, [category, initialCategory, open]);
  const freshCategory = choice === NEW_CATEGORY ? normalizeCategoryInput(fresh) : null;
  const selected = choice === NEW_CATEGORY ? (freshCategory ?? "") : choice;
  const choices = categoryChoices(categories, category ?? "").filter(
    (item) => item !== UNCATEGORIZED,
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("intake.makeDefault")}
      submit={{
        label: t("common.save"),
        disabled: !selected || selected === category,
        testId: "intake-default-category-save",
      }}
      onSubmit={() => {
        if (selected && selected !== category) onSave(selected);
      }}
      testId="intake-default-category-dialog"
    >
      <SelectField
        id="intake-default-category-input"
        label={t("intake.category")}
        value={choice}
        onChange={setChoice}
        options={[
          ...choices.map((item) => ({
            value: item,
            label: humanizeCategory(item, t("catalog.categoryOther")),
          })),
          { value: NEW_CATEGORY, label: t("catalogMeta.newCategory") },
        ]}
      />
      {choice === NEW_CATEGORY ? (
        <TextField
          id="intake-default-category-new"
          label={t("catalogMeta.newCategoryName")}
          value={fresh}
          onChange={setFresh}
          error={fresh.trim() && !freshCategory ? t("catalogMeta.invalidCategory") : null}
        />
      ) : null}
    </FormDialog>
  );
}

function ProposalCard({
  proposal,
  canConfirm,
  onConfirm,
  focused = false,
}: {
  proposal: IntakeProposal;
  canConfirm: boolean;
  onConfirm(): void;
  focused?: boolean;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const targetId =
    "knowledge_source_id" in proposal.revision.target
      ? proposal.revision.target.knowledge_source_id
      : null;
  const target = useQuery({
    queryKey: ["knowledge-source", "intake-target", targetId],
    queryFn: () =>
      apiRequest<{ name: string; category: string; tags: string[] }>(
        `/v1/knowledge-sources/${encodeURIComponent(targetId ?? "")}`,
      ),
    enabled: Boolean(targetId),
  });
  const destination = "name" in proposal.revision.target ? proposal.revision.target : target.data;
  const targetName = destination?.name ?? t("intake.proposal.loadingTarget");
  const targetCategory = destination?.category;
  const targetTags = destination?.tags?.join(", ");
  const confirmationDetails = [
    t("intake.proposal.confirmHelp", { target: targetName }),
    ...(targetCategory ? [`${t("intake.proposal.category")}: ${targetCategory}`] : []),
    ...(targetTags ? [`${t("intake.proposal.tags")}: ${targetTags}`] : []),
  ].join(" ");
  return (
    <article
      className="py-3"
      data-testid={`intake-proposal-${proposal.id}`}
      data-focused={focused || undefined}
    >
      <p className="font-medium">{proposal.revision.title}</p>
      <p
        className="text-sm text-muted-foreground"
        data-testid={`intake-proposal-${proposal.id}-target-details`}
      >
        {targetName}
        {targetCategory && targetCategory !== targetName ? ` · ${targetCategory}` : ""}
      </p>
      <CollapsibleSection
        label={t("intake.proposal.review")}
        defaultOpen={focused}
        testId={`intake-proposal-${proposal.id}-review`}
      >
        <CodeBlock code={proposal.revision.body} lang="markdown" />
        {targetTags ? (
          <p className="mt-2 text-sm" data-testid={`intake-proposal-${proposal.id}-target-tags`}>
            {t("intake.proposal.tags")}: {targetTags}
          </p>
        ) : null}
        <ul className="mt-3 grid gap-1 text-sm">
          {proposal.revision.items.map((item) => (
            <li key={item.id}>
              <a
                className="text-accent underline-offset-4 hover:underline"
                href={item.source_url}
                target="_blank"
                rel="noreferrer"
                data-testid={`intake-proposal-${proposal.id}-source-${item.id}`}
              >
                {item.title}
              </a>
            </li>
          ))}
        </ul>
      </CollapsibleSection>
      {proposal.status === "draft" && canConfirm ? (
        <Button
          className="mt-3"
          size="sm"
          disabled={Boolean(targetId) && !target.data}
          onClick={() => setConfirming(true)}
          data-testid={`intake-proposal-${proposal.id}-confirm`}
        >
          {t("intake.proposal.confirm")}
        </Button>
      ) : (
        <StatusBadge state={proposal.status} label={t(`intake.proposal.${proposal.status}`)} />
      )}
      {proposal.status === "confirmed" && proposal.confirmed_knowledge_source_id ? (
        <a
          className="mt-2 block text-sm text-accent"
          href={absolute(recordHref("knowledge", proposal.confirmed_knowledge_source_id))}
          data-testid={`intake-proposal-${proposal.id}-knowledge`}
        >
          {t("intake.openKnowledge", { name: targetName })}
        </a>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        object={proposal.revision.title}
        verb={t("intake.proposal.confirm")}
        consequence={confirmationDetails}
        onConfirm={onConfirm}
        testId={`intake-proposal-${proposal.id}-confirm-dialog`}
      />
    </article>
  );
}

export function IntakePage({ permissions }: { permissions: readonly string[] }) {
  const { t, dateTime } = useI18n();
  const queryClient = useQueryClient();
  const intakeSearch = useRouterState({ select: (router) => router.location.search });
  const focusItemId = new URLSearchParams(intakeSearch).get("item");
  const focusProposalId = new URLSearchParams(intakeSearch).get("proposal");
  const canRead = permissions.includes("intake:read");
  const canWrite = permissions.includes("intake:write");
  const canConfirm =
    permissions.includes("intake:confirm") && permissions.includes("knowledge:write");
  const canChat = permissions.includes("conversation:write");
  const [category, setCategory] = useState<string | "all" | null>(null);
  const [editingClip, setEditingClip] = useState<IntakeClip | null>(null);
  const [detailClip, setDetailClip] = useState<IntakeClip | null>(null);
  const [sorting, setSorting] = useState<SortingState>([{ id: "captured_at", desc: true }]);
  const [settingDefaultCategory, setSettingDefaultCategory] = useState(false);
  const [state, setState] = useState<"all" | (typeof INTAKE_STATES)[number]>("all");
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
  const focusedClip = useQuery({
    queryKey: [...CLIPS_KEY, "item", focusItemId],
    queryFn: () => getIntakeClip(focusItemId ?? ""),
    enabled: canRead && Boolean(focusItemId),
  });
  const categoryClips = useQuery({
    queryKey: [...CLIPS_KEY, effectiveCategory, "all"],
    queryFn: () => listIntakeClips(effectiveCategory ? { category: effectiveCategory } : {}),
    enabled: canRead && state !== "all",
  });
  const proposals = useQuery({
    queryKey: ["intake", "proposals"],
    queryFn: listIntakeProposals,
    enabled: canRead,
  });
  const proposalFocusItemId =
    proposals.data?.items.find((proposal) => proposal.id === focusProposalId)?.revision.items[0]
      ?.id ?? null;
  const proposalFocusedClip = useQuery({
    queryKey: [...CLIPS_KEY, "proposal", focusProposalId],
    queryFn: () => getIntakeClip(proposalFocusItemId ?? ""),
    enabled: canRead && Boolean(proposalFocusItemId),
  });
  useEffect(() => {
    if (focusedClip.data) setDetailClip(focusedClip.data);
    else if (proposalFocusedClip.data) setDetailClip(proposalFocusedClip.data);
  }, [focusedClip.data, proposalFocusedClip.data]);
  const categoryValues = useMemo(
    () => [
      ...new Set([
        ...(defaultCategory.data ? [defaultCategory.data.category] : []),
        ...(categories.data?.categories.map((item) => item.category) ?? []),
      ]),
    ],
    [categories.data, defaultCategory.data],
  );
  const clipItems = clips.data?.items ?? [];
  const detailProposals = detailClip
    ? (proposals.data?.items ?? []).filter((proposal) =>
        proposal.revision.items.some((item) => item.id === detailClip.id),
      )
    : [];
  const visibleClips =
    focusedClip.data && !clipItems.some((clip) => clip.id === focusedClip.data?.id)
      ? [...clipItems, focusedClip.data]
      : clipItems;
  useEffect(() => {
    if (!focusItemId || !visibleClips.some((clip) => clip.id === focusItemId)) return;
    const target = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid="intake-clip-${focusItemId}"]`),
    ).find((element) => element.offsetParent !== null);
    target?.focus();
    target?.scrollIntoView({ block: "center" });
  }, [focusItemId, visibleClips]);
  const write = useMutation({
    mutationFn: async (run: () => Promise<unknown>) => run(),
    onSuccess: async () => {
      await invalidateIntake(queryClient);
      if (detailClip) {
        const refreshed = await getIntakeClip(detailClip.id);
        setDetailClip((current) => (current?.id === refreshed.id ? refreshed : current));
      }
    },
    onError: () => toast.error(t("common.actionFailed")),
  });
  if (!canRead)
    return (
      <Page
        kind="list"
        surface="collection"
        scroll="page"
        testId="intake-page"
        header={<PageHeader eyebrow={t("nav.group.knowledge")} title={t("nav.inbox")} />}
      >
        <ForbiddenState />
      </Page>
    );
  const loading =
    categories.isPending ||
    defaultCategory.isPending ||
    clips.isPending ||
    (state !== "all" && categoryClips.isPending) ||
    (Boolean(focusItemId) && focusedClip.isPending) ||
    (Boolean(focusProposalId) &&
      (proposals.isPending || (Boolean(proposalFocusItemId) && proposalFocusedClip.isPending)));
  const failed = Boolean(
    categories.error ||
      defaultCategory.error ||
      clips.error ||
      (state !== "all" && categoryClips.error) ||
      (Boolean(focusItemId) && focusedClip.error) ||
      (Boolean(focusProposalId) &&
        (proposals.error ||
          proposalFocusedClip.error ||
          (proposals.isSuccess && !proposalFocusItemId))),
  );
  const clipColumns = (() => {
    const column = tableColumns<IntakeClip>({ t, dateTime });
    return [
      column.custom(
        "title",
        (clip) => clip.title,
        t("knowledge.column.name"),
        (clip) => <span className="truncate font-medium">{clip.title}</span>,
        { sortable: true, width: "w-[36%]" },
      ),
      column.custom(
        "category",
        (clip) => clip.category,
        t("intake.category"),
        (clip) => humanizeCategory(clip.category, t("catalog.categoryOther")),
        { sortable: true, width: "w-[18%]" },
      ),
      column.custom(
        "state",
        (clip) => clip.state,
        t("resource.field.status"),
        (clip) => <StatusBadge state={clip.state} label={t(intakeStateLabelKey(clip.state))} />,
        { width: "w-[18%]" },
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
          eyebrow={t("nav.group.knowledge")}
          title={t("nav.inbox")}
          purpose={t("intake.explanation")}
          menu={
            canWrite ? (
              <ActionMenu
                alwaysMenu
                testId="intake-page-actions"
                items={[
                  {
                    label: t("intake.chooseDefault"),
                    onSelect: () => setSettingDefaultCategory(true),
                    testId: "intake-category-default",
                  },
                ]}
              />
            ) : undefined
          }
        />
      }
    >
      <div className="flex flex-col gap-6 py-4">
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
        <IntakeEditDialog
          clip={editingClip}
          categories={categoryValues}
          open={editingClip !== null}
          pending={write.isPending}
          error={
            write.error instanceof ApiError && write.error.status === 409
              ? t("intake.editConflict")
              : write.isError
                ? t("common.actionFailed")
                : null
          }
          conflict={write.error instanceof ApiError && write.error.status === 409}
          onReload={() => {
            if (!editingClip) return;
            void getIntakeClip(editingClip.id)
              .then((clip) => {
                write.reset();
                setDetailClip(clip);
                setEditingClip(clip);
              })
              .catch(() => toast.error(t("common.actionFailed")));
          }}
          onOpenChange={(open) => {
            if (!open) {
              write.reset();
              setEditingClip(null);
            }
          }}
          onSave={(clip, input) =>
            write.mutate(() => updateIntakeClip(clip.id, input), {
              onSuccess: (updated) => {
                setDetailClip(updated as IntakeClip);
                setEditingClip(null);
              },
            })
          }
        />
        <RecordSheet
          open={detailClip !== null}
          onOpenChange={(open) => {
            if (!open) setDetailClip(null);
          }}
          title={detailClip?.title ?? ""}
          badge={
            detailClip ? (
              <StatusBadge
                state={detailClip.state}
                label={t(intakeStateLabelKey(detailClip.state))}
              />
            ) : undefined
          }
          testId="intake-detail"
        >
          {detailClip ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-end gap-2">
                {detailClip && canChat ? (
                  <Button asChild size="sm">
                    <a
                      href={absolute(
                        chatNewHref({
                          prompt: intakeItemChatPrompt(t),
                          intakeItemIds: [detailClip.id],
                          references: [{ type: "intake_item", id: detailClip.id }],
                        }),
                      )}
                      data-testid="intake-detail-review-chat"
                    >
                      <MessageSquare />
                      {t("intake.reviewChat")}
                    </a>
                  </Button>
                ) : undefined}
                {detailClip && canWrite ? (
                  <ActionMenu
                    alwaysMenu
                    testId="intake-detail-actions"
                    items={[
                      ...(detailClip.state === "discarded"
                        ? [
                            {
                              label: t("intake.restore"),
                              onSelect: () =>
                                write.mutate(
                                  () =>
                                    setIntakeClipState(detailClip.id, {
                                      state: "collected",
                                      expected_version: detailClip.version,
                                    }),
                                  { onSuccess: (clip) => setDetailClip(clip as IntakeClip) },
                                ),
                              testId: "intake-detail-restore",
                            },
                          ]
                        : detailClip.state === "admitted"
                          ? []
                          : [
                              {
                                label: t("intake.discard"),
                                destructive: true,
                                onSelect: () =>
                                  write.mutate(
                                    () =>
                                      setIntakeClipState(detailClip.id, {
                                        state: "discarded",
                                        expected_version: detailClip.version,
                                      }),
                                    { onSuccess: (clip) => setDetailClip(clip as IntakeClip) },
                                  ),
                                testId: "intake-detail-discard",
                              },
                            ]),
                      {
                        label: t("intake.editItem"),
                        onSelect: () => {
                          write.reset();
                          setEditingClip(detailClip);
                        },
                        testId: "intake-detail-edit",
                      },
                    ]}
                  />
                ) : undefined}
              </div>
              <FactList
                items={[
                  {
                    label: t("intake.category"),
                    value: humanizeCategory(detailClip.category, t("catalog.categoryOther")),
                  },
                  {
                    label: t("resource.field.createdAt"),
                    value: dateTime(detailClip.original_snapshot.captured_at),
                  },
                  ...(detailClip.original_snapshot.source_author
                    ? [
                        {
                          label: t("intake.sourceAuthorLabel"),
                          value: detailClip.original_snapshot.source_author,
                        },
                      ]
                    : []),
                  ...(detailClip.original_snapshot.published_at
                    ? [
                        {
                          label: t("intake.sourcePublished"),
                          value: publishedDate(detailClip.original_snapshot.published_at, dateTime),
                        },
                      ]
                    : []),
                ]}
              />
              <a
                className="break-words text-sm text-accent underline-offset-4 hover:underline"
                href={detailClip.original_snapshot.source_url}
                data-testid="intake-original-source-link"
                target="_blank"
                rel="noreferrer"
              >
                {detailClip.original_snapshot.source_url}
              </a>
              <FilePreview
                name=""
                mimeType="text/markdown"
                text={detailClip.body}
                testId="intake-current-body"
              />
              {detailClip.body !== detailClip.original_snapshot.body ? (
                <CollapsibleSection label={t("intake.originalSource")} testId="intake-original">
                  <FilePreview
                    name=""
                    mimeType="text/markdown"
                    text={detailClip.original_snapshot.body}
                    testId="intake-original-body"
                  />
                </CollapsibleSection>
              ) : null}
              {([false, true] as const).map((history) => {
                const items = detailProposals.filter(
                  (proposal) =>
                    (proposal.status === "confirmed" || proposal.status === "rejected") === history,
                );
                return items.length ? (
                  <CollapsibleSection
                    key={`${detailClip.id}-${history}-${focusProposalId ?? ""}`}
                    label={t(history ? "intake.proposalHistory" : "intake.proposals")}
                    testId={history ? "intake-proposal-history" : "intake-detail-proposals"}
                    defaultOpen={
                      !history || items.some((proposal) => proposal.id === focusProposalId)
                    }
                  >
                    {items.map((proposal) => (
                      <ProposalCard
                        key={proposal.id}
                        proposal={proposal}
                        canConfirm={canConfirm}
                        focused={proposal.id === focusProposalId}
                        onConfirm={() =>
                          write.mutate(() =>
                            confirmIntakeProposal(proposal.id, {
                              expected_revision: proposal.revision.revision,
                              digest: proposal.revision.digest,
                            }),
                          )
                        }
                      />
                    ))}
                  </CollapsibleSection>
                ) : null;
              })}
            </div>
          ) : null}
        </RecordSheet>
        {loading ? <DataState state="loading" testId="intake-loading" /> : null}
        {failed ? (
          <DataState
            state="error"
            line={t("intake.loadFailed")}
            onRetry={() => void invalidateIntake(queryClient)}
            testId="intake-error"
          />
        ) : null}
        {!loading && !failed ? (
          <>
            <SummaryLine
              text={
                <>
                  {visibleClips.length} · <CatalogCategories kind="intake" />
                </>
              }
              testId="intake-summary"
            />
            <DataTable<IntakeClip>
              columns={clipColumns}
              data={visibleClips}
              getRowId={(clip) => clip.id}
              toolbar={
                <FilterBar
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
                    ] satisfies FilterSelect[]
                  }
                />
              }
              pending={false}
              emptyState={{
                zero: { title: t("intake.empty") },
                filtered: {
                  title: t("resource.noMatches"),
                  description: t("resource.broaderSearch"),
                  resetLabel: t("catalog.clearFilters"),
                  onReset: () => {
                    setCategory(null);
                    setState("all");
                  },
                },
              }}
              hasActiveFilters={category !== null || state !== "all"}
              sorting={sorting}
              onSortingChange={setSorting}
              onOpen={setDetailClip}
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
