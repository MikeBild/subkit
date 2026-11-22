import type { ActorDirectory } from "@/app/actor-directory-model";
import type { Translate } from "@/lib/i18n";
import type { FailedRemedy, SourceView } from "./knowledge";
import { authorName, type KnowledgeVersion, versionWhy } from "./knowledge-versions-model";
import { SOURCE_STATUS_KEY } from "./source-list-model";

export type SourceStripAction = "retry" | "chat" | "activate" | null;

export function sourceStripAction(
  status: SourceView["status"],
  remedy: FailedRemedy,
  canWrite: boolean,
): SourceStripAction {
  if (status === "failed" && remedy === "retry") return "retry";
  if (status === "failed" && remedy === "chat") return "chat";
  if (status === "off" && canWrite) return "activate";
  return null;
}

export function sourceStripText(
  v: Pick<SourceView, "status" | "error" | "ingested">,
  t: Translate,
  rel: (iso: string) => string,
): string {
  if (v.status === "active") return t("kn.sources.stripActive", { when: rel(v.ingested) });
  if (v.status === "failed" && v.error) return `${t(SOURCE_STATUS_KEY.failed)} · ${v.error}`;
  return t(SOURCE_STATUS_KEY[v.status]);
}

export function sourceSizeText(sections: string, bytes: string | null): string {
  return [sections, bytes].filter(Boolean).join(" · ");
}

export interface SourceVersionItem {
  key: string;
  v: number;
  by: string;
  at: string;
  current: boolean;
  note: string | null;
}

export function sourceVersionItems(
  history: readonly Pick<
    KnowledgeVersion,
    "version" | "author" | "created_at" | "current" | "note"
  >[],
  directory: ActorDirectory,
  t: Translate,
): SourceVersionItem[] {
  return history.map((h) => ({
    key: String(h.version),
    v: h.version,
    by: authorName(h.author, directory, t),
    at: h.created_at,
    current: h.current,
    note: versionWhy(h.note, directory, t),
  }));
}

export const ENDPOINT_METHOD_CLASS: Readonly<Record<string, string>> = {
  GET: "text-success-ink",
  POST: "text-info-ink",
  PATCH: "text-warning-ink",
  PUT: "text-warning-ink",
  DELETE: "text-destructive-ink",
};
