import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { connectorHref, workflowHref } from "@/app/links";
import { useSession } from "@/app/session";
import { SelectField, TextField } from "@/components/cockpit/form-field";
import { ListTable } from "@/components/cockpit/list-table";
import { FactList, RowName, StatusBadge } from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import { connectorSignIn, signInFailure } from "@/lib/connector-sign-in";
import { LOCALE_TAGS, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { credentialBody } from "@/pages/connector-detail-model";
import {
  addressedConnectors,
  type ConnectorTemplate,
  choiceOf,
  joinNames,
  missingConnectors,
  NEW_CONNECTOR,
  planSolution,
  SIGN_IN_LABEL,
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
  sortedTemplates,
  templateConnectorBody,
  templateConnectProblem,
  templateKeyHeader,
  templateMatches,
  templateNeedsAddress,
  templateSignIn,
} from "./create-template-model";

type Connector = components["schemas"]["Connector"];
type WorkflowDraft = components["schemas"]["WorkflowDraft"];
type RecipePack = components["schemas"]["RecipePackResponse"];
type TemplateList = components["schemas"]["ConnectorTemplateListResponse"];

export interface TemplateDetail {
  title: string;
  description: string;
  body: ReactNode;
}

export interface TemplateFlow {
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
const TEMPLATES_KEY = ["connector-templates"] as const;

const fetchSolutions = () => apiRequest<RecipePack>("/v1/recipe-packs/solutions");
const fetchTemplates = () => apiRequest<TemplateList>("/v1/connector-templates");

async function takenWorkflowSlugs(base: string): Promise<Set<string>> {
  const { items } = await apiRequest<{ items: { slug: string }[] }>(
    `/v1/workflows?limit=200&q=${encodeURIComponent(base)}`,
  );
  return new Set(items.map((item) => item.slug));
}

async function takenConnectorSlugs(): Promise<Set<string>> {
  const { items } = await apiRequest<{ items: { slug: string }[] }>("/v1/connectors?limit=1000");
  return new Set(items.map((item) => item.slug));
}

async function createTemplateConnector(
  template: ConnectorTemplate,
  taken: Set<string>,
  address?: string,
): Promise<Connector> {
  const body = templateConnectorBody(template, taken, address);
  taken.add(body.slug ?? template.slug);
  return apiRequest<Connector>("/v1/connectors", { method: "POST", body: JSON.stringify(body) });
}

async function refreshLookups(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: ["catalog"] });
  await client.invalidateQueries({ queryKey: ["connectors"] });
}

function SearchField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange(value: string): void;
}) {
  const { t } = useI18n();
  return (
    <TextField id={id} label={t("create.template.search")} value={value} onChange={onChange} />
  );
}

