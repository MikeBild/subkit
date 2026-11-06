import type { ConversationDetail, ConversationReference } from "@/api/client";
import { absolute, connectorHref, recordHref, runHref, workflowHref } from "@/app/links";
import { formatRelativeTime } from "@/lib/i18n";
import type { useI18n } from "@/lib/i18n-context";
import type { DiffLine } from "@/lib/line-diff";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { toolLabel, type WorkflowRunKind, workflowRunTitleKey } from "@/lib/tool-presentation";
import type { ChatWorkflowRef } from "@/pages/chat-preview-cards";

type Translate = ReturnType<typeof useI18n>["t"];

export type ConversationUsage = ConversationDetail["usage"];

export const NO_SAVED_PREVIEWS: ReadonlyMap<string, ChatWorkflowRef> = new Map();

export function localizedTarget(value: string | null | undefined, t: Translate): string {
  if (!value || value.toLowerCase() === "none") return t("chat.context.noTarget");
  return hideTechnicalIdentifiers(value, t("tool.referenceHiddenInline"));
}

const CHAT_PLATFORM_LABELS = {
  "chat:slack": "chat.origin.slack",
  "chat:teams": "chat.origin.teams",
  "chat:google_chat": "chat.origin.google_chat",
} as const;

function surfaceLabel(
  t: Translate,
  surface: string | null | undefined,
  client?: string | null,
): string | null {
  if (surface === "chat" && client && client in CHAT_PLATFORM_LABELS)
    return t(CHAT_PLATFORM_LABELS[client as keyof typeof CHAT_PLATFORM_LABELS]);
  switch (surface) {
    case "web":
      return t("chat.origin.web");
    case "sk_interactive":
      return t("chat.origin.sk_interactive");
    case "sk_headless":
      return t("chat.origin.sk_headless");
    case "mcp":
      return t("chat.origin.mcp");
    case "chat":
      return t("chat.origin.chat");
    case "api":
      return t("chat.origin.api");
    default:
      return null;
  }
}

export function originLine(
  t: Translate,
  locale: Parameters<typeof formatRelativeTime>[0],
  input: {
    surface?: string | null;
    client?: string | null;
    owner?: { id: string; name: string } | null;
    viewerId: string | null;
    at?: string | null;
  },
): string {
  const who =
    input.owner && input.owner.id !== input.viewerId && input.owner.name ? input.owner.name : null;
  return [
    surfaceLabel(t, input.surface, input.client),
    who,
    input.at ? formatRelativeTime(locale, input.at) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export const NO_LIVE_REVIEWS: ReadonlySet<string> = new Set();

export function catalogHref(kind: string, id: string): string {
  if (kind === "execution") return absolute(runHref(id));
  if (kind === "skill") return absolute(recordHref("skills", id));
  if (kind === "knowledge_source") return absolute(recordHref("knowledge", id));
  if (kind === "intake_item") return absolute(recordHref("intake", id));
  return absolute(kind === "workflow" ? workflowHref(id) : connectorHref(id));
}

export interface StreamedDiff {
  title: string;
  lines: DiffLine[];
}

const HUNK_TYPE: Record<string, DiffLine["type"]> = {
  "+": "added",
  "-": "removed",
  " ": "context",
};

export function asStreamedDiff(event: {
  type: string;
  [key: string]: unknown;
}): StreamedDiff | null {
  if (event.type !== "diff" || !Array.isArray(event.hunks)) return null;
  const lines: DiffLine[] = [];
  for (const hunk of event.hunks) {
    if (!hunk || typeof hunk !== "object") continue;
    const { kind, text } = hunk as { kind?: unknown; text?: unknown };
    if (typeof text !== "string") continue;
    lines.push({ type: HUNK_TYPE[typeof kind === "string" ? kind : " "] ?? "context", text });
  }
  if (lines.length === 0) return null;
  return { title: typeof event.title === "string" ? event.title : "", lines };
}

export function textFromPart(part: unknown): string | null {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return null;
  const record = part as Record<string, unknown>;
  return typeof record.text === "string" ? record.text : null;
}

export function actionLabel(
  t: Translate,
  toolName: string,
  notRun = false,
  workflowNameFor: (slug: string) => string | null = () => null,
  run: WorkflowRunKind | null = null,
  unfinished = false,
  output?: unknown,
): string {
  const label = toolLabel(toolName, output);
  if (label.kind === "literal") return label.text;
  if (label.kind === "background") return t(label.words.past);
  const runTitle = workflowRunTitleKey(label, notRun, run);
  if (!runTitle && label.kind === "key" && (notRun || unfinished)) return t("tool.action");
  const name = label.kind === "workflow" ? (workflowNameFor(label.slug) ?? label.slug) : "";
  if (runTitle) return t(runTitle, { name });
  return label.kind === "key" ? t(label.key) : name;
}

export function didNotRun(verdict: {
  confirmationState: string | null;
  outcome: string | null;
}): boolean {
  return (
    verdict.outcome === "denied" ||
    verdict.outcome === "expired" ||
    verdict.confirmationState === "declined" ||
    verdict.confirmationState === "auto_declined" ||
    verdict.confirmationState === "expired"
  );
}

export function backgroundLabel(t: Translate, toolName: string, running: boolean): string {
  const label = toolLabel(toolName);
  if (label.kind === "background") return t(running ? label.words.active : label.words.past);
  return actionLabel(t, toolName);
}

export type RestoreComposer = (text: string, references: ConversationReference[]) => void;

export interface AttachmentPreview {
  name: string;
  size?: number;
  contentType?: string | null;
  file?: File;
  fileId?: string;
}
