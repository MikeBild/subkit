import type { components } from "@cli-core/engine-api/openapi";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Zap } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { apiRequest } from "@/api/client";
import { connectorHref, workflowHref } from "@/app/links";
import { connectorService, useConnectorRecords } from "@/components/cockpit/connector-names";
import { SelectField, TextField } from "@/components/cockpit/form-field";
import {
  DataState,
  type DialogError,
  dialogFailure,
  FactList,
  RowsSkeleton,
  SearchInput,
  StatusBadge,
  TemplateCard,
  TemplateGrid,
} from "@/components/cockpit/patterns";
import { ServiceIcon } from "@/components/cockpit/service-icon";
import { reportFailure } from "@/lib/action-failure";
import { connectorSignIn, signInFailure } from "@/lib/connector-sign-in";
import { LOCALE_TAGS, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { type ServiceIdentity, templateIdentity } from "@/lib/service-icons";
import { stepKindKey } from "@/lib/workflow-steps";
import {
  addressedConnectors,
  type BindingChoice,
  bindingChoice,
  bindingConnectorId,
  type ConnectorTemplate,
  choiceValue,
  findSolution,
  joinNames,
  missingConnectors,
  NEW_CONNECTOR,
  planSolution,
  type SolutionConnector,
  type SolutionEntry,
  type SolutionTrigger,
  solutionAddressProblem,
  solutionBoundary,
  solutionDraftBody,
  solutionMatches,
  solutionNeeds,
  solutionSteps,
  solutionText,
  solutionTrigger,
  templateConnectorBody,
} from "./create-template-model";

type Connector = components["schemas"]["Connector"];

interface TemplateDetail {
  title: string;
  description: string;
  body: ReactNode;
}

interface TemplateFlow {
  list(onPick: (slug: string) => void): ReactNode;
  detail(slug: string): TemplateDetail | null;
  submit(slug: string): void;
  reset(): void;
  pending: boolean;
}

const TRIGGER_LABEL: Record<SolutionTrigger, TranslationKey> = {
  schedule: "create.solution.trigger.schedule",
  webhook: "create.solution.trigger.webhook",
  request: "create.solution.trigger.request",
};

const SOLUTIONS_KEY = ["recipe-packs", "solutions"] as const;
export const TEMPLATES_KEY = ["connector-templates"] as const;

const fetchSolutions = () =>
  apiCall("get", "/v1/recipe-packs/{vertical}", { path: { vertical: "solutions" } });
export const fetchTemplates = () => apiCall("get", "/v1/connector-templates", {});

async function takenWorkflowSlugs(base: string): Promise<Set<string>> {
  const { items } = await apiCall("get", "/v1/workflows", { query: { limit: 200, q: base } });
  return new Set(items.map((item) => item.slug));
}

export async function takenConnectorSlugs(): Promise<Set<string>> {
  const { items } = await apiCall("get", "/v1/connectors", { query: { limit: 1000 } });
  return new Set(items.map((item) => item.slug));
}

export async function createTemplateConnector(
  template: ConnectorTemplate,
  taken: Set<string>,
  address?: string,
): Promise<Connector> {
  const body = templateConnectorBody(template, taken, address);
  taken.add(body.slug ?? template.slug);
  return apiCall("post", "/v1/connectors", { body });
}

async function refreshLookups(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: ["catalog"] });
  await client.invalidateQueries({ queryKey: ["connectors"] });
}

function useSolutionPack(active: boolean) {
  return useQuery({ queryKey: SOLUTIONS_KEY, enabled: active, queryFn: fetchSolutions });
}

export function useSolutionTemplates(active: boolean) {
  const pack = useSolutionPack(active);
  return {
    entries: pack.data?.recipes ?? [],
    pending: pack.isPending,
    failed: pack.isError,
    retry: () => void pack.refetch(),
  };
}

function useBindingService(): (
  binding: SolutionConnector,
  choice?: BindingChoice,
) => ServiceIdentity {
  const records = useConnectorRecords();
  return (binding, choice) => {
    const id = bindingConnectorId(binding, choice);
    const record = id ? records.find((item) => item.id === id) : undefined;
    return record
      ? connectorService(record)
      : templateIdentity(binding.template, choice?.address ?? null);
  };
}

