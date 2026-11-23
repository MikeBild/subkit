import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { type ApiRequestBody, apiCall } from "@/api/call";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import { KEYS, useRefreshKnowledge } from "../queries";
import type { KnowledgeSource } from "./use-source";

export function useSourceActions(
  src: KnowledgeSource,
  { on, onRemoved }: { on: boolean; onRemoved: () => void },
) {
  const { t } = useI18n();
  const client = useQueryClient();
  const refreshAll = useRefreshKnowledge();
  const fail = (error: unknown) => reportFailure(t("common.actionFailed"), error);
  const saved = (next: KnowledgeSource) => {
    client.setQueryData(KEYS.source(src.id), next);
    void refreshAll();
  };
  const ingest = useMutation({
    mutationFn: () =>
      apiCall("post", "/v1/knowledge-sources/{id}/refresh", { path: { id: src.id } }),
    onSuccess: (n) => {
      toast.success(t("kn.sources.ingestStarted", { name: src.name }));
      saved(n);
    },
    onError: fail,
  });
  const toggle = useMutation({
    mutationFn: () =>
      apiCall("patch", "/v1/knowledge-sources/{id}", {
        path: { id: src.id },
        body: { status: on ? "inactive" : "active" },
      }),
    onSuccess: (n) => {
      toast.success(t(on ? "kn.turnedOff" : "kn.turnedOn", { name: src.name }));
      saved(n);
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => apiCall("delete", "/v1/knowledge-sources/{id}", { path: { id: src.id } }),
    onSuccess: () => {
      toast.success(t("kn.deleted", { name: src.name }));
      void refreshAll();
      onRemoved();
    },
    onError: fail,
  });
  const restore = useMutation({
    mutationFn: (version: number) =>
      apiCall("post", "/v1/knowledge-sources/{id}/restore/{version}", {
        path: { id: src.id, version },
      }),
    onSuccess: (_r, version) => {
      toast.success(t("kn.restored", { n: version }));
      void client.invalidateQueries({ queryKey: KEYS.source(src.id) });
    },
    onError: fail,
  });
  const review = useMutation({
    mutationFn: (review_due_at: string | null) => {
      const body: ApiRequestBody<"/v1/knowledge-sources/{id}", "patch"> & {
        review_due_at: string | null;
      } = { review_due_at };
      return apiCall("patch", "/v1/knowledge-sources/{id}", { path: { id: src.id }, body });
    },
    onSuccess: (n) => {
      toast.success(t("kn.sources.reviewSaved", { name: src.name }));
      saved(n);
    },
    onError: fail,
  });
  return { ingest, toggle, remove, restore, saved, review };
}
