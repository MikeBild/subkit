import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ApiError, deleteConversation } from "@/api/client";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import type { PersonConversationRow } from "./model/person-conversations";

export const PERSON_CONVERSATION_LIMIT = 50;

export const personConversationsKey = (personId: string) =>
  ["conversations", "person", personId] as const;

export const personConversationsQuery = (personId: string) => ({
  owner_id: personId,
  owner_kind: "user" as const,
  sort: "updated_at" as const,
  order: "desc" as const,
  limit: PERSON_CONVERSATION_LIMIT,
});

export function usePersonConversations(personId: string) {
  return useQuery({
    queryKey: personConversationsKey(personId),
    queryFn: () =>
      apiCall("get", "/v1/conversations", { query: personConversationsQuery(personId) }),
  });
}

export function useDeletePersonConversation(onDeleted: () => void) {
  const { t } = useI18n();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (row: PersonConversationRow) => deleteConversation(row.id),
    onSuccess: async () => {
      onDeleted();
      toast.success(t("people.conversations.deleted"));
      await client.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (error) =>
      reportFailure(
        error instanceof ApiError && error.status === 409
          ? t("chat.delete.running")
          : t("common.actionFailed"),
        error,
      ),
  });
}
