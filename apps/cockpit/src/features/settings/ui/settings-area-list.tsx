import type { ReactNode } from "react";
import { absolute, apiAccessHref, peopleHref, settingsHref } from "@/app/links";
import { StatusBadge } from "@/components/cockpit/patterns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { connectedChatPlatforms, type EngineAreaId, ownObjectStore } from "../model/settings-areas";
import {
  ExpertLink,
  type GuidedContext,
  GuidedRows,
  guidedItem,
  Question,
} from "./settings-guided";

interface AreaQuestion {
  title: TranslationKey;
  help?: TranslationKey;
  line?: TranslationKey;
  paths: readonly string[];
  testId: string;
}

const AREA_QUESTIONS: Readonly<Partial<Record<EngineAreaId, readonly AreaQuestion[]>>> = {
  access: [
    {
      title: "settings.question.access.signIn",
      help: "settings.question.access.signInHelp",
      paths: ["auth.providers", "auth.enable_signup"],
      testId: "sign-in",
    },
    {
      title: "settings.question.access.products",
      help: "settings.question.access.productsHelp",
      paths: ["products"],
      testId: "products",
    },
    {
      title: "settings.question.access.assistants",
      help: "settings.question.access.assistantsHelp",
      paths: ["auth.mcp_oauth.enabled", "mcp.read_only"],
      testId: "assistants",
    },
    {
      title: "settings.question.access.egress",
      help: "settings.question.access.egressHelp",
      paths: ["egress.mode", "spec.allow_private_fetch"],
      testId: "egress",
    },
  ],
  connections: [
    {
      title: "settings.question.connections.connectors",
      help: "settings.question.connections.connectorsHelp",
      paths: [
        "connectors.http.max_response_bytes",
        "connectors.web_scraper.runtime.respect_robots",
        "connectors.mcp.remote_tool_call_timeout_ms",
      ],
      testId: "connectors",
    },
  ],
  notifications: [
    {
      title: "settings.question.notifications.push",
      paths: ["notifications.push.enabled"],
      testId: "push",
    },
    {
      title: "settings.question.notifications.threshold",
      paths: ["notifications.push.thresholdSec"],
      testId: "threshold",
    },
    {
      title: "settings.question.notifications.retention",
      paths: ["notifications.inbox.retention_days"],
      testId: "retention",
    },
  ],
  operations: [
    {
      title: "settings.question.operations.deployment",
      line: "settings.question.operations.deploymentLine",
      paths: ["deployment.mode"],
      testId: "deployment",
    },
  ],
};

const AREA_EXPERT_SECTION: Readonly<Record<EngineAreaId, string>> = {
  ai: "llm",
  access: "auth",
  connections: "connectors",
  notifications: "notifications",
  operations: "deployment",
};

function areaExpertHref(area: EngineAreaId): string {
  return settingsHref(null, { section: AREA_EXPERT_SECTION[area] });
}

function ChatPlatforms({ ctx }: { ctx: GuidedContext }) {
  const { t } = useI18n();
  const platforms = connectedChatPlatforms(ctx.items).filter((platform) =>
    guidedItem(ctx, platform.secret),
  );
  if (platforms.length === 0) return null;
  return (
    <Question title={t("settings.question.connections.chat")} testId="settings-question-chat">
      <ul className="grid gap-2 sm:grid-cols-3">
        {platforms.map((platform) => (
          <li
            key={platform.id}
            className="grid gap-1 rounded-xl border p-3"
            data-testid={`settings-chat-${platform.id}`}
          >
            <span className="text-sm font-medium">{platform.name}</span>
            <span className="text-xs text-muted-foreground">
              {t("settings.question.connections.chatLine", { platform: platform.name })}
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <StatusBadge
                state={platform.connected ? "ok" : "neutral"}
                label={t(
                  platform.connected
                    ? "settings.question.connections.connected"
                    : "settings.question.connections.notSetUp",
                )}
              />
              {platform.connected ? null : (
                <ExpertLink
                  href={settingsHref(null, { section: "platform" })}
                  label={t("settings.question.connections.setUp")}
                  onNavigate={ctx.navigate}
                  className="text-xs"
                  testId={`settings-chat-${platform.id}-setup`}
                />
              )}
            </span>
          </li>
        ))}
      </ul>
    </Question>
  );
}

function StorageQuestion({ ctx }: { ctx: GuidedContext }) {
  const { t } = useI18n();
  if (!guidedItem(ctx, "storage.object_store.bucket")) return null;
  const own = ownObjectStore(ctx.items);
  return (
    <Question
      title={t("settings.question.connections.storage")}
      help={t("settings.question.connections.storageHelp")}
      testId="settings-question-storage"
    >
      <p className="text-sm" data-testid="settings-storage-state">
        {t(
          own
            ? "settings.question.connections.storageOwn"
            : "settings.question.connections.storageSubkit",
        )}
      </p>
      <ExpertLink
        href={settingsHref(null, { section: "storage" })}
        label={t("settings.level.areaExpert")}
        onNavigate={ctx.navigate}
        className="text-xs"
        testId="settings-storage-expert"
      />
    </Question>
  );
}

export function AreaList({
  area,
  ctx,
  before,
  after,
}: {
  area: EngineAreaId;
  ctx: GuidedContext;
  before?: ReactNode;
  after?: ReactNode;
}) {
  const { t } = useI18n();
  const questions = (AREA_QUESTIONS[area] ?? []).filter((question) =>
    question.paths.some((path) => guidedItem(ctx, path)),
  );
  return (
    <div className="grid gap-5" data-testid={`settings-area-${area}`}>
      {before}
      {questions.map((question) => (
        <Question
          key={question.testId}
          title={t(question.title)}
          help={question.help ? t(question.help) : question.line ? t(question.line) : undefined}
          testId={`settings-question-${question.testId}`}
        >
          <GuidedRows ctx={ctx} paths={question.paths} />
        </Question>
      ))}
      {area === "connections" ? (
        <>
          <ChatPlatforms ctx={ctx} />
          <StorageQuestion ctx={ctx} />
        </>
      ) : null}
      {area === "access" ? (
        <div className="grid gap-1 text-sm">
          <a
            href={absolute(peopleHref())}
            className="font-medium underline-offset-2 hover:underline"
            data-testid="settings-access-people"
          >
            {t("settings.question.access.people")} →
          </a>
          <a
            href={absolute(apiAccessHref())}
            className="font-medium underline-offset-2 hover:underline"
            data-testid="settings-access-api"
          >
            {t("settings.question.access.api")} →
          </a>
        </div>
      ) : null}
      {after}
      {area === "operations" ? null : (
        <div className="border-t pt-4">
          <ExpertLink
            href={areaExpertHref(area)}
            label={t("settings.level.areaExpert")}
            onNavigate={ctx.navigate}
            testId={`settings-area-${area}-expert`}
          />
        </div>
      )}
    </div>
  );
}
