import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { Bookmark, ExternalLink, MessageSquareText, StickyNote } from "lucide-react";
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
  rejectIntakeProposal,
  setIntakeClipState,
  updateIntakeClip,
} from "@/api/intake";
import { useActorDirectory } from "@/app/actor-directory";
import { actorLabel } from "@/app/actor-directory-model";
import { contextualHref } from "@/app/installation-context";
import { absolute, chatNewHref, recordHref } from "@/app/links";
import { CatalogCategoryChip } from "@/components/cockpit/catalog-metadata";
import {
  ActionMenu,
  type ActionMenuItem,
  Button,
  CollapsibleSection,
  chipClass,
  DataState,
  DetailPage,
  type DetailStrip,
  FactList,
  FilePreview,
  MarkdownDocument,
  searchWithTab,
  TabBody,
  Timeline,
  type TimelineTone,
} from "@/components/cockpit/patterns";
import { ForbiddenState } from "@/components/failure-state";
import { formatRelativeTime, pluralKey, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  CATEGORIES_KEY,
  CLIPS_KEY,
  DEFAULT_CATEGORY_KEY,
  IntakeEditDialog,
  invalidateIntake,
  ProposalCard,
} from "./intake";
import {
  INTAKE_STRIP_TONE,
  type IntakeEventKind,
  intakeEvents,
  intakeItemChatPrompt,
  intakeOrigin,
  intakeOriginLabelKey,
  intakeSourceUrl,
  intakeStripState,
  publishedDate,
  sessionLabel,
  sessionPlace,
  sessionSnapshot,
} from "./intake-model";

export const INTAKE_ITEM_TABS = ["content", "review", "history"] as const;

const EVENT_TONE: Record<IntakeEventKind, TimelineTone> = {
  collected: "neutral",
  proposed: "info",
  changed: "warn",
  confirmed: "ok",
  rejected: "neutral",
  discarded: "neutral",
};

const EVENT_TITLE: Record<IntakeEventKind, TranslationKey> = {
  collected: "intake.event.collected",
  proposed: "intake.event.proposed",
  changed: "intake.event.changed",
  confirmed: "intake.event.confirmed",
  rejected: "intake.event.rejected",
  discarded: "intake.event.discarded",
};

function settled(proposal: IntakeProposal): boolean {
  return proposal.status === "confirmed" || proposal.status === "rejected";
}

