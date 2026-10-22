import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/api/client";
import {
  confirmIntakeProposal,
  getIntakeClip,
  getIntakeDefaultCategory,
  type IntakeClip,
  type IntakeProposal,
  listIntakeCategories,
  listIntakeProposals,
  setIntakeClipState,
  updateIntakeClip,
} from "@/api/intake";
import { useActorDirectory } from "@/app/actor-directory";
import { actorLabel } from "@/app/actor-directory-model";
import { contextualHref } from "@/app/installation-context";
import { absolute, chatNewHref } from "@/app/links";
import {
  ActionMenu,
  type ActionMenuItem,
  Button,
  CollapsibleSection,
  DataState,
  DetailPage,
  FactList,
  FilePreview,
  StatusBadge,
  searchWithTab,
  TabBody,
} from "@/components/cockpit/patterns";
import { ForbiddenState } from "@/components/failure-state";
import { useI18n } from "@/lib/i18n-context";
import { humanizeCategory } from "@/lib/workflow-category";
import {
  CATEGORIES_KEY,
  CLIPS_KEY,
  DEFAULT_CATEGORY_KEY,
  IntakeEditDialog,
  invalidateIntake,
  ProposalCard,
} from "./intake";
import {
  intakeItemChatPrompt,
  intakeOrigin,
  intakeOriginLabelKey,
  intakeStateLabelKey,
  publishedDate,
  sessionLabel,
  sessionPlace,
  sessionSnapshot,
} from "./intake-model";

export const INTAKE_ITEM_TABS = ["content", "review", "history"] as const;

function settled(proposal: IntakeProposal): boolean {
  return proposal.status === "confirmed" || proposal.status === "rejected";
}

