import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Check,
  KeyRound,
  LayoutTemplate,
  LockOpen,
  MessageSquare,
  PencilLine,
  Search,
  UserCheck,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, chatNewHref } from "@/app/links";
import { useSession } from "@/app/session";
import { ConnectionGraphic, ServiceMark } from "@/components/cockpit/connector-graphic";
import { ConnectorSignInFields } from "@/components/cockpit/connector-sign-in-fields";
import {
  afterCreateTab,
  type ConnectorSignIn,
  type ConnectorTarget,
  connectorCreateBody,
  DEFAULT_SIGN_IN,
  EMPTY_OAUTH_CLIENT,
  manualConnectorProblem,
  needsSecret,
  type OAuthClientFields,
} from "@/components/cockpit/create-connector-model";
import {
  createTemplateConnector,
  fetchTemplates,
  TEMPLATES_KEY,
  takenConnectorSlugs,
  useConnectorFinish,
} from "@/components/cockpit/create-from-template";
import { createRefusal, slugify } from "@/components/cockpit/create-refusal";
import {
  type ConnectorTemplate,
  SIGN_IN_LABEL,
  sortedTemplates,
  type TemplateSignIn,
  templateConnectProblem,
  templateKeyHeader,
  templateMatches,
  templateNeedsAddress,
  templateSignIn,
} from "@/components/cockpit/create-template-model";
import { ChoiceField, TextField } from "@/components/cockpit/form-field";
import { ChoiceCards, DataState, FormDialog, Input } from "@/components/cockpit/patterns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { credentialBody } from "@/pages/connector-detail-model";
import { serviceHost } from "./connector-view-model";

type Connector = components["schemas"]["Connector"];

export type ConnectorWizardStart =
  | { way: "how" }
  | { way: "template"; template?: string }
  | { way: "manual" };

type Step = "how" | "service" | "signin" | "review";
type Way = "template" | "manual";

const STEPS: readonly Step[] = ["how", "service", "signin", "review"];

const STEP_KEYS = {
  how: "connectorWizard.step.how",
  service: "connectorWizard.step.service",
  signin: "connectorWizard.step.signin",
  review: "connectorWizard.step.review",
} as const;

const WAY_CARD: Record<
  ConnectorSignIn,
  { icon: ReactNode; title: TranslationKey; line: TranslationKey }
> = {
  account: {
    icon: <UserCheck />,
    title: "create.connector.signIn.account",
    line: "connectorWizard.signIn.accountLine",
  },
  key: {
    icon: <KeyRound />,
    title: "create.connector.signIn.key",
    line: "connectorWizard.signIn.keyLine",
  },
  none: {
    icon: <LockOpen />,
    title: "create.connector.signIn.none",
    line: "connectorWizard.signIn.noneLine",
  },
};