export function IntakeItemPage({ permissions }: { permissions: readonly string[] }) {
  const { t, dateTime, locale } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { resourceId: id = "" } = useParams({ strict: false }) as { resourceId?: string };
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const params = new URLSearchParams(search);
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
  const session = clip ? sessionSnapshot(clip.original_snapshot) : null;
  const back = { to: "/intake", label: t("nav.inbox") };
  const focusProposalId = params.get("proposal");
  const tab = params.get("tab") ?? "content";
  const chooseTab = (next: string) =>
    router.history.replace(
      `${window.location.pathname}${searchWithTab(window.location.search, "tab", next, "content")}`,
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
  const origin = clip ? intakeOrigin(clip.original_snapshot) : "clip";
  const originLabel = t(intakeOriginLabelKey(origin));
  const sourceUrl = clip ? intakeSourceUrl(clip.original_snapshot) : null;
  const collector = clip ? (actorLabel(directory, clip.collected_by, t) ?? "") : "";
  const stripState = clip ? intakeStripState(clip, related) : null;
  const targetKind = clip?.admitted_target_kind;
  const targetHref =
    clip?.admitted_target_id && targetKind
      ? recordHref(targetKind === "skill" ? "skills" : "knowledge", clip.admitted_target_id)
      : null;
  const strip: DetailStrip | null =
    clip && stripState
      ? {
          tone: INTAKE_STRIP_TONE[stripState],
          line:
            stripState === "confirmed"
              ? t(
                  targetKind === "skill"
                    ? "intake.strip.confirmedSkill"
                    : "intake.strip.confirmedKnowledge",
                  { date: dateTime(clip.updated_at) },
                )
              : stripState === "discarded"
                ? t("intake.strip.discarded", { date: dateTime(clip.updated_at) })
                : t(`intake.strip.${stripState}`),
          action:
            stripState === "confirmed" && targetHref ? (
              <Button variant="outline" asChild>
                <a href={absolute(targetHref)} data-testid="intake-strip-target">
                  {t(targetKind === "skill" ? "intake.openSkillUnnamed" : "intake.openSource")}
                </a>
              </Button>
            ) : stripState === "discarded" && canWrite ? (
              <Button
                variant="outline"
                onClick={() => setState("collected")}
                data-testid="intake-detail-restore"
              >
                {t("intake.restore")}
              </Button>
            ) : undefined,
          testId: "intake-strip",
        }
      : null;
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
              ...(clip.state === "discarded" || clip.state === "admitted"
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
        onReject={() =>
          write.mutate(() =>
            rejectIntakeProposal(proposal.id, { expected_revision: proposal.revision.revision }),
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
  const evidence = item.data?.evidence ?? [];
  const hiddenEvidence = (item.data?.evidence_total ?? 0) - evidence.length;
  const published = clip ? publishedDate(clip.original_snapshot.published_at, dateTime) : null;
  const events = clip ? intakeEvents(clip, related) : [];

  return (
    <>
      <DetailPage
        testId="intake-item-page"
        back={back}
        title={clip?.title ?? ""}
        badge={clip ? <CatalogCategoryChip category={clip.category} /> : undefined}
        purpose={
          clip
            ? t("intake.purpose", {
                when: formatRelativeTime(locale, clip.original_snapshot.captured_at),
                origin: originLabel,
              })
            : undefined
        }
        loading={item.isPending}
        action={
          clip && tab !== "review" && clip.state !== "admitted" && clip.state !== "discarded" ? (
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
        strip={strip}
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
                      summary={t("intake.contentSummary", {
                        origin: originLabel,
                        name: collector,
                        when: dateTime(clip.original_snapshot.captured_at),
                      })}
                      technical={
                        <FactList
                          testId="intake-detail-session"
                          items={[
                            ...(session
                              ? [
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
                                ]
                              : []),
                            {
                              label: t("intake.fact.id"),
                              value: <span className="font-mono text-xs">{clip.id}</span>,
                            },
                          ]}
                        />
                      }
                      more={
                        <>
                          {session && (evidence.length || session.evidence_excerpt.trim()) ? (
                            <CollapsibleSection
                              label={t("intake.session.evidence")}
                              testId="intake-session-evidence"
                            >
                              {evidence.length ? (
                                <ul className="grid gap-3">
                                  {evidence.map((row) => (
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
                              {hiddenEvidence > 0 ? (
                                <p className="mt-2 text-sm text-muted-foreground">
                                  {t("intake.session.evidenceMore", { count: hiddenEvidence })}
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
                      <div
                        className="flex flex-wrap items-center gap-2 text-sm"
                        data-testid="intake-detail-facts"
                      >
                        <span className={chipClass("md")}>
                          {origin === "session" ? (
                            <MessageSquareText
                              aria-hidden="true"
                              className="size-3.5 text-muted-foreground"
                            />
                          ) : origin === "note" ? (
                            <StickyNote
                              aria-hidden="true"
                              className="size-3.5 text-muted-foreground"
                            />
                          ) : (
                            <Bookmark
                              aria-hidden="true"
                              className="size-3.5 text-muted-foreground"
                            />
                          )}
                          {originLabel}
                        </span>
                        {clip.original_snapshot.source_author ? (
                          <span className="text-muted-foreground">
                            {t("intake.sourceAuthor", {
                              name: clip.original_snapshot.source_author,
                            })}
                          </span>
                        ) : null}
                        {published ? (
                          <span className="text-muted-foreground">
                            {t("intake.publishedOn", { date: published })}
                          </span>
                        ) : null}
                        {!session && sourceUrl ? (
                          <a
                            className="ml-auto inline-flex items-center gap-1 text-accent underline-offset-4 hover:underline"
                            href={contextualHref(sourceUrl)}
                            data-testid="intake-original-source-link"
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ExternalLink aria-hidden="true" className="size-3.5" />
                            {t("intake.openOriginal")}
                          </a>
                        ) : null}
                      </div>
                      {clip.state !== "admitted" ? (
                        <p
                          className="text-sm text-muted-foreground"
                          data-testid="intake-not-knowledge"
                        >
                          {t("intake.notKnowledge")}
                        </p>
                      ) : null}
                      <MarkdownDocument text={clip.body} testId="intake-current-body" />
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
                    <TabBody
                      testId="intake-review"
                      summary={
                        open.length
                          ? t(
                              open.length === 1
                                ? "intake.review.summaryOne"
                                : "intake.review.summaryOther",
                              { count: open.length },
                            )
                          : undefined
                      }
                    >
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
                    <TabBody
                      testId="intake-history"
                      summary={t(pluralKey("intake.history.summary", events.length), {
                        count: events.length,
                      })}
                    >
                      <Timeline
                        testId="intake-proposal-history"
                        groups={[
                          {
                            label: t("intake.proposalHistory"),
                            items: events.map((event) => ({
                              id: event.id,
                              tone: EVENT_TONE[event.kind],
                              title: t(EVENT_TITLE[event.kind]),
                              meta:
                                event.kind === "collected"
                                  ? t("intake.event.collectedBy", {
                                      name: collector,
                                      origin: originLabel,
                                    })
                                  : event.title,
                              aside: (
                                <span className="text-xs text-muted-foreground">
                                  {dateTime(event.at)}
                                </span>
                              ),
                              testId: `intake-event-${event.id}`,
                            })),
                          },
                        ]}
                      />
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
