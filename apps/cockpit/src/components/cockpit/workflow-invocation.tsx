import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { apiRequest } from "@/api/client";
import {
  CodeBlock,
  ContextHelp,
  CopyField,
  DataState,
  SegmentedControl,
  StatusBadge,
} from "@/components/cockpit/patterns";
import { WorkflowScheduleSection } from "@/components/cockpit/workflow-schedule";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  callVerdict,
  HOOK_STATE_KEYS,
  hasFixedInput,
  hiddenInvocationKey,
  hiddenInvocationLists,
  INVOCATION_MODES,
  type WorkflowInvocation as Invocation,
  type InvocationHook,
  type InvocationMode,
  initialInvocationMode,
  invocationModes,
  isWorkflowInvocation,
  SNIPPET_LANGUAGES,
  type SnippetLanguage,
  scheduleRowKey,
  verifierName,
} from "@/lib/workflow-invocation";

type Environment = "dev" | "prod";

const MODE_KEYS: Record<InvocationMode, TranslationKey> = {
  http: "invocation.mode.http",
  webhook: "invocation.mode.webhook",
  mcp: "invocation.mode.mcp",
  schedule: "invocation.mode.schedule",
  cli: "invocation.mode.cli",
};

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

export function useWorkflowInvocation(workflowId: string) {
  return useQuery({
    queryKey: ["workflow-invocation", workflowId],
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
  return (
    <div className="flex flex-col gap-3">
      <Copyable>
        <CopyField
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
          <p className={line} data-testid={`workflow-invocation-hook-${index}-signing`}>
            {signingSentence(hook, t)}
          </p>
        </div>
      ))}
      {invocation.base_url === null ? <p className={line}>{t("invocation.noAddress")}</p> : null}
      <Copyable>
        <CodeBlock
          label={t("invocation.hook.shape")}
          code={JSON.stringify(invocation.webhook_input_shape, null, 2)}
          lang="json"
          testId="workflow-invocation-hook-shape"
        />
      </Copyable>
    </div>
  );
}

function McpMode({ invocation }: { invocation: Invocation }) {
  const { t } = useI18n();
  const { mcp } = invocation;
  return (
    <div className="flex flex-col gap-3">
      {invocation.base_url ? (
        <Copyable>
          <CopyField
            value={`${invocation.base_url.replace(/\/$/, "")}/mcp`}
            label={t("invocation.mcpAddress")}
            testId="workflow-invocation-mcp-url"
          />
        </Copyable>
      ) : null}
      <Copyable>
        <CopyField
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

export function WorkflowInvocation({
  workflowId,
  workflowName,
  effectiveTrigger,
  approvedEnvironment,
  canWrite,
  canChat,
}: {
  workflowId: string;
  workflowName: string;
  canWrite: boolean;
  canChat: boolean;
  effectiveTrigger: string | null;
  approvedEnvironment: Environment | null;
}) {
  const { t } = useI18n();
  const query = useWorkflowInvocation(workflowId);
  const [chosen, setChosen] = useState<InvocationMode | null>(null);
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
  const found = invocationModes(invocation);
  const modes = INVOCATION_MODES.filter(
    (value) => found.includes(value) || (value === "schedule" && canWrite),
  );
  const mode =
    chosen && modes.includes(chosen) ? chosen : initialInvocationMode(modes, effectiveTrigger);
  const hiddenKey = hiddenInvocationKey(hiddenInvocationLists(invocation));
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="workflow-invocation">
      {modes.length > 1 ? (
        <div className="overflow-x-auto">
          <SegmentedControl
            label={t("invocation.title")}
            value={mode}
            onValueChange={(value) => setChosen(value as InvocationMode)}
            testId="workflow-invocation-modes"
            options={modes.map((value) => ({
              value,
              label: t(MODE_KEYS[value]),
              testId: `workflow-invocation-tab-${value}`,
            }))}
          />
        </div>
      ) : null}
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
            nextFireAt={invocation.schedules?.[0]?.next_fire_at ?? null}
            canWrite={canWrite}
            canChat={canChat}
          />
          {(invocation.schedules ?? []).map((schedule, index) =>
            hasFixedInput(schedule.input) ? (
              <Copyable key={scheduleRowKey(schedule, index)}>
                <CodeBlock
                  label={t("invocation.schedule.input")}
                  code={JSON.stringify(schedule.input, null, 2)}
                  lang="json"
                  testId={`workflow-invocation-schedule-${index}-input`}
                />
              </Copyable>
            ) : null,
          )}
        </div>
      ) : (
        <CliMode invocation={invocation} />
      )}
      {hiddenKey ? (
        <p className={line} data-testid="workflow-invocation-hidden">
          {t(hiddenKey)}
        </p>
      ) : null}
    </div>
  );
}
