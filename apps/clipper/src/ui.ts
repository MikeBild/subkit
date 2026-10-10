import type { CaptureDiagnostic } from "./types.ts";

export interface Copy {
  title: string;
  heading: string;
  setup: string;
  category: string;
  newCategory: string;
  categoryName: string;
  save: string;
  retry: string;
  settings: string;
  saved: string;
  duplicate: string;
  replace: string;
  copy: string;
  content: string;
  titleField: string;
  sourceField: string;
  error: string;
  connection: string;
  engine: string;
  key: string;
  saveConnection: string;
  clearKey: string;
  author: string;
  publishedAt: string;
  discard: string;
  newCapture: string;
  captureFailed: string;
  draftOtherEngine: string;
  needsSettings: string;
  categoryRequired: string;
  needsClipApi: string;
  intakeUnavailable: string;
  categoryUnavailable: string;
  categoriesUnavailable: string;
  categoriesLoading: string;
  destinationUnavailable: string;
  checkConnection: string;
  emptyPreview: string;
  attemptUncertain: string;
  permissionDenied: string;
  invalidEngine: string;
  keyRequired: string;
  savedConnection: string;
  keyCleared: string;
  retryAttempt: string;
  previousSaved: string;
  capturedFrom: string;
  drafts: string;
  currentPage: string;
  otherDraft: string;
  contentPreview: string;
  contentSize: string;
  description: string;
  transcript: string;
  transcriptUnavailable: string;
  contentChanged: string;
  mainContentUnavailable: string;
  metadataUnavailable: string;
  articleFallback: string;
  selectionEmpty: string;
  words: string;
  characters: string;
  reopenCapture: string;
  note: string;
  details: string;
  review: string;
  reviewPrompt: string;
  reviewItemPrompt: string;
  journey: string;
  notKnowledge: string;
  savedForReview: string;
  retryPending: string;
}

