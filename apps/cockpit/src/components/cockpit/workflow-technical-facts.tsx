import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { MISSING } from "@/components/cockpit/table-columns";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";

function Fact({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="min-w-0 bg-background p-4" data-testid={testId}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-w-0 text-sm font-medium">{children}</dd>
    </div>
  );
}

const text = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" && value ? value : null;
};

/**
 * "Technische Angaben", folded: what someone quoting the workflow needs — its
 * short name, its version and lifecycle, when it was made, changed and last
 * run — one disclosure deeper than everything a reader decides by. Each of
 * these facts has this one home on the page. The workflow's identifier is not
 * among them: it stands in the call it is used in, under "Aufrufen".
 */
export function WorkflowTechnicalFacts({ record }: { record: Record<string, unknown> }) {
  const { t, dateTime } = useI18n();
  const slug = text(record, "slug");
  const lifecycle = text(record, "lifecycle");
  const created = text(record, "created_at");
  const updated = text(record, "updated_at");
  const lastRun = text(record, "last_executed_at");
  const version = record.current_version;
  return (
    <Collapsible data-testid="workflow-technical">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 w-fit"
          data-testid="workflow-technical-toggle"
        >
          <ChevronRight data-icon="inline-start" />
          {t("connectorDetail.technical.title")}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="mt-2 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 xl:grid-cols-3">
          <Fact label={t("resource.field.slug")} testId="workflow-technical-slug">
            {slug ? <span className="break-all font-mono text-xs">{slug}</span> : MISSING}
          </Fact>
          <Fact label={t("catalog.version")} testId="workflow-technical-version">
            {typeof version === "number" ? `v${version}` : MISSING}
          </Fact>
          <Fact label={t("catalog.lifecycle")} testId="workflow-technical-lifecycle">
            {lifecycle ? statusLabel(t, lifecycle) : MISSING}
          </Fact>
          <Fact label={t("resource.field.createdAt")} testId="workflow-technical-created">
            {created ? dateTime(created) : MISSING}
          </Fact>
          <Fact label={t("catalog.updated")} testId="workflow-technical-updated">
            {updated ? dateTime(updated) : MISSING}
          </Fact>
          <Fact label={t("catalog.lastRun")} testId="workflow-technical-last-run">
            {lastRun ? dateTime(lastRun) : MISSING}
          </Fact>
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}
