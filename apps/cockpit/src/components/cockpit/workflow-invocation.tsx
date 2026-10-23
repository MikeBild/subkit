import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  CalendarClock,
  CircleCheck,
  CircleSlash,
  Globe,
  type LucideIcon,
  Shield,
  Terminal,
  User,
  Users,
  Webhook,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { apiRequest } from "@/api/client";
import { useActorDirectory } from "@/app/actor-directory";
import { actorDirectoryName } from "@/app/actor-directory-model";
import { absolute, apiAccessHref } from "@/app/links";
import { useSession } from "@/app/session";
import {
  CodeBlock,
  ContextHelp,
  CopyField,
  DataState,
  FactList,
  IconTile,
  RecordSheet,
  Section,
  SegmentedControl,
  StatusBadge,
  TechnicalDetails,
} from "@/components/cockpit/patterns";
import { WorkflowScheduleSection } from "@/components/cockpit/workflow-schedule";
import { cronWords } from "@/lib/cron-words";
import { LOCALE_TAGS, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import {
  callVerdict,
  HOOK_STATE_KEYS,
  hasFixedInput,
  hiddenInvocationKey,
  hiddenInvocationLists,
  type WorkflowInvocation as Invocation,
  type InvocationHook,
  type InvocationMode,
  invocationModes,
  isWorkflowInvocation,
  SNIPPET_LANGUAGES,
  type SnippetLanguage,
  scheduleRowKey,
  verifierName,
} from "@/lib/workflow-invocation";
import { roleLabel } from "@/pages/admin-model";
import { API_KEYS_QUERY, type ApiKeyItem, groupApiKeys } from "@/pages/api-access-model";

type Environment = "dev" | "prod";

const SNIPPET_NAMES: Record<SnippetLanguage, string> = {
  curl: "curl",
  node: "Node.js",
  python: "Python",
};

const SNIPPET_LANG: Record<SnippetLanguage, string> = {
  curl: "bash",
  node: "javascript",
  python: "python",
};

const CHANNEL_ICONS: Record<InvocationMode, LucideIcon> = {
  schedule: CalendarClock,
  webhook: Webhook,
  http: Globe,
  mcp: Bot,
  cli: Terminal,
};

const CHANNEL_TITLES: Record<InvocationMode, TranslationKey> = {
  schedule: "workflowUse.channel.schedule",
  webhook: "workflowUse.channel.webhook",
  http: "workflowUse.channel.http",
  mcp: "workflowUse.channel.mcp",
  cli: "workflowUse.channel.cli",
};

const CHANNEL_SHEET_LINES: Record<InvocationMode, TranslationKey> = {
  schedule: "workflowUse.sheet.schedule",
  webhook: "workflowUse.sheet.webhook",
  http: "workflowUse.sheet.http",
  mcp: "workflowUse.sheet.mcp",
  cli: "workflowUse.sheet.cli",
};

export function useWorkflowInvocation(workflowId: string, enabled = true) {
  return useQuery({
    queryKey: ["workflow-invocation", workflowId],
    enabled,
    queryFn: async (): Promise<Invocation> => {
      const answer = await apiRequest<unknown>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/invocation`,
      );
      if (!isWorkflowInvocation(answer)) throw new Error("not an invocation answer");
      return answer;
    },
  });
}

function Copyable({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0" data-action-scope="copy">
      {children}
    </div>
  );
}

const line = "text-sm text-muted-foreground";

function useMissingKey(): boolean {
  const { permissions } = useSession();
  const canRead = permissions.includes("api_key:read");
  const keys = useQuery({
    queryKey: API_KEYS_QUERY,
    enabled: canRead,
    queryFn: () => apiRequest<{ items: ApiKeyItem[] }>("/v1/identity/api-keys"),
  });
  return (
    canRead &&
    permissions.includes("api_key:write") &&
    keys.data !== undefined &&
    groupApiKeys(keys.data.items).active.length === 0
  );
}

function HttpMode({
  invocation,
  approvedEnvironment,
}: {
  invocation: Invocation;
  approvedEnvironment: Environment | null;
}) {
  const { t } = useI18n();
  const [environment, setEnvironment] = useState<Environment>("prod");
  const [language, setLanguage] = useState<SnippetLanguage>("curl");
  const { http } = invocation;
  const snippet = http.snippets?.[environment][language] ?? null;
  const verdict = callVerdict(invocation, environment, approvedEnvironment);
  const missingKey = useMissingKey();
  return (
    <div className="flex flex-col gap-4">
      <Copyable>
        <CopyField
          labelled
          value={http.url ?? http.path}
          label={t("invocation.httpAddress")}
          testId="workflow-invocation-http-url"
        />
      </Copyable>
      {http.url === null ? (
        <p className={line} data-testid="workflow-invocation-no-address">
          {t("invocation.noAddress")}
        </p>
      ) : null}
      <FactList
        testId="workflow-invocation-http-facts"
        items={[
          {
            label: t("invocation.http.signIn"),
            help: t("invocation.http.bearerHelp"),
            value: t("invocation.http.bearer"),
            testId: "workflow-invocation-http-auth",
          },
        ]}
      />
      {missingKey ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2.5 text-sm">
          <span className="min-w-0 flex-1">{t("workflowUse.noKey")}</span>
          <a
            href={absolute(apiAccessHref("keys"))}
            className="text-sm font-medium underline underline-offset-4"
            data-testid="workflow-invocation-create-key"
          >
            {t("apiKeys.create")}
          </a>
        </div>
      ) : null}
      {verdict === "live" ? null : (
        <p className={line} data-verdict={verdict} data-testid="workflow-invocation-preview-only">
          {t(
            verdict === "refused"
              ? "invocation.http.refused"
              : verdict === "preview"
                ? "invocation.http.previewOnly"
                : "invocation.http.unconfirmed",
          )}
        </p>
      )}
      <TechnicalDetails testId="workflow-invocation-http-technical">
        <FactList
          items={[
            {
              label: t("invocation.http.method"),
              value: http.method,
              testId: "workflow-invocation-http-method",
            },
          ]}
        />
        {snippet ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl
                label={t("run.environment")}
                value={environment}
                onValueChange={(value) => setEnvironment(value as Environment)}
                testId="workflow-invocation-environment"
                options={[
                  {
                    value: "prod",
                    label: t("run.environment.prod"),
                    testId: "workflow-invocation-environment-prod",
                  },
                  {
                    value: "dev",
                    label: t("run.environment.dev"),
                    testId: "workflow-invocation-environment-dev",
                  },
                ]}
              />
              <SegmentedControl
                label={t("invocation.http.language")}
                value={language}
                onValueChange={(value) => setLanguage(value as SnippetLanguage)}
                testId="workflow-invocation-language"
                options={SNIPPET_LANGUAGES.map((value) => ({
                  value,
                  label: SNIPPET_NAMES[value],
                  testId: `workflow-invocation-language-${value}`,
                }))}
              />
              <ContextHelp
                label={t("invocation.http.snippet")}
                testId="workflow-invocation-responses"
              >
                {t("invocation.http.responses")}
              </ContextHelp>
            </div>
            <Copyable>
              <CodeBlock
                label={t("invocation.http.snippet")}
                code={snippet}
                lang={SNIPPET_LANG[language]}
                testId="workflow-invocation-snippet"
              />
            </Copyable>
          </>
        ) : (
          <Copyable>
            <CodeBlock
              label={t("invocation.http.body")}
              code={JSON.stringify(http.body, null, 2)}
              lang="json"
              testId="workflow-invocation-body"
            />
          </Copyable>
        )}
      </TechnicalDetails>
    </div>
  );
}

function signingSentence(hook: InvocationHook, t: ReturnType<typeof useI18n>["t"]): string {
  if (!hook.signed) return t("invocation.hook.unsigned");
  const headers = hook.signing_headers.join(", ");
  if (hook.hmac)
    return t("invocation.hook.hmac", {
      encoding: hook.hmac.encoding,
      payload: hook.hmac.signed_payload,
      headers,
    });
  return headers
    ? t("invocation.hook.signed", { scheme: verifierName(hook.verifier), headers })
    : t("invocation.hook.signedUnnamed", { scheme: verifierName(hook.verifier) });
}

function WebhookMode({ invocation }: { invocation: Invocation }) {
  const { t } = useI18n();
  const hooks = invocation.hooks ?? [];
  return (
    <div className="flex flex-col gap-4">
      {hooks.length === 0 ? (
        <p className={line} data-testid="workflow-invocation-hook-none">
          {t("workflowUse.card.noWebhook")}
        </p>
      ) : null}
      {hooks.map((hook, index) => (
        <div
          key={hook.slug}
          className="flex flex-col gap-2"
          data-testid={`workflow-invocation-hook-${index}`}
        >
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <Copyable>
                <CopyField
                  labelled
                  value={hook.url ?? hook.path}
                  label={t("invocation.webhookAddress")}
                  testId={`workflow-invocation-hook-${index}-url`}
                />
              </Copyable>
            </div>
            <StatusBadge
              state={
                hook.state === "active" ? "active" : hook.state === "held" ? "pending" : "inactive"
              }
              label={t(HOOK_STATE_KEYS[hook.state])}
              testId={`workflow-invocation-hook-${index}-state`}
            />
          </div>
          <p className={line}>
            {t(hook.signed ? "workflowUse.hook.signed" : "workflowUse.hook.unsigned")}
          </p>
        </div>
      ))}
      {invocation.base_url === null ? <p className={line}>{t("invocation.noAddress")}</p> : null}
      <TechnicalDetails testId="workflow-invocation-hook-technical">
        {hooks.length > 0 ? (
          <FactList
            items={hooks.map((hook, index) => ({
              label: t("invocation.hook.signature"),
              value: signingSentence(hook, t),
              testId: `workflow-invocation-hook-${index}-signing`,
            }))}
          />
        ) : null}
        <Copyable>
          <CodeBlock
            label={t("invocation.hook.shape")}
            code={JSON.stringify(invocation.webhook_input_shape, null, 2)}
            lang="json"
            testId="workflow-invocation-hook-shape"
          />
        </Copyable>
      </TechnicalDetails>
    </div>
  );
}

function McpMode({ invocation }: { invocation: Invocation }) {
  const { t } = useI18n();
  const { mcp } = invocation;
  return (
    <div className="flex flex-col gap-4">
      {invocation.base_url ? (
        <Copyable>
          <CopyField
            labelled
            value={`${invocation.base_url.replace(/\/$/, "")}/mcp`}
            label={t("invocation.mcpAddress")}
            testId="workflow-invocation-mcp-url"
          />
        </Copyable>
      ) : null}
      <FactList
        items={[{ label: t("invocation.http.signIn"), value: t("invocation.mcp.signIn") }]}
        testId="workflow-invocation-mcp-auth"
      />
      <TechnicalDetails testId="workflow-invocation-mcp-technical">
        <Copyable>
          <CopyField
            labelled
            value={mcp.tool_name}
            label={t("invocation.mcp.tool")}
            testId="workflow-invocation-mcp-tool"
          />
        </Copyable>
        <Copyable>
          <CodeBlock
            label={t("invocation.mcp.input")}
            code={JSON.stringify(invocation.input.sample, null, 2)}
            lang="json"
            testId="workflow-invocation-mcp-input"
          />
        </Copyable>
        <p className={line} data-testid="workflow-invocation-mcp-fallback">
          {t("invocation.mcp.fallback", {
            tool: mcp.fallback.tool_name,
            workflow: mcp.fallback.arguments.workflow,
          })}
        </p>
      </TechnicalDetails>
    </div>
  );
}

function CliMode({ invocation }: { invocation: Invocation }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3">
      <Copyable>
        <CodeBlock
          label={t("invocation.cli.command")}
          code={invocation.cli.command}
          lang="bash"
          testId="workflow-invocation-cli"
        />
      </Copyable>
      <p className={line} data-testid="workflow-invocation-cli-environment">
        {t(
          invocation.cli.environment === "prod"
            ? "invocation.cli.runsInProd"
            : "invocation.cli.runsInDev",
        )}
      </p>
    </div>
  );
}

function StartAccess({ access }: { access: NonNullable<Invocation["start_access"]> }) {
  const { t } = useI18n();
  const directory = useActorDirectory(access.visibility.rules);
  const { permissions } = useSession();
  const groups = useQuery({
    queryKey: ["workflow-start-access-groups"],
    enabled: access.visibility.rules && permissions.includes("rbac:read"),
    queryFn: () => apiRequest<{ items: { id: string; name: string }[] }>("/v1/rbac/groups"),
  });
  const chips = access.rules
    ? [
        ...access.rules.roles.map((role) => ({
          key: `role:${role.id}`,
          icon: Shield,
          label: roleLabel(role.name, t).text,
        })),
        ...access.rules.grants.map((grant) => ({
          key: `${grant.subject_type}:${grant.subject_id}`,
          icon: grant.subject_type === "group" ? Users : User,
          label:
            (grant.subject_type === "group"
              ? groups.data?.items.find((group) => group.id === grant.subject_id)?.name
              : actorDirectoryName(directory, grant.subject_type, grant.subject_id)) ??
            t("runs.caller.unknown"),
        })),
      ]
    : [];
  return (
    <Section label={t("invocation.startAccess")} testId="workflow-start-access">
      {!access.visibility.rules || !access.rules ? (
        <p className={line}>{t("invocation.startRulesHidden")}</p>
      ) : chips.length === 0 ? (
        <p className={line}>{t("invocation.startNoRules")}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" data-testid="workflow-start-access-chips">
          {chips.map((chip) => (
            <li
              key={chip.key}
              className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm [&_svg]:size-3.5"
            >
              <chip.icon aria-hidden="true" className="text-muted-foreground" />
              {chip.label}
            </li>
          ))}
        </ul>
      )}
      <p
        className={cn(
          "flex items-center gap-1.5 text-sm [&_svg]:size-4",
          access.caller.allowed
            ? "text-emerald-700 dark:text-emerald-400"
            : "text-muted-foreground",
        )}
        data-testid="workflow-start-access-caller"
      >
        {access.caller.allowed ? (
          <CircleCheck aria-hidden="true" />
        ) : (
          <CircleSlash aria-hidden="true" />
        )}
        {t(access.caller.allowed ? "workflowUse.youMayStart" : "workflowUse.youMayNotStart")}
      </p>
      <p className={line}>{t("invocation.startExternal")}</p>
    </Section>
  );
}

function ChannelSheet({
  mode,
  invocation,
  workflowId,
  workflowName,
  canWrite,
  canChat,
  approvedEnvironment,
  onClose,
}: {
  mode: InvocationMode;
  invocation: Invocation;
  workflowId: string;
  workflowName: string;
  canWrite: boolean;
  canChat: boolean;
  approvedEnvironment: Environment | null;
  onClose(): void;
}) {
  const { t } = useI18n();
  const schedules = invocation.schedules ?? [];
  return (
    <RecordSheet
      dock
      open
      onOpenChange={(next) => !next && onClose()}
      title={t(CHANNEL_TITLES[mode])}
      subtitle={t(CHANNEL_SHEET_LINES[mode])}
      testId={`workflow-invocation-sheet-${mode}`}
      closeTestId="workflow-invocation-sheet-close"
    >
      {mode === "http" ? (
        <HttpMode invocation={invocation} approvedEnvironment={approvedEnvironment} />
      ) : mode === "webhook" ? (
        <WebhookMode invocation={invocation} />
      ) : mode === "mcp" ? (
        <McpMode invocation={invocation} />
      ) : mode === "schedule" ? (
        <div className="flex flex-col gap-4">
          <WorkflowScheduleSection
            workflowId={workflowId}
            workflowName={workflowName}
            nextFireAt={schedules[0]?.next_fire_at ?? null}
            canWrite={canWrite}
            canChat={canChat}
          />
          {schedules.some((entry) => hasFixedInput(entry.input)) ? (
            <TechnicalDetails testId="workflow-invocation-schedule-technical">
              {schedules.map((entry, index) =>
                hasFixedInput(entry.input) ? (
                  <Copyable key={scheduleRowKey(entry, index)}>
                    <CodeBlock
                      label={t("invocation.schedule.input")}
                      code={JSON.stringify(entry.input, null, 2)}
                      lang="json"
                      testId={`workflow-invocation-schedule-${index}-input`}
                    />
                  </Copyable>
                ) : null,
              )}
            </TechnicalDetails>
          ) : null}
        </div>
      ) : (
        <CliMode invocation={invocation} />
      )}
    </RecordSheet>
  );
}

export function WorkflowInvocation({
  workflowId,
  workflowName,
  approvedEnvironment,
  canWrite,
  canChat,
}: {
  workflowId: string;
  workflowName: string;
  canWrite: boolean;
  canChat: boolean;
  approvedEnvironment: Environment | null;
}) {
  const { t, locale } = useI18n();
  const query = useWorkflowInvocation(workflowId);
  const [open, setOpen] = useState<InvocationMode | null>(null);
  const invocation = query.data;
  if (query.isPending) return <DataState state="loading" />;
  if (query.error || !invocation)
    return (
      <DataState
        state="error"
        line={t("invocation.loadFailed")}
        onRetry={() => void query.refetch()}
        testId="workflow-invocation-failed"
      />
    );
  const modes = invocationModes(invocation);
  const hiddenKey = hiddenInvocationKey(hiddenInvocationLists(invocation));
  const schedule = invocation.schedules?.[0] ?? null;
  const hooks = invocation.hooks ?? [];
  const channel = (mode: InvocationMode): { line: string; on: boolean } => {
    switch (mode) {
      case "schedule":
        return schedule
          ? {
              line: cronWords(schedule.cron, t, LOCALE_TAGS[locale]),
              on: schedule.state === "active",
            }
          : { line: t("workflowUse.card.noSchedule"), on: false };
      case "webhook":
        return hooks.length > 0
          ? {
              line: t("workflowUse.card.webhook"),
              on: hooks.some((hook) => hook.state === "active"),
            }
          : { line: t("workflowUse.card.noWebhook"), on: false };
      case "http":
        return { line: t("workflowUse.card.http"), on: true };
      case "mcp":
        return { line: t("workflowUse.card.mcp"), on: true };
      default:
        return { line: t("workflowUse.card.cli"), on: true };
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="workflow-invocation">
      <ul
        className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
        data-testid="workflow-invocation-modes"
      >
        {modes.map((mode) => {
          const Icon = CHANNEL_ICONS[mode];
          const card = channel(mode);
          return (
            <li key={mode} className="flex">
              <button
                type="button"
                onClick={() => setOpen(mode)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  !card.on && "opacity-70",
                )}
                data-testid={`workflow-invocation-tab-${mode}`}
              >
                <IconTile
                  className={
                    card.on
                      ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                      : "text-muted-foreground"
                  }
                >
                  <Icon />
                </IconTile>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{t(CHANNEL_TITLES[mode])}</span>
                  <span className="block text-xs text-muted-foreground">{card.line}</span>
                </span>
                <StatusBadge
                  state={card.on ? "active" : "inactive"}
                  label={t(card.on ? "workflowUse.on" : "workflowUse.off")}
                />
              </button>
            </li>
          );
        })}
      </ul>
      {invocation.start_access ? <StartAccess access={invocation.start_access} /> : null}
      {hiddenKey ? (
        <p className={line} data-testid="workflow-invocation-hidden">
          {t(hiddenKey)}
        </p>
      ) : null}
      {open ? (
        <ChannelSheet
          mode={open}
          invocation={invocation}
          workflowId={workflowId}
          workflowName={workflowName}
          canWrite={canWrite}
          canChat={canChat}
          approvedEnvironment={approvedEnvironment}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
