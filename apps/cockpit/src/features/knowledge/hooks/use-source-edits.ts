import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { type ApiRequestBody, apiCall } from "@/api/call";
import { saveTextFailureKey } from "@/features/knowledge/api/knowledge-source-failure";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import { KEYS } from "../queries";
import type { KnowledgeSource } from "./use-source";

export function useSaveSourceAddress(
  src: KnowledgeSource,
  onSaved: (next: KnowledgeSource) => void,
) {
  const { t } = useI18n();
  return useMutation({
    mutationFn: (body: ApiRequestBody<"/v1/knowledge-sources/{id}", "patch">) =>
      apiCall("patch", "/v1/knowledge-sources/{id}", { path: { id: src.id }, body }),
    onSuccess: (n) => {
      toast.success(t("kn.sources.savedAddress", { name: src.name }));
      onSaved(n);
    },
    onError: (error) => reportFailure(t("common.actionFailed"), error),
  });
}

export function useSaveSourceText(src: KnowledgeSource, onSaved: () => void) {
  const { t } = useI18n();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: ApiRequestBody<"/v1/knowledge-sources/{id}/content", "put"> | null,
    ) => {
      if (!body) return;
      await apiCall("put", "/v1/knowledge-sources/{id}/content", { path: { id: src.id }, body });
    },
    onSuccess: () => {
      toast.success(t("kn.savedVersion", { name: src.name }));
      void client.invalidateQueries({ queryKey: KEYS.source(src.id) });
      onSaved();
    },
    onError: (error) => reportFailure(t(saveTextFailureKey(error)), error),
  });
}
