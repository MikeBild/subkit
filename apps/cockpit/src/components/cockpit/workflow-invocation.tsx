import { useQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { WORKFLOW_AUTOMATION_ANCHOR } from "@/app/links";
import { FencedBlock, type FencedLanguage } from "@/components/cockpit/fenced-block";
import { IconButton } from "@/components/cockpit/icon-button";
import { LoadFailed, queryView } from "@/components/failure-state";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cronWords } from "@/lib/cron-words";
import { LOCALE_TAGS, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  callVerdict,
  HOOK_STATE_KEYS,
  hasFixedInput,
  hiddenInvocationKey,
  hiddenInvocationLists,
  type WorkflowInvocation as Invocation,
  type InvocationHook,
  type InvocationMode,
  type InvocationSchedule,
  initialInvocationMode,
  invocationModes,
  isWorkflowInvocation,
  SCHEDULE_STATE_KEYS,
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

const SNIPPET_HIGHLIGHT: Record<SnippetLanguage, FencedLanguage> = {
  curl: "bash",
  node: "javascript",
  python: "python",
};

const SNIPPET_NAMES: Record<SnippetLanguage, string> = {
  curl: "curl",
  node: "Node.js",
  python: "Python",
};

/** The read behind the block, under the key the automation panel refreshes. */
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

/** An address on one line, whole, with a way to copy it. */
function AddressLine({
  method,
  address,
  testId,
}: {
  method: string;
  address: string;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 items-start gap-2" data-testid={testId}>
      <span className="mt-0.5 rounded-md border px-1.5 font-mono text-xs leading-5">{method}</span>
      <span className="min-w-0 break-all font-mono text-sm leading-6">{address}</span>
      <IconButton
        label={t("invocation.copyAddress")}
        className="shrink-0"
        onClick={() =>
          void navigator.clipboard
            .writeText(address)
            .then(() => toast.success(t("connectorDetail.copied")))
        }
        data-testid={`${testId}-copy`}
      >
        <Copy />
      </IconButton>
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
  // Production by default: it is where a call from an app belongs, and the
  // header in the snippet says so either way.
  const [environment, setEnvironment] = useState<Environment>("prod");
  const [language, setLanguage] = useState<SnippetLanguage>("curl");
  const { http } = invocation;
  const snippet = http.snippets?.[environment][language] ?? null;
  // What the call will be — from the panel's verdict, never from the stored
  // approval alone.
  const verdict = callVerdict(invocation, environment, approvedEnvironment);
  return (
    <div className="grid gap-3">
      <AddressLine
        method={http.method}
        address={http.url ?? http.path}
        testId="workflow-invocation-http-url"
      />
      {http.url === null ? (
        <p className={line} data-testid="workflow-invocation-no-address">
          {t("invocation.noAddress")}
        </p>
      ) : null}
      {snippet ? (
        <FencedBlock
          label={t("invocation.http.snippet")}
          code={snippet}
          language={SNIPPET_HIGHLIGHT[language]}
          testId="workflow-invocation-snippet"
          actions={
            <>
              <Select
                value={environment}
                onValueChange={(value) => setEnvironment(value as Environment)}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={t("run.environment")}
                  data-testid="workflow-invocation-environment"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="prod" data-testid="workflow-invocation-environment-prod">
                      {t("run.environment.prod")}
                    </SelectItem>
                    <SelectItem value="dev" data-testid="workflow-invocation-environment-dev">
                      {t("run.environment.dev")}
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Select
                value={language}
                onValueChange={(value) => setLanguage(value as SnippetLanguage)}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={t("invocation.http.language")}
                  data-testid="workflow-invocation-language"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {SNIPPET_LANGUAGES.map((value) => (
                      <SelectItem
                        key={value}
                        value={value}
                        data-testid={`workflow-invocation-language-${value}`}
                      >
                        {SNIPPET_NAMES[value]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </>
          }
        />
      ) : (
        <FencedBlock
          label={t("invocation.http.body")}
          code={JSON.stringify(http.body, null, 2)}
          language="json"
          testId="workflow-invocation-body"
        />
      )}
      <p className={line} data-testid="workflow-invocation-responses">
        {t("invocation.http.responses")}
      </p>
      {verdict === "live" ? null : (
        <p className={line} data-verdict={verdict} data-testid="workflow-invocation-preview-only">
          {t(
            verdict === "refused"
              ? "invocation.http.refused"
              : verdict === "preview"
                ? "invocation.http.previewOnly"
                : "invocation.http.unconfirmed",
          )}{" "}
          <a
            href={`#${WORKFLOW_AUTOMATION_ANCHOR}`}
            className="text-foreground underline underline-offset-4"
            data-testid="workflow-invocation-to-automation"
          >
            {t(verdict === "refused" ? "invocation.http.toState" : "invocation.http.toAutomation")}
          </a>
        </p>
      )}
    </div>
  );
}

/** How a delivery has to be signed, in one sentence. */
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
    <div className="grid gap-4">
      {hooks.map((hook, index) => (
        <div
          key={hook.slug}
          className="grid gap-2"
          data-testid={`workflow-invocation-hook-${index}`}
        >
          <div className="flex min-w-0 flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <AddressLine
                method="POST"
                address={hook.url ?? hook.path}
                testId={`workflow-invocation-hook-${index}-url`}
              />
            </div>
            <Badge
              variant={hook.state === "active" ? "secondary" : "outline"}
              data-testid={`workflow-invocation-hook-${index}-state`}
            >
              {t(HOOK_STATE_KEYS[hook.state])}
            </Badge>
          </div>
          <p className={line} data-testid={`workflow-invocation-hook-${index}-signing`}>
            {signingSentence(hook, t)}
          </p>
          {hook.state === "held" ? (
            <p className={line}>
              <a
                href={`#${WORKFLOW_AUTOMATION_ANCHOR}`}
                className="text-foreground underline underline-offset-4"
                data-testid={`workflow-invocation-hook-${index}-to-automation`}
              >
                {t("invocation.http.toAutomation")}
              </a>
            </p>
          ) : null}
        </div>
      ))}
      {invocation.base_url === null ? <p className={line}>{t("invocation.noAddress")}</p> : null}
      <FencedBlock
        label={t("invocation.hook.shape")}
        code={JSON.stringify(invocation.webhook_input_shape, null, 2)}
        language="json"
        testId="workflow-invocation-hook-shape"
      />
    </div>
  );
}

function McpMode({ invocation }: { invocation: Invocation }) {
  const { t } = useI18n();
  const { mcp } = invocation;
  return (
    <div className="grid gap-3">
      <FencedBlock
        label={t("invocation.mcp.tool")}
        code={mcp.tool_name}
        testId="workflow-invocation-mcp-tool"
      />
      <FencedBlock
        label={t("invocation.mcp.input")}
        code={JSON.stringify(invocation.input.sample, null, 2)}
        language="json"
        testId="workflow-invocation-mcp-input"
      />
      <p className={line} data-testid="workflow-invocation-mcp-fallback">
        {t("invocation.mcp.fallback", {
          tool: mcp.fallback.tool_name,
          workflow: mcp.fallback.arguments.workflow,
        })}
      </p>
    </div>
  );
}

function ScheduleRow({ schedule, index }: { schedule: InvocationSchedule; index: number }) {
  const { t, locale, dateTime } = useI18n();
  const words = cronWords(schedule.cron, t, LOCALE_TAGS[locale]);
  const facts = [
    t("invocation.schedule.when", { when: words, timezone: schedule.timezone }),
    t(schedule.environment === "prod" ? "run.environment.prod" : "run.environment.dev"),
    schedule.next_fire_at
      ? t("invocation.schedule.next", { when: dateTime(schedule.next_fire_at) })
      : null,
  ].filter(Boolean);
  return (
    <div className="grid gap-2" data-testid={`workflow-invocation-schedule-${index}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm">
          {facts.join(" · ")}
          {/* The expression itself, for the reader who thinks in it — only
              where the words are not already the expression. */}
          {words === schedule.cron ? null : (
            <>
              {" · "}
              <code className="font-mono text-xs">{schedule.cron}</code>
            </>
          )}
        </p>
        <Badge
          variant={schedule.state === "active" ? "secondary" : "outline"}
          data-testid={`workflow-invocation-schedule-${index}-state`}
        >
          {t(SCHEDULE_STATE_KEYS[schedule.state])}
        </Badge>
      </div>
      {hasFixedInput(schedule.input) ? (
        <FencedBlock
          label={t("invocation.schedule.input")}
          code={JSON.stringify(schedule.input, null, 2)}
          language="json"
          testId={`workflow-invocation-schedule-${index}-input`}
        />
      ) : (
        <p className={line}>{t("invocation.schedule.noInput")}</p>
      )}
    </div>
  );
}

function CliMode({ invocation }: { invocation: Invocation }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-3">
      <FencedBlock
        label={t("invocation.cli.command")}
        code={invocation.cli.command}
        language="bash"
        testId="workflow-invocation-cli"
      />
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

/**
 * "Aufrufen": every way this workflow is started, with the exact call — the
 * address, the snippet, the hook and its signature, the tool name, the
 * schedule, the command. The one place on the page a command line stands, and
 * the workflow's identifier only inside the fenced call it belongs to.
 */
export function WorkflowInvocation({
  workflowId,
  effectiveTrigger,
  approvedEnvironment,
}: {
  workflowId: string;
  /** What really starts the workflow — decides the tab a reader lands on. */
  effectiveTrigger: string | null;
  /**
   * The environment the automation panel shows as approved, or null. The
   * engine's answer here only says that an approval is stored; the panel is
   * where it is verified, so the call is said to run live only where the
   * panel says "approved" — the two never contradict each other.
   */
  approvedEnvironment: Environment | null;
}) {
  const { t } = useI18n();
  const query = useWorkflowInvocation(workflowId);
  const [chosen, setChosen] = useState<InvocationMode | null>(null);
  const view = queryView(query, () => false);
  const invocation = query.data;
  const modes = invocation ? invocationModes(invocation) : [];
  const mode =
    chosen && modes.includes(chosen) ? chosen : initialInvocationMode(modes, effectiveTrigger);
  const hiddenKey = invocation ? hiddenInvocationKey(hiddenInvocationLists(invocation)) : null;
  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-xl border p-4"
      data-testid="workflow-invocation"
    >
      <h2 className="text-sm font-semibold">{t("invocation.title")}</h2>
      {view === "loading" ? (
        <Skeleton className="h-32 w-full" />
      ) : view === "error" || !invocation ? (
        <LoadFailed
          title={t("invocation.loadFailed")}
          onRetry={() => void query.refetch()}
          testId="workflow-invocation-failed"
        />
      ) : (
        <Tabs value={mode} onValueChange={(value) => setChosen(value as InvocationMode)}>
          <TabsList className="max-w-full flex-wrap">
            {modes.map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                data-testid={`workflow-invocation-tab-${value}`}
              >
                {t(MODE_KEYS[value])}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="http" className="pt-2">
            <HttpMode invocation={invocation} approvedEnvironment={approvedEnvironment} />
          </TabsContent>
          <TabsContent value="webhook" className="pt-2">
            <WebhookMode invocation={invocation} />
          </TabsContent>
          <TabsContent value="mcp" className="pt-2">
            <McpMode invocation={invocation} />
          </TabsContent>
          <TabsContent value="schedule" className="grid gap-4 pt-2">
            {(invocation.schedules ?? []).map((schedule, index) => (
              <ScheduleRow
                key={scheduleRowKey(schedule, index)}
                schedule={schedule}
                index={index}
              />
            ))}
          </TabsContent>
          <TabsContent value="cli" className="pt-2">
            <CliMode invocation={invocation} />
          </TabsContent>
          {/* A list the reader may not see is not an empty one: without this
              line a missing tab read as "this workflow has no webhook". */}
          {hiddenKey ? (
            <p className={`${line} pt-3`} data-testid="workflow-invocation-hidden">
              {t(hiddenKey)}
            </p>
          ) : null}
        </Tabs>
      )}
    </section>
  );
}
