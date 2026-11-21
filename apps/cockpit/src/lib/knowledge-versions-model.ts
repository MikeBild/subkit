import type { components } from "@cli-core/engine-api/openapi";
import { type ActorDirectory, actorDirectoryName } from "@/app/actor-directory-model";
import type { TranslationKey } from "@/lib/i18n";

export type KnowledgeVersion = components["schemas"]["KnowledgeSourceVersion"];
export type VersionAuthor = KnowledgeVersion["author"];
type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;
type Documents = readonly { path: string; content: string }[];

const RESTORED = /^restored from v(\d+)$/;
const PROPOSED = /^proposed by (user|system_account):(\S+)$/;
const PROPOSED_UNKNOWN = "proposed by an agent";

export function versionText(documents: Documents): string {
  const [only] = documents;
  if (documents.length === 1 && only) return only.content;
  return documents.map((document) => `## ${document.path}\n\n${document.content}`).join("\n\n");
}

export function authorName(author: VersionAuthor, directory: ActorDirectory, t: Translate): string {
  if (!author) return t("runs.caller.unknown");
  return (
    actorDirectoryName(directory, author.kind, author.id) ??
    t(author.kind === "user" ? "audit.actor.user" : "audit.actor.systemAccount")
  );
}

export function versionWhy(
  note: string | null,
  directory: ActorDirectory,
  t: Translate,
): string | null {
  if (!note) return null;
  const restored = RESTORED.exec(note);
  if (restored) return t("knowledge.versions.restoredFrom", { version: Number(restored[1]) });
  if (note === PROPOSED_UNKNOWN) return t("knowledge.versions.proposedInConversation");
  const proposed = PROPOSED.exec(note);
  if (proposed) {
    const kind = proposed[1] === "user" ? "user" : "system_account";
    const name = authorName({ kind, id: proposed[2] ?? "" }, directory, t);
    return t("knowledge.versions.proposedBy", { name });
  }
  return note;
}

export function restoreHint(version: KnowledgeVersion, latest: number, t: Translate): string {
  return version.current
    ? t("knowledge.versions.currentHint")
    : t("knowledge.versions.restoreHint", { next: latest + 1, latest });
}

export function keptVersionCount(listed: number): number {
  return Math.max(listed, 1);
}
