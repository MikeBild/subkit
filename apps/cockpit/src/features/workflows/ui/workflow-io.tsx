import { cn } from "@ui/lib/utils";
import { DataState, type Fact, FactList, Section } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import {
  flattenInputFields,
  type InputField,
  inputFields,
  inputForm,
  inputItemTypeKey,
  inputSampleText,
  inputTypeKey,
} from "@/lib/workflow-inputs";
import { useWorkflowInvocation } from "./workflow-invocation";

function useTypeWord() {
  const { t } = useI18n();
  return (field: InputField) => {
    const item = inputItemTypeKey(field);
    return item
      ? t("input.type.arrayOf", { type: t(inputTypeKey(field)), item: t(item) })
      : t(inputTypeKey(field));
  };
}

function useFieldFacts(fields: readonly InputField[], withRequired: boolean, testId: string) {
  const { t } = useI18n();
  const typeWord = useTypeWord();
  return flattenInputFields(fields).map((field, index): Fact => {
    const sample = withRequired ? inputSampleText(field) : null;
    const help = field.description ?? "";
    return {
      label: (
        <span className={cn("break-all font-mono text-xs", field.path !== field.name && "pl-4")}>
          {field.name}
        </span>
      ),
      value: [
        typeWord(field),
        withRequired ? t(field.required ? "input.required" : "input.optional") : null,
        sample === null ? null : t("input.example", { example: sample }),
        field.options
          ? t("input.options", { options: field.options.map(String).join(", ") })
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      ...(help ? { help } : {}),
      testId: `${testId}-row-${index}`,
    };
  });
}

export function WorkflowInputOutput({
  workflowId,
  byWebhook,
  draftDefinition,
}: {
  workflowId: string;
  byWebhook: boolean;
  draftDefinition?: Record<string, unknown> | null;
}) {
  const { t } = useI18n();
  const query = useWorkflowInvocation(workflowId, !draftDefinition);
  const draftInput = draftDefinition?.input_schema;
  const draftOutput = draftDefinition?.output_schema;
  const inputSchema =
    draftInput && typeof draftInput === "object"
      ? (draftInput as Record<string, unknown>)
      : (query.data?.input.schema ?? null);
  const outputSchema =
    draftOutput && typeof draftOutput === "object"
      ? (draftOutput as Record<string, unknown>)
      : (query.data?.output.schema ?? null);
  const form = inputForm(inputSchema);
  const inputs = useFieldFacts(
    form.kind === "fields" ? form.fields : [],
    true,
    "workflow-input-table",
  );
  const outputs = useFieldFacts(
    outputSchema ? inputFields(outputSchema) : [],
    false,
    "workflow-output-table",
  );
  if (!draftDefinition && query.isPending) return <DataState state="loading" />;
  if (!draftDefinition && (query.error || !query.data))
    return (
      <DataState
        state="error"
        line={t("input.loadFailed")}
        error={query.error ?? undefined}
        onRetry={() => void query.refetch()}
        testId="workflow-io-failed"
      />
    );
  const note = "text-sm text-muted-foreground";
  return (
    <div className="flex flex-col gap-6" data-testid="workflow-io">
      <Section label={t("input.title")} testId="workflow-input">
        {form.kind === "none" ? (
          <p className={note} data-testid="workflow-input-none">
            {t("input.none")}
          </p>
        ) : form.kind === "whole" ? (
          <p className={note} data-testid="workflow-input-whole">
            {t("input.whole", { type: t(inputTypeKey(form.field)) })}
          </p>
        ) : (
          <FactList items={inputs} testId="workflow-input-table" />
        )}
        {form.kind !== "none" ? (
          <p className={note} data-testid="workflow-input-where">
            {t("input.where")}
          </p>
        ) : null}
        {form.kind !== "none" && !draftDefinition && query.data?.input.source === "synthesized" ? (
          <p className={note} data-testid="workflow-input-synthesized">
            {t("run.schemaSynthesized")}
          </p>
        ) : null}
        {byWebhook ? (
          <p className={note} data-testid="workflow-input-webhook">
            {t("input.webhook")}
          </p>
        ) : null}
      </Section>
      <Section label={t("output.title")} testId="workflow-output">
        {outputs.length === 0 ? (
          <p className={note} data-testid="workflow-output-none">
            {t("output.none")}
          </p>
        ) : (
          <FactList items={outputs} testId="workflow-output-table" />
        )}
      </Section>
    </div>
  );
}
