import { useWorkflowInvocation } from "@/components/cockpit/workflow-invocation";
import { LoadFailed, queryView } from "@/components/failure-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import {
  flattenInputFields,
  type InputField,
  inputFields,
  inputItemTypeKey,
  inputSampleText,
  inputTypeKey,
} from "@/lib/workflow-inputs";

function useTypeWord() {
  const { t } = useI18n();
  return (field: InputField) => {
    const item = inputItemTypeKey(field);
    return item
      ? t("input.type.arrayOf", { type: t(inputTypeKey(field)), item: t(item) })
      : t(inputTypeKey(field));
  };
}

/**
 * A schema as a table a reader can scan: one row per field, an object's own
 * fields indented under it. Columns stay few — name, type, whether it is
 * required, an example — and the allowed values and the description stand
 * under the name, where they belong to it.
 */
function FieldTable({
  fields,
  withRequired,
  testId,
}: {
  fields: readonly InputField[];
  /** Input fields can be required; an output field just is. */
  withRequired: boolean;
  testId: string;
}) {
  const { t } = useI18n();
  const typeWord = useTypeWord();
  const rows = flattenInputFields(fields);
  return (
    <Table data-testid={testId}>
      <TableHeader>
        <TableRow>
          <TableHead>{t("input.column.field")}</TableHead>
          <TableHead className="w-28">{t("input.column.type")}</TableHead>
          {withRequired ? (
            <TableHead className="w-20">{t("input.column.required")}</TableHead>
          ) : null}
          {withRequired ? (
            <TableHead className="hidden sm:table-cell">{t("input.column.example")}</TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((field, index) => {
          const sample = inputSampleText(field);
          return (
            <TableRow key={field.path} data-testid={`${testId}-row-${index}`}>
              <TableCell className="align-top">
                <span
                  className={cn("break-all font-mono text-xs", field.path !== field.name && "pl-4")}
                >
                  {field.name}
                </span>
                {field.description ? (
                  <p className="text-xs text-muted-foreground">{field.description}</p>
                ) : null}
                {field.options ? (
                  <p className="break-words text-xs text-muted-foreground">
                    {t("input.options", { options: field.options.map(String).join(", ") })}
                  </p>
                ) : null}
                {/* A narrow screen has no room for the example column; the
                    example stands under the name there instead. */}
                {withRequired && sample !== null ? (
                  <p className="break-all text-xs text-muted-foreground sm:hidden">
                    {t("input.example", { example: sample })}
                  </p>
                ) : null}
              </TableCell>
              <TableCell className="align-top">{typeWord(field)}</TableCell>
              {withRequired ? (
                <TableCell className="align-top">
                  {t(field.required ? "common.yes" : "common.no")}
                </TableCell>
              ) : null}
              {withRequired ? (
                <TableCell className="hidden align-top sm:table-cell">
                  {sample === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span className="break-all font-mono text-xs">{sample}</span>
                  )}
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

const card = "flex min-w-0 flex-col gap-2 rounded-xl border p-4";
const note = "text-sm text-muted-foreground";

/**
 * "Eingabe" and "Ausgabe": what the workflow takes and what it hands back, as
 * the schema says it. The input table is the same reading of the schema the
 * run dialog fills in (`lib/workflow-inputs.ts`).
 */
export function WorkflowInputOutput({
  workflowId,
  byWebhook,
}: {
  workflowId: string;
  /** A hook starts this workflow: the caller's body arrives wrapped. */
  byWebhook: boolean;
}) {
  const { t } = useI18n();
  const query = useWorkflowInvocation(workflowId);
  const view = queryView(query, () => false);
  if (view === "loading")
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  // The call block above already says the read failed, and offers the retry.
  if (view === "error" || !query.data)
    return (
      <LoadFailed
        title={t("input.loadFailed")}
        onRetry={() => void query.refetch()}
        testId="workflow-io-failed"
      />
    );
  const { input, output } = query.data;
  const inputs = inputFields(input.schema);
  const outputs = inputFields(output.schema);
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="workflow-io">
      <section className={card} data-testid="workflow-input">
        <h2 className="text-sm font-semibold">{t("input.title")}</h2>
        {inputs.length === 0 ? (
          <p className={note} data-testid="workflow-input-none">
            {t("input.none")}
          </p>
        ) : (
          <>
            <FieldTable fields={inputs} withRequired testId="workflow-input-table" />
            <p className={note} data-testid="workflow-input-where">
              {t("input.where")}
            </p>
            {input.source === "synthesized" ? (
              <p className={note} data-testid="workflow-input-synthesized">
                {t("run.schemaSynthesized")}
              </p>
            ) : null}
          </>
        )}
        {byWebhook ? (
          <p className={note} data-testid="workflow-input-webhook">
            {t("input.webhook")}
          </p>
        ) : null}
      </section>
      <section className={card} data-testid="workflow-output">
        <h2 className="text-sm font-semibold">{t("output.title")}</h2>
        {outputs.length === 0 ? (
          <p className={note} data-testid="workflow-output-none">
            {t("output.none")}
          </p>
        ) : (
          <FieldTable fields={outputs} withRequired={false} testId="workflow-output-table" />
        )}
      </section>
    </div>
  );
}