export function useSolutionFlow(
  active: boolean,
  done: () => void,
  fail: (error: string) => void,
  refusal: (failure: unknown) => string,
): TemplateFlow {
  const { t, locale, dateTime } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [query, setQuery] = useState("");
  const [addresses, setAddresses] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<Record<string, string>>({});
  const created = useRef<Record<string, string>>({});
  const pack = useQuery({ queryKey: SOLUTIONS_KEY, enabled: active, queryFn: fetchSolutions });
  const catalog = useQuery({ queryKey: TEMPLATES_KEY, enabled: active, queryFn: fetchTemplates });
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
  const find = (slug: string) => entries.find((entry) => entry.recipe_slug === slug) ?? null;
  const columns = useMemo(() => {
    const column = tableColumns<SolutionEntry>({ t, dateTime });
    return [
      column.custom(
        "name",
        (entry) => entry.title,
        t("create.template.column"),
        (entry) => {
          const text = solutionText(entry, t);
          return (
            <span className="grid min-w-0">
              <span className="truncate">
                <RowName>{text.title}</RowName>
              </span>
              <span className="truncate text-muted-foreground">
                {t("create.solution.needs", { names: joinNames(solutionNeeds(entry), tag) })}
              </span>
            </span>
          );
        },
        { ownsRowLink: true },
      ),
    ];
  }, [t, tag, dateTime]);
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
      const draft = await apiRequest<WorkflowDraft>("/v1/workflows/drafts", {
        method: "POST",
        body: JSON.stringify(solutionDraftBody(entry, plan, mapping)),
      });
      return { draft, title: solutionText(entry, t).title };
    },
    onSuccess: async ({ draft, title }) => {
      toast.success(t("create.solution.created", { name: title }));
      done();
      clear();
      await refreshLookups(client);
      await client.invalidateQueries({ queryKey: SOLUTIONS_KEY });
      void navigate({ to: `${workflowHref(draft.workflow_id)}?tab=structure` });
    },
    onError: (failure) => {
      fail(refusal(failure));
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
        <SearchField id="create-solution-search" value={query} onChange={setQuery} />
        <ListTable<SolutionEntry>
          id="create-solution"
          columns={columns}
          rows={entries.filter((entry) => solutionMatches(entry, solutionText(entry, t), query))}
          pending={pack.isPending}
          failed={pack.isError}
          resource={t("create.template.column")}
          onRetry={() => void pack.refetch()}
          empty={t("create.template.noMatches")}
          onOpen={(entry) => onPick(entry.recipe_slug)}
          rowLabel={(entry) => solutionText(entry, t).title}
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
                  value: (
                    <span className="font-mono text-[13px]">
                      {solutionSteps(entry)
                        .map((step) => step.id)
                        .join(" → ")}
                    </span>
                  ),
                },
                {
                  label: t("create.solution.connectors"),
                  value: (
                    <span className="flex flex-wrap gap-1.5">
                      {entry.connectors.map((connector) => (
                        <StatusBadge
                          key={connector.placeholder}
                          state={connector.connector_id ? "ok" : "pending"}
                          label={`${connector.connector_name ?? connector.template_name} · ${t(
                            connector.connector_id
                              ? "create.solution.connected"
                              : "create.solution.missing",
                          )}`}
                          testId={`create-solution-connector-${connector.template}`}
                        />
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
                  value={(() => {
                    const choice = choiceOf(connector, choices);
                    return choice.kind === "existing" ? choice.id : NEW_CONNECTOR;
                  })()}
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
  opts: { keyed: boolean; tab: "connection" | "tools" },
) => Promise<void> {
  const { t } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  return async (connector, { keyed, tab }) => {
    await refreshLookups(client);
    const page = `${connectorHref(connector.id)}?tab=${tab}`;
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
        toast.error(signInFailure(failure, t));
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

export function useConnectorTemplateFlow(
  active: boolean,
  done: () => void,
  fail: (error: string) => void,
  refusal: (failure: unknown) => string,
): TemplateFlow {
  const { t, tn, dateTime } = useI18n();
  const callbackUrl = useSession().oauth_callback_url;
  const finish = useConnectorFinish();
  const [query, setQuery] = useState("");
  const [address, setAddress] = useState("");
  const [secret, setSecret] = useState("");
  const [header, setHeader] = useState("");
  const templates = useQuery({ queryKey: TEMPLATES_KEY, enabled: active, queryFn: fetchTemplates });
  const existing = useQuery({
    queryKey: ["connectors", "templates-in-use"],
    enabled: active,
    queryFn: () =>
      apiRequest<{ items: { template_slug?: string | null }[] }>("/v1/connectors?limit=1000"),
  });
  const sorted = useMemo(() => sortedTemplates(templates.data?.items ?? []), [templates.data]);
  const find = (slug: string) => sorted.find((template) => template.slug === slug) ?? null;
  const reset = () => {
    setQuery("");
    setAddress("");
    setSecret("");
    setHeader("");
  };
  const columns = useMemo(() => {
    const column = tableColumns<ConnectorTemplate>({ t, dateTime });
    return [
      column.custom(
        "name",
        (template) => template.name,
        t("create.template.column"),
        (template) => (
          <span className="grid min-w-0">
            <span className="truncate">
              <RowName>{template.name}</RowName>
            </span>
            <span className="truncate text-muted-foreground">
              {template.recipes.length > 0
                ? tn("create.template.ready", template.recipes.length)
                : t("create.template.readyNone")}
            </span>
          </span>
        ),
        { width: "w-[65%]", ownsRowLink: true },
      ),
      column.custom(
        "sign_in",
        (template) => template.auth_type,
        t("create.template.columnSignIn"),
        (template) => (
          <span className="text-muted-foreground">
            {t(SIGN_IN_LABEL[templateSignIn(template)])}
          </span>
        ),
      ),
    ];
  }, [t, tn, dateTime]);
  const connect = useMutation({
    mutationFn: async (template: ConnectorTemplate) => {
      const keyHeader = templateKeyHeader(template);
      const connector = await createTemplateConnector(
        template,
        await takenConnectorSlugs(),
        templateNeedsAddress(template) ? address : undefined,
      );
      const keyed = templateSignIn(template) === "key";
      if (keyed) {
        const credential = credentialBody(template.auth_type, secret, keyHeader ?? header);
        if (credential)
          await apiRequest(`/v1/connectors/${encodeURIComponent(connector.id)}/credentials`, {
            method: "POST",
            body: JSON.stringify(credential),
          });
      }
      return { connector, keyed };
    },
    onSuccess: async ({ connector, keyed }) => {
      done();
      reset();
      await finish(connector, { keyed, tab: "connection" });
    },
    onError: (failure) => fail(refusal(failure)),
  });
  return {
    pending: connect.isPending,
    reset,
    submit: (slug) => {
      const template = find(slug);
      if (!template) return fail(t("create.template.loadFailed"));
      const signIn = templateSignIn(template);
      const asksHeader =
        signIn === "key" && template.auth_type === "header" && !templateKeyHeader(template);
      const problem = templateConnectProblem({
        signIn,
        needsAddress: templateNeedsAddress(template),
        address,
        secret,
        header: asksHeader ? header : null,
        callbackUrl,
      });
      if (problem) return fail(t(problem));
      connect.mutate(template);
    },
    list: (onPick) => (
      <div className="grid gap-3" data-testid="create-template-list">
        <SearchField id="create-template-search" value={query} onChange={setQuery} />
        <ListTable<ConnectorTemplate>
          id="create-template"
          columns={columns}
          rows={sorted.filter((template) => templateMatches(template, query))}
          pending={templates.isPending}
          failed={templates.isError}
          resource={t("create.template.column")}
          onRetry={() => void templates.refetch()}
          empty={t("create.template.noMatches")}
          onOpen={(template) => {
            setAddress(template.base_url ?? "");
            setSecret("");
            setHeader("");
            onPick(template.slug);
          }}
          rowLabel={(template) => template.name}
        />
      </div>
    ),
    detail: (slug) => {
      const template = find(slug);
      if (!template) return null;
      const signIn = templateSignIn(template);
      const needsAddress = templateNeedsAddress(template);
      const asksHeader =
        signIn === "key" && template.auth_type === "header" && !templateKeyHeader(template);
      const second = (existing.data?.items ?? []).some(
        (item) => item.template_slug === template.slug,
      );
      return {
        title: template.name,
        description: template.description,
        body: (
          <div className="grid gap-4" data-testid="create-template-detail">
            <FactList
              testId="create-template-facts"
              items={[
                { label: t("create.template.signIn"), value: t(SIGN_IN_LABEL[signIn]) },
                {
                  label: t("create.template.address"),
                  value:
                    needsAddress || !template.base_url ? (
                      t("create.template.addressYours")
                    ) : (
                      <span className="font-mono text-[13px] break-all">{template.base_url}</span>
                    ),
                },
                {
                  label: t("create.template.ready"),
                  value:
                    template.recipes.length > 0
                      ? tn("create.template.ready", template.recipes.length)
                      : t("create.template.readyNone"),
                },
              ]}
            />
            {needsAddress ? (
              <TextField
                id="create-template-address"
                type="url"
                label={t("create.connector.address")}
                value={address}
                onChange={setAddress}
                mono
              />
            ) : null}
            {asksHeader ? (
              <TextField
                id="create-template-header"
                label={t("create.template.header")}
                value={header}
                onChange={setHeader}
                mono
              />
            ) : null}
            {signIn === "key" ? (
              <TextField
                id="create-template-secret"
                type="password"
                label={t("create.connector.secret")}
                placeholder={t("create.connector.secretPlaceholder")}
                help={t("create.template.secretHelp")}
                value={secret}
                onChange={setSecret}
              />
            ) : null}
            {second ? (
              <p className="text-sm text-muted-foreground" data-testid="create-template-second">
                {t("create.template.second", { name: template.name })}
              </p>
            ) : null}
          </div>
        ),
      };
    },
  };
}