export function SolutionGallery({
  entries,
  pending,
  failed,
  onRetry,
  onPick,
  limit,
}: {
  entries: readonly SolutionEntry[];
  pending: boolean;
  failed: boolean;
  onRetry(): void;
  onPick(slug: string): void;
  limit?: number;
}) {
  const { t, locale } = useI18n();
  const serviceOf = useBindingService();
  const tag = LOCALE_TAGS[locale];
  if (pending) return <RowsSkeleton count={3} testId="create-solution-loading" />;
  if (failed)
    return (
      <DataState
        state="error"
        line={t("create.template.loadFailed")}
        onRetry={onRetry}
        testId="create-solution-failed"
      />
    );
  if (entries.length === 0)
    return (
      <p className="text-sm text-muted-foreground" data-testid="create-solution-none">
        {t("create.template.noMatches")}
      </p>
    );
  return (
    <TemplateGrid>
      {entries.slice(0, limit).map((entry) => {
        const text = solutionText(entry, t);
        return (
          <TemplateCard
            key={entry.recipe_slug}
            title={text.title}
            line={text.line}
            icons={entry.connectors
              .filter(
                (connector, index, all) =>
                  all.findIndex((other) => other.template === connector.template) === index,
              )
              .map((connector) => (
                <ServiceIcon key={connector.template} service={serviceOf(connector)} />
              ))}
            meta={[
              <>
                <Zap aria-hidden="true" />
                {t(TRIGGER_LABEL[solutionTrigger(entry)])}
              </>,
              <span key="needs" className="sr-only">
                {joinNames(solutionNeeds(entry), tag)}
              </span>,
            ]}
            onSelect={() => onPick(entry.recipe_slug)}
            testId={`create-solution-${entry.recipe_slug}`}
          />
        );
      })}
    </TemplateGrid>
  );
}

