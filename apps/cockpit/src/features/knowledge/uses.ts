import { useQuery } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import { listConversationsAbout } from "@/api/client";
import { listIntakeClips } from "@/api/intake";
import { useSession } from "@/app/session";
import { type Binding, boundTo, recordUses, type UseRow } from "./uses-model";

export function useRecordUses({
  binding,
  target,
}: {
  binding: Binding;
  target: { kind: "knowledge" | "skill"; id: string };
}): UseRow[] {
  const { permissions } = useSession();
  const bound = boundTo(binding);
  const name = useQuery({
    queryKey: ["record-binding", bound?.kind, bound?.id],
    enabled:
      !!bound &&
      permissions.includes(bound.kind === "workflow" ? "workflow:read" : "connector:read"),
    retry: false,
    queryFn: async () => {
      if (!bound) return "";
      if (bound.kind === "workflow")
        return (await apiCall("get", "/v1/workflows/{id}", { path: { id: bound.id } })).name;
      return (await apiCall("get", "/v1/connectors/{id}", { path: { id: bound.id } })).display_name;
    },
  });
  const intake = useQuery({
    queryKey: ["intake", "backlinks"],
    enabled: permissions.includes("intake:read"),
    queryFn: () => listIntakeClips(),
  });
  const conversations = useQuery({
    queryKey: ["conversations", "about", target.kind, target.id],
    enabled: permissions.includes("conversation:read"),
    queryFn: () =>
      listConversationsAbout(
        target.kind === "skill" ? { skill_id: target.id } : { knowledge_source_id: target.id },
      ),
  });
  return recordUses({
    binding: bound,
    bindingName: name.data ?? null,
    target,
    intake: intake.data?.items ?? [],
    conversations: conversations.data?.items ?? [],
  });
}