export function IntakeItemPage({ permissions }: { permissions: readonly string[] }) {
  const { t, dateTime } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { resourceId: id = "" } = useParams({ strict: false }) as { resourceId?: string };
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const focusProposalId = new URLSearchParams(search).get("proposal");
  const canRead = permissions.includes("intake:read");
  const canWrite = permissions.includes("intake:write");
  const canChat = permissions.includes("conversation:write");
  const [editing, setEditing] = useState(false);
  const itemKey = [...CLIPS_KEY, "item", id] as const;
  const item = useQuery({
    queryKey: itemKey,
    queryFn: () => getIntakeClip(id),
    enabled: canRead && Boolean(id),
  });
  const clip = item.data;
  const proposals = useQuery({
    queryKey: ["intake", "proposals"],
    queryFn: listIntakeProposals,
    enabled: canRead,
  });
  const categories = useQuery({
    queryKey: CATEGORIES_KEY,
    queryFn: listIntakeCategories,
    enabled: canRead && editing,
  });
  const defaultCategory = useQuery({
    queryKey: DEFAULT_CATEGORY_KEY,
    queryFn: getIntakeDefaultCategory,
    enabled: canRead && editing,
  });
  const directory = useActorDirectory(canRead && Boolean(clip));
  const write = useMutation({
    mutationFn: async (run: () => Promise<unknown>) => run(),
    onSuccess: async () => {
      await invalidateIntake(queryClient);
    },
    onError: () => toast.error(t("common.actionFailed")),
  });
  const categoryValues = useMemo(
    () => [
      ...new Set([
        ...(defaultCategory.data ? [defaultCategory.data.category] : []),
        ...(categories.data?.categories.map((entry) => entry.category) ?? []),
      ]),
    ],
    [categories.data, defaultCategory.data],
  );
  const related = (proposals.data?.items ?? []).filter((proposal) =>
    proposal.revision.items.some((entry) => entry.id === id),
  );
  const open = related.filter((proposal) => !settled(proposal));
  const past = related.filter(settled);
  const session = clip ? sessionSnapshot(clip.original_snapshot) : null;
  const back = { to: "/intake", label: t("nav.inbox") };
  const chooseTab = (tab: string) =>
    router.history.replace(
      `${window.location.pathname}${searchWithTab(window.location.search, "tab", tab, "content")}`,
    );

  if (!canRead)
    return (
      <DetailPage testId="intake-item-page" back={back} title={t("nav.inbox")}>
        <ForbiddenState />
      </DetailPage>
    );

  const setState = (state: "collected" | "discarded") => {
    if (!clip) return;
    write.mutate(() => setIntakeClipState(clip.id, { state, expected_version: clip.version }));
  };
  const menuItems: ActionMenuItem[] = clip
    ? [
        ...(canChat
          ? [
              {
                label: t("intake.reviewChat"),
                href: absolute(
                  chatNewHref({
                    prompt: intakeItemChatPrompt(t),
                    intakeItemIds: [clip.id],
                    references: [{ type: "intake_item", id: clip.id }],
                  }),
                ),
                testId: "intake-detail-review-chat",
              },
            ]
          : []),
        ...(canWrite
          ? [
              {
                label: t("intake.editItem"),
                onSelect: () => {
                  write.reset();
                  setEditing(true);
                },
                testId: "intake-detail-edit",
              },
              ...(clip.state === "discarded"
                ? [
                    {
                      label: t("intake.restore"),
                      onSelect: () => setState("collected"),
                      testId: "intake-detail-restore",
                    },
                  ]
                : clip.state === "admitted"
                  ? []
                  : [
                      {
                        label: t("intake.discard"),
                        destructive: true,
                        onSelect: () => setState("discarded"),
                        testId: "intake-detail-discard",
                      },
                    ]),
            ]
          : []),
      ]
    : [];

  const proposalCards = (items: IntakeProposal[]) =>
    items.map((proposal) => (
      <ProposalCard
        key={proposal.id}
        proposal={proposal}
        permissions={permissions}
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
    ));

  const failed = item.error ? (
    <DataState
      state="error"
      line={
        item.error instanceof ApiError && item.error.status === 404
          ? t("intake.notFound")
          : t("intake.loadFailed")
      }
      onRetry={() => void item.refetch()}
      testId="intake-item-error"
    />
  ) : null;

  return (
    <>
      <DetailPage
        testId="intake-item-page"
        back={back}
        title={clip?.title ?? ""}
        badge={
          clip ? (
            <StatusBadge state={clip.state} label={t(intakeStateLabelKey(clip.state))} />
          ) : undefined
        }
        purpose={
          clip
            ? `${humanizeCategory(clip.category, t("catalog.categoryOther"))} · ${t(
                intakeOriginLabelKey(intakeOrigin(clip.original_snapshot)),
              )} · ${dateTime(clip.original_snapshot.captured_at)}`
            : undefined
        }
        loading={item.isPending}
        action={
          clip && open.length > 0 ? (
            <Button onClick={() => chooseTab("review")} data-testid="intake-item-review">
              {t("intake.reviewAction")}
            </Button>
          ) : undefined
        }
        menu={
          menuItems.length > 0 ? (
            <ActionMenu alwaysMenu items={menuItems} testId="intake-detail-actions" />
          ) : undefined
        }
        defaultTab={focusProposalId ? "review" : undefined}
        tabs={
          clip
            ? [
                {
                  value: "content",
                  label: t("intake.tab.content"),
                  testId: "intake-tab-content",
                  content: (
                    <TabBody
                      testId="intake-content"
                      technical={
                        session ? (
                          <FactList
                            testId="intake-detail-session"
                            items={[
                              { label: t("intake.session.agent"), value: session.agent },
                              {
                                label: t("intake.session.id"),
                                value: sessionLabel(session.session_id, t),
                              },
                              ...(sessionPlace(session)
                                ? [
                                    {
                                      label: t("intake.session.place"),
                                      value: sessionPlace(session),
                                    },
                                  ]
                                : []),
                            ]}
                          />
                        ) : undefined
                      }
                      more={
                        <>
                          {session &&
                          ((item.data?.evidence ?? []).length ||
                            session.evidence_excerpt.trim()) ? (
                            <CollapsibleSection
                              label={t("intake.session.evidence")}
                              testId="intake-session-evidence"
                            >
                              {(item.data?.evidence ?? []).length ? (
                                <ul className="grid gap-3">
                                  {(item.data?.evidence ?? []).map((row) => (
                                    <li key={row.id} data-testid="intake-session-evidence-row">
                                      <p className="mb-1 text-sm text-muted-foreground">
                                        {[row.repo, dateTime(row.captured_at)]
                                          .filter(Boolean)
                                          .join(" · ")}
                                      </p>
                                      <FilePreview
                                        name=""
                                        mimeType="text/markdown"
                                        text={row.excerpt}
                                        testId="intake-session-evidence-row-body"
                                      />
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <FilePreview
                                  name=""
                                  mimeType="text/markdown"
                                  text={session.evidence_excerpt}
                                  testId="intake-session-evidence-body"
                                />
                              )}
                              {(item.data?.evidence_total ?? 0) -
                                (item.data?.evidence ?? []).length >
                              0 ? (
                                <p className="mt-2 text-sm text-muted-foreground">
                                  {t("intake.session.evidenceMore", {
                                    count:
                                      (item.data?.evidence_total ?? 0) -
                                      (item.data?.evidence ?? []).length,
                                  })}
                                </p>
                              ) : null}
                            </CollapsibleSection>
                          ) : null}
                          {clip.body !== clip.original_snapshot.body ? (
                            <CollapsibleSection
                              label={t("intake.originalSource")}
                              testId="intake-original"
                            >
                              <FilePreview
                                name=""
                                mimeType="text/markdown"
                                text={clip.original_snapshot.body}
                                testId="intake-original-body"
                              />
                            </CollapsibleSection>
                          ) : null}
                        </>
                      }
                    >
                      <FactList
                        testId="intake-detail-facts"
                        items={[
                          {
                            label: t("intake.category"),
                            value: humanizeCategory(clip.category, t("catalog.categoryOther")),
                          },
                          {
                            label: t("intake.origin"),
                            value: t(intakeOriginLabelKey(intakeOrigin(clip.original_snapshot))),
                          },
                          {
                            label: t("resource.field.createdAt"),
                            value: dateTime(clip.original_snapshot.captured_at),
                          },
                          ...(clip.original_snapshot.source_author
                            ? [
                                {
                                  label: t("intake.sourceAuthorLabel"),
                                  value: clip.original_snapshot.source_author,
                                },
                              ]
                            : []),
                          ...(clip.original_snapshot.published_at
                            ? [
                                {
                                  label: t("intake.sourcePublished"),
                                  value: publishedDate(
                                    clip.original_snapshot.published_at,
                                    dateTime,
                                  ),
                                },
                              ]
                            : []),
                          {
                            label: t("intake.collector"),
                            value: actorLabel(directory, clip.collected_by, t),
                          },
                        ]}
                      />
                      {!session && clip.original_snapshot.source_url ? (
                        <a
                          className="break-words text-sm text-accent underline-offset-4 hover:underline"
                          href={contextualHref(clip.original_snapshot.source_url)}
                          data-testid="intake-original-source-link"
                          target="_blank"
                          rel="noreferrer"
                        >
                          {clip.original_snapshot.source_url}
                        </a>
                      ) : null}
                      <FilePreview
                        name=""
                        mimeType="text/markdown"
                        text={clip.body}
                        testId="intake-current-body"
                      />
                    </TabBody>
                  ),
                },
                {
                  value: "review",
                  label: t("intake.tab.review"),
                  count: open.length || undefined,
                  testId: "intake-tab-review",
                  loading: proposals.isPending,
                  content: (
                    <TabBody testId="intake-review">
                      {open.length ? (
                        <div className="flex flex-col gap-4" data-testid="intake-detail-proposals">
                          {proposalCards(open)}
                        </div>
                      ) : (
                        <DataState
                          state="empty"
                          line={t("intake.noProposal")}
                          testId="intake-review-empty"
                        />
                      )}
                    </TabBody>
                  ),
                },
                {
                  value: "history",
                  label: t("intake.tab.history"),
                  testId: "intake-tab-history",
                  loading: proposals.isPending,
                  content: (
                    <TabBody testId="intake-history">
                      {past.length ? (
                        <div className="flex flex-col gap-4" data-testid="intake-proposal-history">
                          {proposalCards(past)}
                        </div>
                      ) : (
                        <DataState
                          state="empty"
                          line={t("intake.noHistory")}
                          testId="intake-history-empty"
                        />
                      )}
                    </TabBody>
                  ),
                },
              ]
            : undefined
        }
      >
        {failed}
      </DetailPage>
      {canWrite ? (
        <IntakeEditDialog
          clip={editing ? (clip ?? null) : null}
          categories={categoryValues}
          open={editing && Boolean(clip)}
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
            write.reset();
            void item.refetch();
          }}
          onOpenChange={(next) => {
            if (!next) {
              write.reset();
              setEditing(false);
            }
          }}
          onSave={(current: IntakeClip, input) =>
            write.mutate(() => updateIntakeClip(current.id, input), {
              onSuccess: () => setEditing(false),
            })
          }
        />
      ) : null}
    </>
  );
}
