import type { components } from "@/api/schema";
import { type ActorDirectory, actorDirectoryName } from "@/app/actor-directory-model";
import { previewKind } from "@/components/cockpit/patterns/file-kinds";
import type { TranslationKey } from "@/lib/i18n";

export type FileVersion = components["schemas"]["FileVersion"];
type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

const KIND_KEYS = {
  image: "files.kind.image",
  pdf: "files.kind.pdf",
  csv: "files.kind.csv",
  markdown: "files.kind.markdown",
  text: "files.kind.text",
  other: "files.kind.other",
} as const;

export function fileKindKey(filename: string, contentType: string | null | undefined) {
  return KIND_KEYS[previewKind(filename, contentType)];
}

export function fileVersionWhat(version: FileVersion, t: Translate): string {
  if (version.restored_from !== null)
    return t("files.versions.restoredFrom", { version: version.restored_from });
  return version.version === 1 ? t("files.versions.first") : t("files.versions.uploaded");
}

export function fileVersionTitle(version: FileVersion, t: Translate): string {
  return `v${version.version} · ${fileVersionWhat(version, t)}`;
}

export function fileVersionUploader(
  version: FileVersion,
  directory: ActorDirectory,
  t: Translate,
): string {
  const actor = version.uploaded_by;
  if (!actor) return t("runs.caller.unknown");
  return (
    actorDirectoryName(directory, actor.kind, actor.id) ??
    t(actor.kind === "user" ? "audit.actor.user" : "audit.actor.systemAccount")
  );
}

export function fileVersionContentPath(fileId: string, version: number): string {
  return `/v1/files/${encodeURIComponent(fileId)}/versions/${version}/content`;
}

export function hasEarlierVersions(versions: readonly FileVersion[] | undefined): boolean {
  return (versions ?? []).some((version) => !version.current);
}

export interface FileUsageCounts {
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

export function fileUsageLine(t: Translate, usage: FileUsageCounts | undefined): string | null {
  const uses = fileUsageParts(t, usage);
  return uses ? t("files.usage.line", { uses }) : null;
}
