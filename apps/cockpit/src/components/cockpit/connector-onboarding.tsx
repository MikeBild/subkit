import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import {
  type ConnectorWizardStart,
  CreateConnectorDialog,
} from "@/components/cockpit/create-connector";
import { fetchTemplates, TEMPLATES_KEY } from "@/components/cockpit/create-from-template";
import { sortedTemplates, templateMatches } from "@/components/cockpit/create-template-model";
import {
  Button,
  DataState,
  Input,
  OnboardingFrame,
  SectionHeading,
  TemplateCard,
  TemplateGrid,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { popularTemplates, serviceInitial } from "./connector-view-model";

const SEARCH_RESULTS = 12;

export function ConnectorOnboarding({ canChat }: { canChat: boolean }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [start, setStart] = useState<{ key: number; from: ConnectorWizardStart } | null>(null);
  const templates = useQuery({ queryKey: TEMPLATES_KEY, queryFn: fetchTemplates });
  const sorted = useMemo(() => sortedTemplates(templates.data?.items ?? []), [templates.data]);
  const needle = query.trim();
  const shown = needle
    ? sorted.filter((template) => templateMatches(template, needle)).slice(0, SEARCH_RESULTS)
    : popularTemplates(sorted);
  const open = (from: ConnectorWizardStart) =>
    setStart((current) => ({ key: (current?.key ?? 0) + 1, from }));
  return (
    <OnboardingFrame lead={t("connectorOnboarding.lead")} testId="connector-onboarding">
      <div className="relative flex w-full items-center sm:w-[36rem]">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("connectorOnboarding.search")}
          aria-label={t("connectorOnboarding.search")}
          className="h-10 pl-9"
          data-testid="connector-onboarding-search"
        />
      </div>
      <section className="flex flex-col gap-2" data-testid="connector-onboarding-services">
        <SectionHeading>
          {t(needle ? "connectorOnboarding.matches" : "connectorOnboarding.popular")}
        </SectionHeading>
        {templates.isError ? (
          <DataState
            state="error"
            line={t("create.template.loadFailed")}
            onRetry={() => void templates.refetch()}
          />
        ) : templates.isPending ? (
          <DataState state="loading" />
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("connectorOnboarding.noMatch", { search: needle })}
          </p>
        ) : (
          <TemplateGrid wide>
            {shown.map((template) => (
              <TemplateCard
                key={template.slug}
                title={template.name}
                line={template.description}
                icons={[
                  <span key="mark" className="text-xs font-semibold">
                    {serviceInitial(template.name)}
                  </span>,
                ]}
                onSelect={() => open({ way: "template", template: template.slug })}
                testId={`connector-onboarding-${template.slug}`}
              />
            ))}
          </TemplateGrid>
        )}
      </section>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-sm">
        <span className="flex-1 text-muted-foreground">{t("connectorOnboarding.own")}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => open({ way: "manual" })}
          data-testid="connector-onboarding-own"
        >
          {t("connectorOnboarding.ownAction")}
        </Button>
      </div>
      {start ? (
        <CreateConnectorDialog
          key={start.key}
          open
          onOpenChange={(next) => !next && setStart(null)}
          canChat={canChat}
          start={start.from}
        />
      ) : null}
    </OnboardingFrame>
  );
}