export const copy: Record<"de" | "en", Copy> = {
  de: {
    title: "In SubKit sammeln",
    note: "Warum ist das interessant? (optional)",
    details: "Details und Inhalt bearbeiten",
    review: "Im Chat prüfen",
    reviewPrompt:
      "Schau meine neuen {collection}-Einträge durch. Welche davon helfen uns? Schlage mit Quellenbezug vor, was wir als Wissen übernehmen sollten.",
    reviewItemPrompt:
      "Prüfe diesen gesammelten Eintrag. Bewerte seinen Nutzen und bereite einen Vorschlag mit Quelle und Wissensziel zur Bestätigung vor.",
    journey: "Sammeln → im Chat prüfen → Übernahme bestätigen → Wissen",
    notKnowledge: "Noch nicht als Wissen übernommen.",
    savedForReview: "Gesammelt für die Prüfung",
    retryPending:
      "Die Speicherung ist noch nicht bestätigt. Versuche es erneut; dein Entwurf bleibt erhalten.",
    heading: "Für später sammeln",
    setup: "Verbindung einrichten",
    category: "Kategorie",
    newCategory: "Neue Kategorie",
    categoryName: "Neue Kategorie",
    save: "Sammeln",
    retry: "Erneut versuchen",
    settings: "Einstellungen",
    saved: "Gesammelt",
    duplicate: "Dieser Clip existiert bereits.",
    replace: "Ersetzen",
    copy: "Als Kopie sichern",
    content: "Markdown",
    titleField: "Titel",
    sourceField: "Quelladresse",
    error: "Der Entwurf bleibt lokal erhalten.",
    connection: "Verbindung",
    engine: "Engine-Adresse",
    key: "API-Schlüssel",
    saveConnection: "Verbindung speichern",
    clearKey: "API-Schlüssel löschen",
    author: "Autor der Quelle",
    publishedAt: "Veröffentlicht am",
    discard: "Entwurf verwerfen",
    newCapture: "Neu erfassen",
    captureFailed: "Die Seite konnte nicht erfasst werden.",
    draftOtherEngine: "Dieser Entwurf gehört zu einer anderen Engine.",
    needsSettings: "Lege zuerst eine Engine-Adresse und einen API-Schlüssel fest.",
    categoryRequired: "Gib eine gültige Kategorie ein.",
    needsClipApi: "Sammeln ist hier noch nicht verfügbar.",
    intakeUnavailable: "Sammeln ist gerade nicht verfügbar. Dein Entwurf bleibt gespeichert.",
    categoryUnavailable:
      "Die gespeicherte Kategorie ist nicht verfügbar. Wähle eine andere Kategorie.",
    categoriesUnavailable: "Kategorien gerade nicht verfügbar",
    categoriesLoading: "Kategorien werden geladen.",
    destinationUnavailable: "Wähle eine gültige Kategorie, bevor du sammelst.",
    checkConnection: "Verbindung prüfen",
    emptyPreview: "Markiere den gewünschten Text auf der Seite und erfasse ihn erneut.",
    attemptUncertain:
      "Der vorige Speicherversuch ist unklar. Prüfe den Entwurf und starte einen neuen Versuch.",
    permissionDenied: "Erlaube den Zugriff auf diese Engine, um die Verbindung zu speichern.",
    invalidEngine: "Nutze HTTPS oder HTTP auf localhost.",
    keyRequired: "Gib einen API-Schlüssel für die neue Engine ein.",
    savedConnection: "Gespeichert",
    keyCleared: "API-Schlüssel gelöscht",
    retryAttempt: "Neuen Speicherversuch starten",
    previousSaved: "Der vorige Inhalt wurde gespeichert. Deine Änderungen sind noch ein Entwurf.",
    capturedFrom: "Erfasst von",
    drafts: "Entwürfe",
    currentPage: "Aktuelle Seite",
    otherDraft: "Anderer Entwurf",
    contentPreview: "Vorschau",
    contentSize: "Umfang",
    description: "Beschreibung",
    transcript: "Transkript",
    transcriptUnavailable: "Kein Transkript verfügbar.",
    contentChanged:
      "Der Markdown-Text wurde bearbeitet. Passe die Abschnitte erst nach dem Neu-Erfassen an.",
    mainContentUnavailable:
      "Der Hauptinhalt konnte nicht zuverlässig erfasst werden. Markiere den relevanten Text auf der Seite und wähle dann Neu erfassen.",
    metadataUnavailable:
      "Einige Seiteninformationen konnten nicht gelesen werden. Prüfe Titel und Quelle.",
    articleFallback:
      "Der Inhalt wurde vereinfacht als Text erfasst. Prüfe die Vorschau auf Vollständigkeit.",
    selectionEmpty:
      "Die Auswahl ist nicht mehr verfügbar. Markiere den Text erneut und erfasse ihn noch einmal.",
    words: "Wörter",
    characters: "Zeichen",
    reopenCapture: "Öffne den Clipper über die Symbolleiste auf dieser Seite erneut.",
  },
  en: {
    title: "Collect in SubKit",
    note: "Why is this interesting? (optional)",
    details: "Details and edit content",
    review: "Review in chat",
    reviewPrompt:
      "Review my new {collection} entries. Which ones help us? Propose what we should retain as knowledge, with its sources.",
    reviewItemPrompt:
      "Review this collected item. Assess its usefulness and prepare a proposal with its source and knowledge target for confirmation.",
    journey: "Collect → review in chat → confirm admission → knowledge",
    notKnowledge: "Not yet admitted as knowledge.",
    savedForReview: "Collected for review",
    retryPending: "Saving is not confirmed yet. Retry; your draft remains available.",
    heading: "Collect for later",
    setup: "Set up connection",
    category: "Category",
    newCategory: "New category",
    categoryName: "New category",
    save: "Collect",
    retry: "Try again",
    settings: "Settings",
    saved: "Collected",
    duplicate: "This clip already exists.",
    replace: "Replace",
    copy: "Save a copy",
    content: "Markdown",
    titleField: "Title",
    sourceField: "Source address",
    error: "The draft remains on this device.",
    connection: "Connection",
    engine: "Engine address",
    key: "API key",
    saveConnection: "Save connection",
    clearKey: "Clear API key",
    author: "Source author",
    publishedAt: "Published at",
    discard: "Discard draft",
    newCapture: "Capture again",
    captureFailed: "The page could not be captured.",
    draftOtherEngine: "This draft belongs to a different engine.",
    needsSettings: "Set an engine address and API key first.",
    categoryRequired: "Enter a valid category.",
    needsClipApi: "Collecting is not available here.",
    intakeUnavailable: "Collecting is currently unavailable. Your draft remains saved.",
    categoryUnavailable: "The saved category is unavailable. Choose another category.",
    categoriesUnavailable: "Categories currently unavailable",
    categoriesLoading: "Loading categories.",
    destinationUnavailable: "Choose a valid category before collecting.",
    checkConnection: "Check connection",
    emptyPreview: "Select the text you want on the page and capture it again.",
    attemptUncertain:
      "The previous save may be incomplete. Review the draft and start a new save attempt.",
    permissionDenied: "Allow access to this engine to save the connection.",
    invalidEngine: "Use an HTTPS address or HTTP on localhost.",
    keyRequired: "Enter an API key for the new engine.",
    savedConnection: "Saved",
    keyCleared: "API key cleared",
    retryAttempt: "Start a new save attempt",
    previousSaved: "The previous content was saved. Your changes remain a draft.",
    capturedFrom: "Captured from",
    drafts: "Drafts",
    currentPage: "Current page",
    otherDraft: "Another draft",
    contentPreview: "Preview",
    contentSize: "Size",
    description: "Description",
    transcript: "Transcript",
    transcriptUnavailable: "No transcript is available.",
    contentChanged: "The Markdown was edited. Capture again before changing included sections.",
    mainContentUnavailable:
      "The main content could not be captured reliably. Select the relevant text on the page, then choose Capture again.",
    metadataUnavailable: "Some page information could not be read. Check the title and source.",
    articleFallback:
      "The content was captured as simplified text. Check the preview for completeness.",
    selectionEmpty: "The selection is no longer available. Select the text and capture it again.",
    words: "words",
    characters: "characters",
    reopenCapture: "Open the clipper from the toolbar on this page again.",
  },
} as const;

