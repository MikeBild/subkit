import { useQuery } from "@tanstack/react-query";
import { listWorkflowContextNotes } from "@/api/decisions";
import { CollapsibleSection, DataState } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { humanFacingText } from "@/lib/presentation";

export function WorkflowDraftingContext({ workflowId }: { workflowId: string }) {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ["skill-candidates", "context", workflowId],
    queryFn: () => listWorkflowContextNotes(workflowId),
  });
  const notes = query.data?.items ?? [];
  if (query.isSuccess && notes.length === 0) return null;
  const hidden = t("tool.referenceHiddenInline");
  return (
    <CollapsibleSection
      label={t("workflowPage.draftingContext")}
      count={query.isSuccess ? notes.length : undefined}
      testId="workflow-drafting-context"
    >
      {query.isPending ? (
        <DataState state="loading" line={t("workflowPage.draftingContext")} />
      ) : query.isError ? (
        <DataState
          state="error"
          line={t("workflowPage.draftingContextFailed")}
          onRetry={() => void query.refetch()}
          testId="workflow-drafting-context-error"
        />
      ) : (
        <ul className="flex flex-col gap-4" data-testid="workflow-drafting-context-notes">
          {notes.map((note) => (
            <li key={note.id} className="flex min-w-0 flex-col gap-1">
              <p className="text-sm font-medium break-words">
                {humanFacingText(note.title, hidden)}
              </p>
              <p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">
                {humanFacingText(note.body, hidden)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </CollapsibleSection>
  );
}
