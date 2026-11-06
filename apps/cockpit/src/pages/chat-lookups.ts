import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiRequest, type Conversation, type ConversationDetail } from "@/api/client";
import { absolute, conversationHref } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { useSession } from "@/app/session";
import { catalogHref } from "@/features/chat";
import { useI18n } from "@/lib/i18n-context";
import type { ResolvedIdentifier } from "@/lib/identifiers";
import { resolveWorkflowNameBySlug } from "@/lib/name-index";
import { humanFacingText } from "@/lib/presentation";
import { listConversationAttachments } from "./chat-attachments";
import { liveAutomationReviews } from "./chat-automation-tool";
import { latestDryRunCallId, savedSensitivePreviews } from "./chat-preview-cards";
import { collectReferencedResources, namedResources } from "./chat-references";
import { groupMessageParts } from "./chat-transcript";

export function useChatLookups({
  activeId,
  data,
  messages,
  conversations,
}: {
  activeId: string | null;
  data: ConversationDetail | undefined;
  messages: ConversationDetail["messages"];
  conversations: Conversation[];
}) {
  const { t } = useI18n();
  const resume = data?.resume_summary;
  const answerMessageIds = useMemo(
    () =>
      new Set(
        (data?.tool_calls ?? []).flatMap((call) => {
          const output = call.output as { status?: unknown; elicitation_id?: unknown } | null;
          return call.tool === "ask_user_text" &&
            output?.status === "resolved" &&
            typeof output.elicitation_id === "string"
            ? [output.elicitation_id]
            : [];
        }),
      ),
    [data],
  );
  const createdResources = data?.created_resources ?? [];
  const referencedResources = useMemo(() => collectReferencedResources(messages), [messages]);
  const latestPreviewCallId = useMemo(() => latestDryRunCallId(messages), [messages]);
  const savedPreviews = useMemo(() => savedSensitivePreviews(data?.tool_calls ?? []), [data]);
  const nameFor = useMemo(() => {
    const known = new Map<string, ResolvedIdentifier>();
    for (const conversation of conversations) {
      if (!conversation.title) continue;
      known.set(conversation.id, {
        label: humanFacingText(conversation.title, t("chat.referenceUnnamed")),
        href: absolute(conversationHref(conversation.id)),
      });
    }
    for (const resource of namedResources({
      target: resume?.active_target,
      created: createdResources,
      referenced: referencedResources,
    }).values())
      known.set(resource.id, {
        label: resource.label,
        href: catalogHref(resource.kind, resource.id),
      });
    return (id: string) => known.get(id) ?? null;
  }, [conversations, createdResources, referencedResources, resume?.active_target, t]);
  const session = useSession();
  const live = useLiveQueryOptions();
  const conversationFiles = useQuery({
    queryKey: ["conversation-attachments", activeId],
    enabled: Boolean(activeId),
    queryFn: () => listConversationAttachments(activeId ?? ""),
    ...live,
  });
  const attachmentFor = useMemo(() => {
    const byId = new Map(
      (conversationFiles.data?.attachments ?? []).map((file) => [file.id, file] as const),
    );
    return (fileId: string) => byId.get(fileId) ?? null;
  }, [conversationFiles.data]);
  const workflowCatalogue = useQuery({
    queryKey: ["chat", "workflow-names"],
    enabled: session.permissions.includes("workflow:read"),
    queryFn: () =>
      apiRequest<{ items: { slug?: string | null; name?: string | null }[] }>(
        "/v1/workflows?limit=200",
      ),
  });
  const workflowNameFor = useMemo(() => {
    const items = workflowCatalogue.data?.items ?? [];
    return (slug: string) => resolveWorkflowNameBySlug(items, slug);
  }, [workflowCatalogue.data]);
  const reviewCards = useMemo(
    () =>
      liveAutomationReviews(
        messages.flatMap((message) =>
          groupMessageParts(message.parts).flatMap((group) =>
            group.kind === "tool" ? [group.tool] : group.kind === "background" ? group.tools : [],
          ),
        ),
      ),
    [messages],
  );
  const liveReviewCalls = useMemo(() => new Set(reviewCards.values()), [reviewCards]);
  const anchoredCalls = useMemo(
    () =>
      new Set(
        messages.flatMap((message) =>
          groupMessageParts(message.parts).flatMap((group) =>
            group.kind === "tool"
              ? [group.tool.toolCallId]
              : group.kind === "background"
                ? group.tools.map((tool) => tool.toolCallId)
                : [],
          ),
        ),
      ),
    [messages],
  );
  const unanchored = <T extends { toolCallId: string }>(question: T | null): T | null =>
    question && !anchoredCalls.has(question.toolCallId) ? question : null;
  return {
    answerMessageIds,
    createdResources,
    referencedResources,
    latestPreviewCallId,
    savedPreviews,
    nameFor,
    attachmentFor,
    workflowNameFor,
    reviewCards,
    liveReviewCalls,
    unanchored,
    live,
  };
}

export type ChatLookups = ReturnType<typeof useChatLookups>;
