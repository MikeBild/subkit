import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiCall, apiMultipart } from "@/api/call";
import type { CreateSourceRequest } from "@/features/knowledge/api/knowledge-source-request";
import { useI18n } from "@/lib/i18n-context";
import { useRefreshKnowledge } from "../queries";
import type { KnowledgeSource } from "./use-source";

function createSource(request: CreateSourceRequest): Promise<KnowledgeSource> {
  if (request.kind === "url")
    return apiCall("post", "/v1/knowledge-sources/url", { body: request.body });
  if (request.kind === "text")
    return apiCall("post", "/v1/knowledge-sources/inline", { body: request.body });
  return apiMultipart("/v1/knowledge-sources", {
    body: { file: request.file, metadata: JSON.stringify({ name: request.file.name }) },
  });
}

export function useCreateSource({
  onCreated,
  onError,
}: {
  onCreated: (source: KnowledgeSource) => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useI18n();
  const refresh = useRefreshKnowledge();
  return useMutation({
    mutationFn: createSource,
    onSuccess: (source) => {
      toast.success(t("kn.sources.added", { name: source.name }));
      void refresh();
      onCreated(source);
    },
    onError,
  });
}