function WizardProgress({ step }: { step: Step }) {
  const { t } = useI18n();
  const current = STEPS.indexOf(step);
  return (
    <ol
      className="flex items-center gap-2 text-xs"
      aria-label={t("connectorWizard.progress", { step: current + 1, total: STEPS.length })}
      data-testid="create-connector-progress"
    >
      {STEPS.map((entry, index) => (
        <li key={entry} className="contents">
          <span
            className={cn(
              "flex items-center gap-2",
              index === current
                ? "font-medium text-foreground"
                : index < current
                  ? "text-emerald-700 dark:text-emerald-400"
                  : "text-muted-foreground",
            )}
            aria-current={index === current ? "step" : undefined}
          >
            <span
              className={cn(
                "inline-grid size-5 place-items-center rounded-full border [&_svg]:size-3",
                index === current && "border-foreground",
                index < current && "border-emerald-500",
              )}
            >
              {index < current ? <Check aria-hidden="true" /> : index + 1}
            </span>
            {t(STEP_KEYS[entry])}
          </span>
          {index < STEPS.length - 1 ? (
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function ServiceGrid({
  templates,
  chosen,
  onChoose,
  query,
  onQuery,
  pending,
  failed,
  onRetry,
}: {
  templates: readonly ConnectorTemplate[];
  chosen: string | null;
  onChoose(slug: string): void;
  query: string;
  onQuery(query: string): void;
  pending: boolean;
  failed: boolean;
  onRetry(): void;
}) {
  const { t } = useI18n();
  const shown = templates.filter((template) => templateMatches(template, query));
  return (
    <div className="flex flex-col gap-3" data-testid="create-template-list">
      <div className="relative flex items-center">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder={t("connectorWizard.searchService")}
          aria-label={t("connectorWizard.searchService")}
          className="pl-9"
          data-testid="create-template-search"
        />
      </div>
      {failed ? (
        <DataState state="error" line={t("create.template.loadFailed")} onRetry={onRetry} />
      ) : pending ? (
        <DataState state="loading" />
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("create.template.noMatches")}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {shown.map((template) => (
            <li key={template.slug} className="min-w-0">
              <button
                type="button"
                onClick={() => onChoose(template.slug)}
                aria-pressed={chosen === template.slug}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-lg border p-3 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  chosen === template.slug && "border-foreground ring-1 ring-foreground",
                )}
                data-testid={`create-template-${template.slug}`}
              >
                <ServiceMark name={template.name} size="sm" />
                <span className="min-w-0 truncate">{template.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function signInOfTemplate(template: ConnectorTemplate): ConnectorSignIn | null {
  const way = templateSignIn(template);
  return way === "account" || way === "key" || way === "none" ? way : null;
}

export function CreateConnectorDialog({
  open,
  onOpenChange,
  canChat,
  start = { way: "how" },
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  canChat: boolean;
  start?: ConnectorWizardStart;
}) {
  const { t, tn } = useI18n();
  const session = useSession();
  const callbackUrl = session.oauth_callback_url;
  const finish = useConnectorFinish();
  const initialStep = (from: ConnectorWizardStart): Step =>
    from.way === "how" ? "how" : from.way === "template" && from.template ? "signin" : "service";
  const [step, setStep] = useState<Step>(() => initialStep(start));
  const [way, setWay] = useState<Way>(start.way === "manual" ? "manual" : "template");
  const [chosen, setChosen] = useState<string | null>(
    start.way === "template" ? (start.template ?? null) : null,
  );
  const [query, setQuery] = useState("");
  const [address, setAddress] = useState("");
  const [secret, setSecret] = useState("");
  const [header, setHeader] = useState("");
  const [target, setTarget] = useState<ConnectorTarget>("web");
  const [signIn, setSignIn] = useState<ConnectorSignIn>(DEFAULT_SIGN_IN);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [oauth, setOAuth] = useState<OAuthClientFields>(EMPTY_OAUTH_CLIENT);
  const [error, setError] = useState<string | null>(null);
  const templates = useQuery({ queryKey: TEMPLATES_KEY, enabled: open, queryFn: fetchTemplates });
  const existing = useQuery({
    queryKey: ["connectors", "templates-in-use"],
    enabled: open,
    queryFn: () =>
      apiRequest<{ items: { template_slug?: string | null }[] }>("/v1/connectors?limit=1000"),
  });
  const sorted = useMemo(() => sortedTemplates(templates.data?.items ?? []), [templates.data]);
  const template =
    way === "template" && chosen ? (sorted.find((item) => item.slug === chosen) ?? null) : null;
  const refuse = (failure: unknown) => createRefusal(failure, t("create.connector.taken"), t);
  const reset = () => {
    setStep(initialStep(start));
    setWay(start.way === "manual" ? "manual" : "template");
    setChosen(start.way === "template" ? (start.template ?? null) : null);
    setQuery("");
    setAddress("");
    setSecret("");
    setHeader("");
    setTarget("web");
    setSignIn(DEFAULT_SIGN_IN);
    setName("");
    setDescription("");
    setOAuth(EMPTY_OAUTH_CLIENT);
    setError(null);
  };
  const connectTemplate = useMutation({
    mutationFn: async (picked: ConnectorTemplate) => {
      const keyHeader = templateKeyHeader(picked);
      const connector = await createTemplateConnector(
        picked,
        await takenConnectorSlugs(),
        templateNeedsAddress(picked) ? address : undefined,
      );
      const keyed = templateSignIn(picked) === "key";
      if (keyed) {
        const credential = credentialBody(picked.auth_type, secret, keyHeader ?? header);
        if (credential)
          await apiRequest(`/v1/connectors/${encodeURIComponent(connector.id)}/credentials`, {
            method: "POST",
            body: JSON.stringify(credential),
          });
      }
      return {
        connector,
        keyed,
        tab: picked.driver === "mcp" ? ("tools" as const) : ("overview" as const),
      };
    },
    onSuccess: async ({ connector, keyed, tab }) => {
      onOpenChange(false);
      reset();
      await finish(connector, { keyed, tab });
    },
    onError: (failure) => setError(refuse(failure)),
  });
  const connectManual = useMutation({
    mutationFn: async () => {
      const connector = await apiRequest<Connector>("/v1/connectors", {
        method: "POST",
        body: JSON.stringify({
          ...connectorCreateBody({ target, signIn, name, slug: slugify(name), address, oauth }),
          ...(description.trim() ? { description: description.trim() } : {}),
        }),
      });
      if (needsSecret(signIn))
        await apiRequest(`/v1/connectors/${encodeURIComponent(connector.id)}/credentials`, {
          method: "POST",
          body: JSON.stringify({ mode: "bearer", token: secret.trim() }),
        });
      return connector;
    },
    onSuccess: async (connector) => {
      onOpenChange(false);
      reset();
      await finish(connector, { keyed: needsSecret(signIn), tab: afterCreateTab(target) });
    },
    onError: (failure) => setError(refuse(failure)),
  });
  const pending = connectTemplate.isPending || connectManual.isPending;
  const close = (next: boolean) => {
    if (pending) return;
    onOpenChange(next);
    if (!next) reset();
  };
  const goTo = (next: Step) => {
    setError(null);
    setStep(next);
  };

  const asksHeader = (picked: ConnectorTemplate) =>
    templateSignIn(picked) === "key" && picked.auth_type === "header" && !templateKeyHeader(picked);
  const templateProblem = (picked: ConnectorTemplate) =>
    templateConnectProblem({
      signIn: templateSignIn(picked),
      needsAddress: templateNeedsAddress(picked),
      address,
      secret,
      header: asksHeader(picked) ? header : null,
      callbackUrl,
    });
  const manualProblem = () =>
    manualConnectorProblem({
      target,
      signIn,
      slug: slugify(name),
      address,
      secret,
      oauth,
      callbackUrl,
    });

  const frame = (p: {
    body: ReactNode;
    submit: { label: string; pending?: boolean; disabled?: boolean };
    onSubmit(): void;
    back?: Step;
  }) => (
    <FormDialog
      open={open}
      onOpenChange={close}
      title={t("resource.connectors.action")}
      size="wide"
      step={step}
      back={
        p.back
          ? {
              label: t("create.back"),
              onClick: () => goTo(p.back as Step),
              testId: "create-connector-back",
            }
          : undefined
      }
      submit={{ ...p.submit, testId: "create-connector-next" }}
      onSubmit={p.onSubmit}
      error={error}
      testId="create-connector-dialog"
    >
      <WizardProgress step={step} />
      {p.body}
    </FormDialog>
  );

  if (step === "how")
    return (
      <FormDialog
        open={open}
        onOpenChange={close}
        title={t("resource.connectors.action")}
        size="wide"
        step="how"
        testId="create-connector-dialog"
      >
        <WizardProgress step="how" />
        <ChoiceCards
          items={[
            ...(canChat
              ? [
                  {
                    icon: <MessageSquare />,
                    title: t("create.connector.chat"),
                    line: t("create.connector.chatLine"),
                    onSelect: () =>
                      window.location.assign(
                        absolute(chatNewHref({ prompt: t("create.connector.prompt") })),
                      ),
                    testId: "create-connector-chat",
                  },
                ]
              : []),
            {
              icon: <LayoutTemplate />,
              title: t("create.template.card"),
              line: t("create.connector.templateLine"),
              onSelect: () => {
                setWay("template");
                goTo("service");
              },
              testId: "create-connector-template",
            },
            {
              icon: <PencilLine />,
              title: t("create.byHand"),
              line: t("create.connector.byHandLine"),
              onSelect: () => {
                setWay("manual");
                goTo("service");
              },
              testId: "create-connector-manual",
            },
          ]}
        />
      </FormDialog>
    );

  if (step === "service" && way === "template")
    return frame({
      back: "how",
      body: (
        <ServiceGrid
          templates={sorted}
          chosen={chosen}
          onChoose={(slug) => {
            setChosen(slug);
            setAddress(sorted.find((item) => item.slug === slug)?.base_url ?? "");
            setSecret("");
            setHeader("");
            setError(null);
          }}
          query={query}
          onQuery={setQuery}
          pending={templates.isPending}
          failed={templates.isError}
          onRetry={() => void templates.refetch()}
        />
      ),
      submit: { label: t("connectorWizard.next"), disabled: !chosen },
      onSubmit: () => (chosen ? goTo("signin") : setError(t("connectorWizard.serviceMissing"))),
    });

  if (step === "service")
    return frame({
      back: "how",
      body: (
        <>
          <ChoiceField<ConnectorTarget>
            label={t("create.connector.target")}
            value={target}
            onChange={setTarget}
            help={t("create.connector.targetHelp")}
            testId="create-connector-target"
            options={[
              { value: "web", label: t("create.connector.target.web") },
              { value: "mcp", label: t("create.connector.target.mcp") },
            ]}
          />
          <TextField
            id="create-connector-name"
            label={t("create.name")}
            placeholder={t("create.connector.namePlaceholder")}
            value={name}
            onChange={setName}
          />
          <TextField
            id="create-connector-description"
            label={t("create.connector.description")}
            value={description}
            onChange={setDescription}
          />
          <TextField
            id="create-connector-address"
            type="url"
            label={t("create.connector.address")}
            placeholder={
              target === "mcp" ? "https://mcp.example.com/mcp" : "https://api.example.com"
            }
            value={address}
            onChange={setAddress}
            mono
          />
        </>
      ),
      submit: { label: t("connectorWizard.next") },
      onSubmit: () => {
        if (!slugify(name)) return setError(t("create.nameMissing"));
        if (!/^https:\/\/\S+\.\S+/.test(address.trim()))
          return setError(t("create.connector.addressInvalid"));
        goTo("signin");
      },
    });

  if (step === "signin" && way === "template" && !template)
    return frame({
      back: "service",
      body: templates.isPending ? (
        <DataState state="loading" />
      ) : (
        <DataState state="error" line={t("create.template.loadFailed")} />
      ),
      submit: { label: t("connectorWizard.next"), disabled: true },
      onSubmit: () => undefined,
    });

  if (step === "signin" && template) {
    const templateWay = signInOfTemplate(template);
    const second = (existing.data?.items ?? []).some(
      (item) => item.template_slug === template.slug,
    );
    return frame({
      back: "service",
      body: (
        <>
          {templateWay ? (
            <ChoiceCards
              items={[
                {
                  icon: WAY_CARD[templateWay].icon,
                  title: t(WAY_CARD[templateWay].title),
                  line: t(WAY_CARD[templateWay].line, { service: template.name }),
                  selected: true,
                  onSelect: () => undefined,
                  testId: `create-connector-signin-${templateWay}`,
                },
              ]}
            />
          ) : (
            <p className="text-sm" data-testid="create-connector-signin-other">
              {t(SIGN_IN_LABEL[templateSignIn(template)])}
            </p>
          )}
          {templateNeedsAddress(template) ? (
            <TextField
              id="create-template-address"
              type="url"
              label={t("create.connector.address")}
              value={address}
              onChange={setAddress}
              mono
            />
          ) : null}
          {asksHeader(template) ? (
            <TextField
              id="create-template-header"
              label={t("create.template.header")}
              value={header}
              onChange={setHeader}
              mono
            />
          ) : null}
          {templateSignIn(template) === "key" ? (
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
          {template.recipes.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {tn("create.template.readyLine", template.recipes.length)}
            </p>
          ) : null}
          {second ? (
            <p className="text-sm text-muted-foreground" data-testid="create-template-second">
              {t("create.template.second", { name: template.name })}
            </p>
          ) : null}
        </>
      ),
      submit: { label: t("connectorWizard.next") },
      onSubmit: () => {
        const problem = templateProblem(template);
        if (problem) return setError(t(problem));
        goTo("review");
      },
    });
  }

  if (step === "signin")
    return frame({
      back: "service",
      body: (
        <>
          <ChoiceCards
            items={(["account", "key", "none"] as const).map((entry) => ({
              icon: WAY_CARD[entry].icon,
              title: t(WAY_CARD[entry].title),
              line: t(WAY_CARD[entry].line, {
                service: name.trim() || t("connectorWizard.theService"),
              }),
              selected: signIn === entry,
              onSelect: () => setSignIn(entry),
              testId: `create-connector-signin-${entry}`,
            }))}
          />
          <ConnectorSignInFields
            idPrefix="create-connector"
            testId="create-connector-signin"
            target={target}
            signIn={signIn}
            onSignIn={(next) => setSignIn(next ?? DEFAULT_SIGN_IN)}
            secret={secret}
            onSecret={setSecret}
            keepsKey={false}
            keepsClientSecret={false}
            oauth={oauth}
            onOAuth={setOAuth}
            callbackUrl={callbackUrl}
            choice={false}
          />
        </>
      ),
      submit: { label: t("connectorWizard.next") },
      onSubmit: () => {
        const problem = manualProblem();
        if (problem) return setError(t(problem));
        goTo("review");
      },
    });

  const serviceName = template ? template.name : name.trim();
  const reviewWay: TemplateSignIn = template ? templateSignIn(template) : signIn;
  const reviewAddress = template
    ? templateNeedsAddress(template)
      ? address
      : template.base_url
    : address;
  return frame({
    back: "signin",
    body: (
      <>
        <ConnectionGraphic
          workspace={session.tenant.display_name}
          serviceName={serviceName}
          serviceLine={serviceHost(reviewAddress ?? null)}
          way={reviewWay}
          wayLabel={t(SIGN_IN_LABEL[reviewWay])}
          tone="info"
          stateLine={t("connectorWizard.review.state")}
          testId="create-connector-graphic"
        />
        <p className="text-sm" data-testid="create-connector-review-line">
          {t(
            reviewWay === "account"
              ? "connectorWizard.review.account"
              : reviewWay === "key"
                ? "connectorWizard.review.key"
                : "connectorWizard.review.other",
            { service: serviceName },
          )}
        </p>
      </>
    ),
    submit: { label: t("create.template.connect"), pending },
    onSubmit: () => {
      setError(null);
      if (template) {
        const problem = templateProblem(template);
        if (problem) return setError(t(problem));
        return connectTemplate.mutate(template);
      }
      const problem = manualProblem();
      if (problem) return setError(t(problem));
      connectManual.mutate();
    },
  });
}