export function useSolutionFlow(
  active: boolean,
  done: () => void,
  fail: (error: DialogError) => void,
  refusal: (failure: unknown) => string,
): TemplateFlow {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [query, setQuery] = useState("");
  const [addresses, setAddresses] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<Record<string, string>>({});
  const created = useRef<Record<string, string>>({});
  const pack = useSolutionPack(active);
  const catalog = useQuery({ queryKey: TEMPLATES_KEY, enabled: active, queryFn: fetchTemplates });
  const serviceOf = useBindingService();
  const choiceFor = (connector: SolutionConnector): BindingChoice =>
    bindingChoice(connector, choices, catalog.data?.items ?? [], addresses);
  const addressed = (entry: SolutionEntry) =>
    addressedConnectors(entry, catalog.data?.items ?? [], choices);
  const clear = () => {
    setQuery("");
    setAddresses({});
    setChoices({});
    created.current = {};
  };
  const entries = pack.data?.recipes ?? [];
  const tag = LOCALE_TAGS[locale];
  const find = (slug: string) => findSolution(entries, slug);
  const create = useMutation({
    mutationFn: async (slug: string) => {
      const entry = find(slug);
      if (!entry) throw new Error(t("create.template.loadFailed"));
      const plan = planSolution(entry, {
        choices,
        created: created.current,
        takenSlugs: await takenWorkflowSlugs(entry.recipe_slug),
      });
      const mapping = { ...plan.mapping };
      if (plan.create.length > 0) {
        const [templates, taken] = await Promise.all([fetchTemplates(), takenConnectorSlugs()]);
        for (const binding of plan.create) {
          const template = templates.items.find((item) => item.slug === binding.template);
          if (!template) throw new Error(t("create.template.loadFailed"));
          const connector = await createTemplateConnector(
            template,
            taken,
            template.base_url ? undefined : addresses[binding.placeholder],
          );
          created.current = { ...created.current, [binding.placeholder]: connector.id };
          mapping[binding.placeholder] = connector.id;
        }
      }
      const draft = await apiCall("post", "/v1/workflows/drafts", {
        body: solutionDraftBody(entry, plan, mapping),
      });

      return { draft, title: solutionText(entry, t).title };
    },
    onSuccess: async ({ draft, title }) => {
      toast.success(t("create.solution.created", { name: title }));
      done();
      clear();
      await refreshLookups(client);
      await client.invalidateQueries({ queryKey: SOLUTIONS_KEY });
      void navigate({ to: `${workflowHref(draft.workflow_id)}?tab=overview` });
    },
    onError: (failure) => {
      fail(dialogFailure(refusal(failure), failure));
      void client.invalidateQueries({ queryKey: SOLUTIONS_KEY });
      void client.invalidateQueries({ queryKey: ["connectors"] });
    },
  });
  return {
    pending: create.isPending,
    reset: clear,
    submit: (slug) => {
      const entry = find(slug);
      const problem = entry ? solutionAddressProblem(addressed(entry), addresses) : null;
      if (problem) return fail(t(problem));
      create.mutate(slug);
    },
    list: (onPick) => (
      <div className="grid gap-3" data-testid="create-solution-list">
        <SearchInput
          id="create-solution-search"
          value={query}
          onChange={setQuery}
          label={t("create.template.search")}
          testId="create-solution-search"
        />
        <SolutionGallery
          entries={entries.filter((entry) => solutionMatches(entry, solutionText(entry, t), query))}
          pending={pack.isPending}
          failed={pack.isError}
          onRetry={() => void pack.refetch()}
          onPick={onPick}
        />
      </div>
    ),
    detail: (slug) => {
      const entry = find(slug);
      if (!entry) return null;
      const text = solutionText(entry, t);
      const missing = missingConnectors(entry);
      const boundary = solutionBoundary(entry)
        .map((line) =>
          t(line.effect === "write" ? "create.solution.writes" : "create.solution.reads", {
            name: line.name,
          }),
        )
        .join(" · ");
      return {
        title: text.title,
        description: text.line,
        body: (
          <div className="grid gap-4" data-testid="create-solution-detail">
            <FactList
              testId="create-solution-facts"
              items={[
                {
                  label: t("create.solution.trigger"),
                  value: t(TRIGGER_LABEL[solutionTrigger(entry)]),
                },
                {
                  label: t("create.solution.steps"),
                  value: solutionSteps(entry)
                    .map((step) => t(stepKindKey(step)))
                    .join(" → "),
                },
                {
                  label: t("create.solution.connectors"),
                  value: (
                    <span className="flex flex-col gap-2">
                      {entry.connectors.map((connector) => (
                        <span
                          key={connector.placeholder}
                          className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm"
                        >
                          <ServiceIcon
                            service={serviceOf(connector, choiceFor(connector))}
                            className="size-[18px]"
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {connector.connector_name ?? connector.template_name}
                          </span>
                          <StatusBadge
                            state={connector.connector_id ? "ok" : "pending"}
                            label={t(
                              connector.connector_id
                                ? "create.solution.connected"
                                : "create.solution.missing",
                            )}
                            testId={`create-solution-connector-${connector.template}`}
                          />
                        </span>
                      ))}
                    </span>
                  ),
                },
                {
                  label: t("create.solution.boundary"),
                  value: boundary,
                  help: t("create.solution.boundaryHelp"),
                },
              ]}
            />
            {missingConnectors(entry)
              .filter((connector) => connector.candidates.length > 0)
              .map((connector) => (
                <SelectField
                  key={`pick-${connector.placeholder}`}
                  id={`create-solution-pick-${connector.placeholder}`}
                  label={t("create.solution.pick", { name: connector.template_name })}
                  value={choiceValue(connector, choices)}
                  onChange={(value) =>
                    setChoices((current) => ({ ...current, [connector.placeholder]: value }))
                  }
                  options={[
                    ...connector.candidates.map((candidate) => ({
                      value: candidate.id,
                      label: candidate.name,
                    })),
                    { value: NEW_CONNECTOR, label: t("create.solution.pickNew") },
                  ]}
                />
              ))}
            {addressed(entry).map((connector) => (
              <TextField
                key={connector.placeholder}
                id={`create-solution-address-${connector.placeholder}`}
                type="url"
                label={t("create.solution.address", { name: connector.template_name })}
                help={t("create.solution.addressHelp")}
                value={addresses[connector.placeholder] ?? ""}
                onChange={(value) =>
                  setAddresses((current) => ({ ...current, [connector.placeholder]: value }))
                }
                mono
              />
            ))}
            <p className="text-sm text-muted-foreground" data-testid="create-solution-line">
              {missing.length > 0
                ? t(
                    missing.length === 1
                      ? "create.solution.missingLine.one"
                      : "create.solution.missingLine.other",
                    {
                      names: joinNames(
                        missing.map((c) => c.template_name),
                        tag,
                      ),
                    },
                  )
                : t("create.solution.allConnected")}
            </p>
          </div>
        ),
      };
    },
  };
}

export function useConnectorFinish(): (
  connector: Connector,
  opts: { keyed: boolean; tab: "overview" | "tools" },
) => Promise<void> {
  const { t } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  return async (connector, { keyed, tab }) => {
    await refreshLookups(client);
    const page =
      tab === "overview"
        ? connectorHref(connector.id)
        : `${connectorHref(connector.id)}?tab=${tab}`;
    const route = connectorSignIn(connector);
    if (route) {
      try {
        const start = await apiRequest<{ authorization_url: string }>(route.start, {
          method: "POST",
        });
        if (start.authorization_url) {
          window.location.assign(start.authorization_url);
          return;
        }
        toast.success(t("create.connector.connected", { name: connector.display_name }));
      } catch (failure) {
        reportFailure(signInFailure(failure, t), failure);
      }
      void navigate({ to: page });
      return;
    }
    toast.success(
      t(keyed ? "create.connector.connected" : "create.connector.created", {
        name: connector.display_name,
      }),
    );
    void navigate({ to: page });
  };
}
