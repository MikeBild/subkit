import type { components } from "@cli-core/engine-api/openapi";
import { connectorHref, recordHref, runHref } from "@/app/links";
import type { TranslationKey } from "@/lib/i18n";

export type FileVersion = components["schemas"]["FileVersion"];
type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

interface FileUsageCounts {
  workflows: number;
  conversations: number;
  other?: number;
}

export function fileUsageParts(t: Translate, usage: FileUsageCounts | undefined): string | null {
  if (!usage) return null;
  const other = usage.other ?? 0;
  const parts = [
    usage.workflows > 0
      ? usage.workflows === 1
        ? t("files.usage.workflow")
        : t("files.usage.workflows", { count: usage.workflows })
      : null,
    usage.conversations > 0
      ? usage.conversations === 1
        ? t("files.usage.conversation")
        : t("files.usage.conversations", { count: usage.conversations })
      : null,
    other > 0
      ? other === 1
        ? t("files.usage.otherOne")
        : t("files.usage.otherMany", { count: other })
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

type FileOtherLink = components["schemas"]["FileUsage"]["other_links"][number];

const OTHER_LINK_LINES: Record<FileOtherLink["resource_type"], TranslationKey> = {
  conversation: "files.usage.conversationLine",
  knowledge_source: "files.usage.knowledgeLine",
  skill: "files.usage.skillLine",
  connector: "files.usage.connectorLine",
  workflow_run: "files.usage.runLine",
  discovery_run: "files.usage.discoveryLine",
};

export function fileOtherLinkCard(
  link: FileOtherLink,
  t: Translate,
): { id: string; title: string; line: string; href: string | undefined } {
  const href =
    link.name === null
      ? undefined
      : link.resource_type === "knowledge_source"
        ? recordHref("knowledge", link.id)
        : link.resource_type === "skill"
          ? recordHref("skills", link.id)
          : link.resource_type === "connector"
            ? connectorHref(link.id)
            : link.resource_type === "workflow_run"
              ? runHref(link.id)
              : undefined;
  return {
    id: `${link.resource_type}-${link.id}`,
    title: link.name ?? t("files.usage.missingRecord"),
    line: t(OTHER_LINK_LINES[link.resource_type]),
    href,
  };
}
