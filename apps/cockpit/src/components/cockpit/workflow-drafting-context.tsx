import { useQuery } from "@tanstack/react-query";
import { listWorkflowContextNotes, type SkillCandidate } from "@/api/decisions";
import { connectorHref } from "@/app/links";
import { useConnectorNames } from "@/components/cockpit/connector-names";
import { CollapsibleSection, DataState, type Fact, FactList } from "@/components/cockpit/patterns";
import { causeClassLabel } from "@/lib/cause-class";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { workflowStepKindKey } from "@/lib/workflow-steps";

type NoteFacts = NonNullable<SkillCandidate["facts"]>;
type CapabilityFacts = Extract<NoteFacts, { kind: "workflow_capability" }>;
type FailureFacts = Extract<NoteFacts, { kind: "recurring_failure" }>;

export function WorkflowDraftingContext({
  workflowId,
  activeVersionId,
}: {
  workflowId: string;
  activeVersionId: string | null;
}) {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ["skill-candidates", "context", workflowId],
    queryFn: () => listWorkflowContextNotes(workflowId),
  });
  const notes = (query.data?.items ?? []).flatMap((note) =>
    note.facts ? [{ id: note.id, facts: note.facts }] : [],
  );
  if (query.isSuccess && notes.length === 0) return null;
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
            <li key={note.id} className="min-w-0">
              {note.facts.kind === "workflow_capability" ? (
                <CapabilityNote facts={note.facts} activeVersionId={activeVersionId} />
              ) : (
                <FailureNote facts={note.facts} />
              )}
            </li>
          ))}
        </ul>
      )}
    </CollapsibleSection>
  );
}

function CapabilityNote({
  facts,
  activeVersionId,
}: {
  facts: CapabilityFacts;
  activeVersionId: string | null;
}) {
  const { t } = useI18n();
  const names = useConnectorNames(facts.connector_ids.length > 0);
  const output = facts.output_fields?.length ? facts.output_fields : facts.key_paths;
  const items: Fact[] = [
    {
      label: t("workflowPage.draftingFact.inputs"),
      value:
        facts.inputs.length === 0
          ? t("workflowPage.draftingFact.none")
          : facts.inputs
              .map((input) =>
                input.required
                  ? t("workflowPage.draftingFact.required", { name: input.name })
                  : input.name,
              )
              .join(", "),
      testId: "workflow-drafting-fact-inputs",
    },
    {
      label: t("workflowPage.draftingFact.output"),
      value:
        output.length === 0 ? (
          t("workflowPage.draftingFact.outputUndeclared")
        ) : (
          <span className="break-words font-mono text-xs">{output.join(", ")}</span>
        ),
      testId: "workflow-drafting-fact-output",
    },
    {
      label: t("workflowPage.draftingFact.connectors"),
      value:
        facts.connector_ids.length === 0 ? (
          t("workflowPage.draftingFact.none")
        ) : (
          <span className="flex flex-wrap gap-x-2">
            {facts.connector_ids.map((id, index) => (
              <a
                key={id}
                className="underline-offset-4 hover:underline"
                href={connectorHref(id)}
                data-testid={`workflow-drafting-connector-${index}`}
              >
                {names.get(id) ?? t("workflowPage.draftingFact.connectorMissing")}
                {index < facts.connector_ids.length - 1 ? "," : ""}
              </a>
            ))}
          </span>
        ),
      testId: "workflow-drafting-fact-connectors",
    },
    {
      label: t("workflowPage.draftingFact.steps"),
      value: facts.steps.map((step) => t(workflowStepKindKey(step.kind))).join(" → "),
      testId: "workflow-drafting-fact-steps",
    },
    ...(facts.draft_version_id && facts.draft_version_id !== activeVersionId
      ? [
          {
            label: t("workflowPage.draftingFact.state"),
            value: t("workflowPage.draftingFact.savedNotActive"),
            testId: "workflow-drafting-fact-state",
          },
        ]
      : []),
  ];
  return <FactList items={items} testId="workflow-drafting-capability" />;
}

function FailureNote({ facts }: { facts: FailureFacts }) {
  const { t } = useI18n();
  return (
    <FactList
      testId="workflow-drafting-failure"
      items={[
        {
          label: t("workflowPage.draftingFact.failure"),
          value: (
            <>
              {t("workflowPage.draftingFact.failureLine", {
                step: facts.step_key,
                count: facts.count,
                days: facts.lookback_days,
              })}
              {" · "}
              <LabelText label={causeClassLabel(facts.cause_class, t)} />
            </>
          ),
          testId: "workflow-drafting-fact-failure",
        },
      ]}
    />
  );
}