export type Language = keyof typeof copy;

export function language(value?: string): Language {
  return value === "de" || (!value && navigator.language.toLowerCase().startsWith("de"))
    ? "de"
    : "en";
}

export function applyText(values: Copy): void {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n as keyof Copy | undefined;
    if (key) element.textContent = values[key];
  });
}

export function intakeReviewPrompt(values: Copy, collection: string): string {
  return values.reviewPrompt.replace("{collection}", collection);
}

export function intakeItemReviewPrompt(values: Copy): string {
  return values.reviewItemPrompt;
}

export function intakeItemReviewParams(values: Copy, itemId: string): Record<string, string> {
  return {
    intake_item_ids: itemId,
    references: `intake_item:${itemId}`,
    prompt: intakeItemReviewPrompt(values),
  };
}

export function contentSummary(value: string): { characters: number; words: number } {
  return {
    characters: value.length,
    words: value.trim() ? value.trim().split(/\s+/).length : 0,
  };
}

export function previewText(value: string): string {
  return value
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}

export interface PreviewBlock {
  kind: "heading" | "list" | "paragraph";
  text: string;
}

function previewInline(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}

export function previewBlocks(value: string): PreviewBlock[] {
  const blocks: PreviewBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    const text = previewInline(paragraph.join(" "));
    if (text) blocks.push({ kind: "paragraph", text });
    paragraph = [];
  };
  for (const line of value.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const list = line.match(/^\s*[-*+]\s+(.+)$/);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", text: previewInline(heading[1]!) });
    } else if (list) {
      flush();
      blocks.push({ kind: "list", text: previewInline(list[1]!) });
    } else if (!line.trim()) {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

export function isCapturablePageUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function isSourceWindow(sourceWindowId: number | undefined, windowId: number): boolean {
  return sourceWindowId === undefined || sourceWindowId === windowId;
}

export interface CapturedSections {
  description?: string;
  transcript?: string;
}

export interface GeneratedSectionSelection {
  description: boolean;
  transcript: boolean;
}

function composedSections(
  sections: CapturedSections,
  selection: GeneratedSectionSelection,
  headings: { description: string; transcript: string },
): string {
  const parts: string[] = [];
  if (selection.description && sections.description) {
    parts.push(`## ${headings.description}\n\n${sections.description}`);
  }
  if (selection.transcript && sections.transcript) {
    parts.push(`## ${headings.transcript}\n\n${sections.transcript}`);
  }
  return parts.join("\n\n");
}

export function generatedSectionSelection(
  body: string,
  sections: CapturedSections,
): GeneratedSectionSelection | undefined {
  const choices: GeneratedSectionSelection[] = [
    { description: Boolean(sections.description), transcript: Boolean(sections.transcript) },
    { description: Boolean(sections.description), transcript: false },
    { description: false, transcript: Boolean(sections.transcript) },
    { description: false, transcript: false },
  ];
  const headings = [
    { description: copy.de.description, transcript: copy.de.transcript },
    { description: copy.en.description, transcript: copy.en.transcript },
  ];
  return choices.find((selection) =>
    headings.some((labels) => composedSections(sections, selection, labels) === body),
  );
}

export function captureDiagnosticMessages(
  diagnostics: CaptureDiagnostic[] | undefined,
  text: Copy,
): string[] {
  const messages: Record<CaptureDiagnostic["code"], string> = {
    metadata_unavailable: text.metadataUnavailable,
    article_fallback: text.articleFallback,
    main_content_unavailable: text.mainContentUnavailable,
    selection_unavailable: text.selectionEmpty,
    youtube_transcript_unavailable: text.transcriptUnavailable,
    youtube_transcript_failed: text.transcriptUnavailable,
  };
  return [
    ...new Set((diagnostics || []).map((diagnostic) => messages[diagnostic.code]).filter(Boolean)),
  ];
}
